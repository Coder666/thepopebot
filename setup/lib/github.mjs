import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { ghEnv } from './prerequisites.mjs';

const execAsync = promisify(exec);

const isGiteaBackend = () => process.env.GH_WRAPPER_BACKEND === 'gitea';
const giteaUrl = () => (process.env.GITEA_URL || '').replace(/\/$/, '');
const giteaToken = () => process.env.GITEA_TOKEN || '';

// ─── Private helpers ───────────────────────────────────────────────────────

/** Gitea REST API call — returns { ok, status, data }. */
async function giteaAPI(method, endpoint, body) {
  const url = `${giteaUrl()}/api/v1/${endpoint.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `token ${giteaToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Invoke the gh CLI (GitHub backend only).
 * Centralises env, encoding, and error handling so call-sites are one-liners.
 * Returns { success, error? } for write commands.
 */
function ghCLI(subcommand, input = undefined) {
  try {
    execSync(`gh ${subcommand}`, {
      input,
      encoding: 'utf-8',
      env: ghEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Async variant of ghCLI for read commands that return stdout.
 * Returns { success, stdout }.
 */
async function ghCLIRead(subcommand) {
  try {
    const { stdout } = await execAsync(`gh ${subcommand}`, { encoding: 'utf-8', env: ghEnv() });
    return { success: true, stdout };
  } catch {
    return { success: false, stdout: '' };
  }
}

/**
 * Validate a token by making a test API call.
 * Works for both GitHub (PAT) and Gitea (access token) depending on GH_WRAPPER_BACKEND.
 */
export async function validatePAT(token) {
  try {
    if (isGiteaBackend()) {
      const base = giteaUrl();
      if (!base) return { valid: false, error: 'GITEA_URL is not set' };
      const response = await fetch(`${base}/api/v1/user`, {
        headers: { Authorization: `token ${token}` },
      });
      if (!response.ok) return { valid: false, error: 'Invalid token' };
      const user = await response.json();
      return { valid: true, user: user.login };
    }
    // GitHub default
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (!response.ok) return { valid: false, error: 'Invalid token' };
    const user = await response.json();
    return { valid: true, user: user.login };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Check token scopes/permissions.
 * For Gitea, tokens have full access by default; returns hasRepo/hasWorkflow=true.
 */
export async function checkPATScopes(token) {
  try {
    if (isGiteaBackend()) {
      // Gitea tokens don't expose OAuth scopes; assume full access if the token is valid
      const base = giteaUrl();
      const response = await fetch(`${base}/api/v1/user`, {
        headers: { Authorization: `token ${token}` },
      });
      if (!response.ok) return { hasRepo: false, hasWorkflow: false, scopes: [], isFineGrained: false };
      return { hasRepo: true, hasWorkflow: true, scopes: [], isFineGrained: true };
    }
    // GitHub default
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    const scopes = response.headers.get('x-oauth-scopes') || '';
    const scopeList = scopes.split(',').map((s) => s.trim()).filter(Boolean);

    // Classic tokens have x-oauth-scopes header
    if (scopeList.length > 0) {
      return {
        hasRepo: scopeList.includes('repo'),
        hasWorkflow: scopeList.includes('workflow'),
        scopes: scopeList,
        isFineGrained: false,
      };
    }

    // Fine-grained tokens don't have x-oauth-scopes header
    // We can't check permissions directly, so we assume valid if token works
    return {
      hasRepo: true,
      hasWorkflow: true,
      scopes: [],
      isFineGrained: true,
    };
  } catch {
    return { hasRepo: false, hasWorkflow: false, scopes: [], isFineGrained: false };
  }
}

/**
 * Set a repository secret.
 * Gitea: PUT /api/v1/repos/{owner}/{repo}/actions/secrets/{name} (base64-encoded value)
 * GitHub: gh secret set
 */
export async function setSecret(owner, repo, name, value) {
  if (isGiteaBackend()) {
    const r = await giteaAPI('PUT', `repos/${owner}/${repo}/actions/secrets/${name}`,
      { data: Buffer.from(value).toString('base64'), name });
    return r.ok ? { success: true } : { success: false, error: JSON.stringify(r.data) };
  }
  return ghCLI(`secret set ${name} --repo ${owner}/${repo}`, value);
}

/** Set multiple repository secrets. */
export async function setSecrets(owner, repo, secrets) {
  const results = {};
  for (const [name, value] of Object.entries(secrets)) {
    results[name] = await setSecret(owner, repo, name, value);
  }
  return results;
}

/**
 * List existing secret names.
 * Gitea: GET /api/v1/repos/{owner}/{repo}/actions/secrets
 * GitHub: gh secret list
 */
export async function listSecrets(owner, repo) {
  if (isGiteaBackend()) {
    const r = await giteaAPI('GET', `repos/${owner}/${repo}/actions/secrets`);
    if (!r.ok) return [];
    const items = r.data?.data ?? r.data ?? [];
    return Array.isArray(items) ? items.map(s => s.name) : [];
  }
  const r = await ghCLIRead(`secret list --repo ${owner}/${repo}`);
  return r.stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t')[0]);
}

/**
 * Set a repository variable.
 * Gitea: PUT (update) with POST (create) fallback
 * GitHub: gh variable set
 */
export async function setVariable(owner, repo, name, value) {
  if (isGiteaBackend()) {
    const ep = `repos/${owner}/${repo}/actions/variables/${name}`;
    const r = await giteaAPI('PUT', ep, { name, value });
    if (!r.ok && r.status === 404) {
      const r2 = await giteaAPI('POST', ep, { name, value });
      return r2.ok ? { success: true } : { success: false, error: JSON.stringify(r2.data) };
    }
    return r.ok ? { success: true } : { success: false, error: JSON.stringify(r.data) };
  }
  return ghCLI(`variable set ${name} --repo ${owner}/${repo}`, value);
}

/** Set multiple repository variables. */
export async function setVariables(owner, repo, variables) {
  const results = {};
  for (const [name, value] of Object.entries(variables)) {
    results[name] = await setVariable(owner, repo, name, value);
  }
  return results;
}

/**
 * Generate a random webhook secret
 */
export function generateWebhookSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * Get the token creation URL.
 * For Gitea, returns the user settings/applications page.
 * For GitHub, returns the PAT creation page with pre-selected scopes.
 */
export function getPATCreationURL() {
  if (process.env.GH_WRAPPER_BACKEND === 'gitea') {
    const base = (process.env.GITEA_URL || '').replace(/\/$/, '');
    return base ? `${base}/user/settings/applications` : '';
  }
  return 'https://github.com/settings/personal-access-tokens/new';
}
