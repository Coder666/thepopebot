#!/usr/bin/env node
/**
 * setup/setup-gitea.mjs — thepopebot Gitea setup wizard
 *
 * One command that provisions everything needed to run thepopebot on a
 * self-hosted Gitea instance: Gitea Docker stack (optional), admin user,
 * Actions runner, bot repository, repo variables/secrets, and .env.
 *
 * Usage
 *   node setup/setup-gitea.mjs              # run from your popebot project dir
 *   node setup/setup-gitea.mjs --dry-run    # show what would happen, no changes
 *   node setup/setup-gitea.mjs --project /path/to/project
 */

import {
  intro, outro, text, password as promptPassword,
  confirm, select, spinner, log, note, isCancel,
} from '@clack/prompts';
import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { writeEnvKey } from './lib/env.mjs';

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const projectIdx = argv.indexOf('--project');
const PROJECT_ROOT = projectIdx >= 0
  ? path.resolve(argv[projectIdx + 1])
  : process.cwd();

// The npm package root (where setup-gitea.mjs lives under setup/)
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

// ─── Utilities ────────────────────────────────────────────────────────────────

const bail = (msg) => { log.error(msg); process.exit(1); };
const sym  = (v)   => isCancel(v);

function readEnv(filePath = ENV_PATH) {
  const env = {};
  if (!existsSync(filePath)) return env;
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function _writeEnvKey(key, value, filePath = ENV_PATH) {
  const isSensitive = /token|key|secret|pass/i.test(key);
  if (DRY_RUN) {
    log.info(`[dry-run] .env: ${key}=${isSensitive ? '***' : value}`);
    return;
  }
  writeEnvKey(key, value, filePath);
}

async function giteaAPI(baseUrl, token, method, endpoint, body) {
  const url = `${baseUrl}/api/v1/${endpoint.replace(/^\//, '')}`;
  const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) hdrs.Authorization = `token ${token}`;
  if (DRY_RUN && method !== 'GET') {
    log.info(`[dry-run] ${method} ${url}${body ? '  ' + JSON.stringify(body).slice(0, 80) : ''}`);
    return { ok: true, status: 200, data: {} };
  }
  const res = await fetch(url, {
    method, headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

async function giteaBasicAuth(baseUrl, username, password, method, endpoint, body) {
  const url = `${baseUrl}/api/v1/${endpoint.replace(/^\//, '')}`;
  const b64 = Buffer.from(`${username}:${password}`).toString('base64');
  const hdrs = {
    'Content-Type': 'application/json', Accept: 'application/json',
    Authorization: `Basic ${b64}`,
  };
  if (DRY_RUN && method !== 'GET') {
    log.info(`[dry-run] ${method} ${url} (basic-auth)`);
    return { ok: true, status: 200, data: { sha1: 'dry-run-token', full_name: `${username}/repo`, html_url: `${baseUrl}/${username}/repo` } };
  }
  const res = await fetch(url, {
    method, headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

async function setVar(baseUrl, token, owner, repo, name, value) {
  // PUT updates an existing variable; POST creates it (both go to named endpoint)
  const ep = `repos/${owner}/${repo}/actions/variables/${name}`;
  const r = await giteaAPI(baseUrl, token, 'PUT', ep, { name, value });
  if (!r.ok && r.status === 404) {
    const r2 = await giteaAPI(baseUrl, token, 'POST', ep, { name, value });
    if (!r2.ok) log.warn(`  Variable ${name}: ${JSON.stringify(r2.data).slice(0, 120)}`);
  } else if (!r.ok) {
    log.warn(`  Variable ${name}: ${JSON.stringify(r.data).slice(0, 120)}`);
  }
}

async function setSecret(baseUrl, token, owner, repo, name, value) {
  if (!value) { log.warn(`  Skipping secret ${name} — empty value`); return; }
  const encoded = Buffer.from(value).toString('base64');
  const r = await giteaAPI(baseUrl, token, 'PUT',
    `repos/${owner}/${repo}/actions/secrets/${name}`, { data: encoded, name });
  if (!r.ok) log.warn(`  Secret ${name}: ${JSON.stringify(r.data).slice(0, 120)}`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8', ...opts }).trim();
}

function dockerAvailable() {
  try { run('docker info'); return true; } catch { return false; }
}

/** Poll until container is healthy (max maxSeconds). */
function waitHealthy(container, maxSeconds = 180) {
  const sp = spinner();
  sp.start(`Waiting for ${container} to be healthy…`);
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const s = run(`docker inspect ${container} --format '{{.State.Health.Status}}'`);
      if (s === 'healthy')   { sp.stop(`${container} healthy ✓`); return; }
      if (s === 'unhealthy') { sp.stop(''); bail(`${container} unhealthy — run: docker logs ${container}`); }
    } catch { /* not ready yet */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  }
  sp.stop('');
  bail(`Timed out waiting for ${container} — run: docker logs ${container}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

intro(`  thepopebot — Gitea setup wizard${DRY_RUN ? '  [DRY RUN]' : ''}  `);
if (DRY_RUN) log.info('Dry-run mode: no files will be written and no API calls will be mutated.\n');

const existingEnv = readEnv();

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Gitea instance
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 1/6 — Gitea instance');

const gitea_mode = await select({
  message: 'How do you want to connect to Gitea?',
  options: [
    { label: 'Start a fresh Gitea with Docker  (recommended for new setups)', value: 'docker'   },
    { label: 'Use an existing Gitea instance',                                 value: 'existing' },
  ],
});
if (sym(gitea_mode)) process.exit(0);

let giteaUrl, giteaToken, giteaUser;
let composeDir, adminUsername, adminPassword;

if (gitea_mode === 'docker') {
  if (!dockerAvailable() && !DRY_RUN) bail('Docker is not running or not in PATH. Start Docker and try again.');

  composeDir = await text({
    message: 'Directory for Gitea data and compose files',
    placeholder: './gitea-stack',
    initialValue: existingEnv.GITEA_COMPOSE_DIR || './gitea-stack',
    validate: v => v.trim() ? undefined : 'Required',
  });
  if (sym(composeDir)) process.exit(0);
  composeDir = path.resolve(composeDir);

  const httpPort = await text({
    message: 'Gitea HTTP port  (host-side, e.g. 3000 or 3001)',
    placeholder: '3000',
    initialValue: existingEnv.GITEA_HTTP_PORT || '3000',
    validate: v => /^\d+$/.test(v) ? undefined : 'Must be a number',
  });
  if (sym(httpPort)) process.exit(0);

  const domain = await text({
    message: 'Hostname / domain for Gitea  (used in clone URLs and the UI)',
    placeholder: 'localhost',
    initialValue: existingEnv.GITEA_DOMAIN || 'localhost',
  });
  if (sym(domain)) process.exit(0);

  adminUsername = await text({
    message: 'Admin username',
    placeholder: 'admin',
    initialValue: 'admin',
  });
  if (sym(adminUsername)) process.exit(0);

  adminPassword = await promptPassword({
    message: 'Admin password',
    validate: v => v.length >= 8 ? undefined : 'At least 8 characters',
  });
  if (sym(adminPassword)) process.exit(0);

  giteaUrl = `http://${domain}:${httpPort}`;

  // ── Write compose + runner config ─────────────────────────────────────────
  const sp = spinner();
  sp.start('Writing Docker Compose files…');

  if (!DRY_RUN) {
    mkdirSync(composeDir, { recursive: true });
    mkdirSync(path.join(composeDir, 'data'),   { recursive: true });
    mkdirSync(path.join(composeDir, 'runner'), { recursive: true });
  }

  const secretKey = randomBytes(32).toString('hex');

  const composeYml = `# thepopebot Gitea stack — generated by setup-gitea.mjs
name: gitea

services:
  gitea:
    image: gitea/gitea:latest
    container_name: gitea
    restart: unless-stopped
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__database__DB_TYPE: sqlite3
      GITEA__database__PATH: /data/gitea/gitea.db
      GITEA__server__DOMAIN: "${domain}"
      GITEA__server__ROOT_URL: "${giteaUrl}/"
      GITEA__server__HTTP_PORT: "3000"
      GITEA__actions__ENABLED: "true"
      GITEA__actions__DEFAULT_ACTIONS_URL: "self"
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__security__SECRET_KEY: "${secretKey}"
    ports:
      - "${httpPort}:3000"
    volumes:
      - ./data:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    networks:
      - gitea-internal
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/healthz"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 30s

  gitea-runner:
    image: gitea/act_runner:latest
    container_name: gitea-runner
    restart: unless-stopped
    depends_on:
      gitea:
        condition: service_healthy
    environment:
      GITEA_INSTANCE_URL: "http://gitea:3000"
      GITEA_RUNNER_REGISTRATION_TOKEN: "\${GITEA_RUNNER_TOKEN}"
      GITEA_RUNNER_NAME: "\${GITEA_RUNNER_NAME:-popebot-runner}"
      CONFIG_FILE: /config/config.yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./runner:/data
      - ./runner-config.yaml:/config/config.yaml:ro
    networks:
      - gitea-internal

networks:
  gitea-internal:
    driver: bridge
`;

  const runnerCfg = `# Gitea act_runner — generated by setup-gitea.mjs
log:
  level: info

runner:
  capacity: 4
  labels:
    - "ubuntu-latest:docker://node:22-bookworm-slim"
    - "ubuntu-22.04:docker://node:22-bookworm-slim"
    - "self-hosted:docker://node:22-bookworm-slim"

cache:
  enabled: true

container:
  docker_host: "unix:///var/run/docker.sock"
  # --network=host lets agent containers reach services on the host machine
  options: "--network=host"
  force_pull: false
  valid_volumes:
    - "**"
`;

  if (!DRY_RUN) {
    writeFileSync(path.join(composeDir, 'docker-compose.yml'), composeYml);
    writeFileSync(path.join(composeDir, 'runner-config.yaml'), runnerCfg);
  } else {
    log.info(`[dry-run] Would write ${path.join(composeDir, 'docker-compose.yml')}`);
    log.info(`[dry-run] Would write ${path.join(composeDir, 'runner-config.yaml')}`);
  }
  sp.stop('Compose files written ✓');

  // ── Start Gitea ───────────────────────────────────────────────────────────
  const sp2 = spinner();
  sp2.start('Starting Gitea container…');
  if (!DRY_RUN) {
    try {
      run(`docker compose -f "${path.join(composeDir, 'docker-compose.yml')}" up -d gitea`);
    } catch (e) { sp2.stop(''); bail(`docker compose up failed:\n${e.message}`); }
    sp2.stop('Gitea container started');
    waitHealthy('gitea');
  } else {
    sp2.stop('[dry-run] Would start gitea container');
  }

  // ── Create admin user via CLI ─────────────────────────────────────────────
  const sp3 = spinner();
  sp3.start(`Creating admin user '${adminUsername}'…`);
  if (!DRY_RUN) {
    try {
      run(`docker exec -u git gitea gitea admin user create --username "${adminUsername}" --password "${adminPassword}" --email "${adminUsername}@localhost" --admin --must-change-password=false`);
      sp3.stop(`Admin '${adminUsername}' created ✓`);
    } catch {
      try {
        run(`docker exec -u git gitea gitea admin user change-password --username "${adminUsername}" --password "${adminPassword}" --must-change-password=false`);
        sp3.stop(`Admin '${adminUsername}' updated ✓`);
      } catch (e2) { sp3.stop(''); bail(`Could not create/update admin: ${e2.message}`); }
    }
  } else {
    sp3.stop(`[dry-run] Would create admin '${adminUsername}'`);
  }

  // ── Generate runner registration token ───────────────────────────────────
  let runnerToken = 'dry-run-runner-token';
  const sp4 = spinner();
  sp4.start('Generating runner registration token…');
  if (!DRY_RUN) {
    try {
      const out = run(`docker exec -u git gitea gitea actions generate-runner-token`);
      runnerToken = out.split('\n').pop().trim();
      sp4.stop('Runner token generated ✓');
    } catch (e) { sp4.stop(''); bail(`Could not generate runner token: ${e.message}`); }
  } else {
    sp4.stop('[dry-run] Would generate runner token');
  }

  // Write compose .env with runner token
  if (!DRY_RUN) {
    writeFileSync(
      path.join(composeDir, '.env'),
      `GITEA_RUNNER_TOKEN=${runnerToken}\nGITEA_RUNNER_NAME=popebot-runner\n`
    );
  }

  // ── Create PAT via basic auth ─────────────────────────────────────────────
  const sp5 = spinner();
  sp5.start('Creating admin PAT…');
  const patRes = await giteaBasicAuth(giteaUrl, adminUsername, adminPassword, 'POST',
    `users/${adminUsername}/tokens`,
    { name: `popebot-${Date.now()}`, scopes: ['read:user', 'write:user', 'write:repository', 'write:issue'] }
  );
  if (!patRes.ok || !patRes.data.sha1) {
    sp5.stop('');
    bail(`Could not create PAT: ${JSON.stringify(patRes.data)}`);
  }
  giteaToken = patRes.data.sha1;
  sp5.stop('PAT created ✓');

  // ── Start runner ──────────────────────────────────────────────────────────
  const sp6 = spinner();
  sp6.start('Starting Gitea Actions runner…');
  if (!DRY_RUN) {
    try {
      run(`docker compose -f "${path.join(composeDir, 'docker-compose.yml')}" up -d gitea-runner`);
      sp6.stop('Runner started ✓');
    } catch (e) { sp6.stop(''); log.warn(`Runner start failed (start manually later):\n${e.message}`); }
  } else {
    sp6.stop('[dry-run] Would start runner');
  }

  giteaUser = { login: adminUsername };

} else {
  // ── Existing Gitea ────────────────────────────────────────────────────────
  giteaUrl = await text({
    message: 'Gitea instance URL',
    placeholder: 'http://localhost:3000',
    initialValue: existingEnv.GITEA_URL || '',
    validate: v => { try { new URL(v); } catch { return 'Enter a valid URL'; } },
  });
  if (sym(giteaUrl)) process.exit(0);

  adminUsername = await text({
    message: 'Gitea admin username',
    placeholder: 'admin',
    initialValue: 'admin',
  });
  if (sym(adminUsername)) process.exit(0);

  adminPassword = await promptPassword({
    message: 'Admin password  (used to create a PAT, not stored in .env)',
    validate: v => v.trim().length >= 1 ? undefined : 'Required',
  });
  if (sym(adminPassword)) process.exit(0);

  const sp = spinner();
  sp.start('Authenticating and creating PAT…');
  const patRes = await giteaBasicAuth(giteaUrl, adminUsername, adminPassword, 'POST',
    `users/${adminUsername}/tokens`,
    { name: `popebot-${Date.now()}`, scopes: ['read:user', 'write:user', 'write:repository', 'write:issue'] }
  );
  if (!patRes.ok || !patRes.data.sha1) {
    sp.stop('');
    bail(`Could not authenticate or create PAT:\n${JSON.stringify(patRes.data)}`);
  }
  giteaToken = patRes.data.sha1;

  const me = await giteaAPI(giteaUrl, giteaToken, 'GET', 'user');
  if (!me.ok) { sp.stop(''); bail(`PAT validation failed: ${JSON.stringify(me.data)}`); }
  giteaUser = DRY_RUN ? { login: adminUsername } : me.data;
  sp.stop(`Authenticated as ${giteaUser.login} ✓`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Repository
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 2/6 — Bot repository');

const defaultRepoName = existingEnv.GH_REPO || path.basename(PROJECT_ROOT);
const repoName = await text({
  message: 'Repository name on Gitea',
  placeholder: defaultRepoName,
  initialValue: defaultRepoName,
  validate: v => v.trim() ? undefined : 'Required',
});
if (sym(repoName)) process.exit(0);

const sp_repo = spinner();
sp_repo.start(`Finding / creating ${giteaUser.login}/${repoName}…`);
let repo;
const getRepo = await giteaAPI(giteaUrl, giteaToken, 'GET', `repos/${giteaUser.login}/${repoName}`);
if (getRepo.ok && getRepo.data.full_name) {
  repo = getRepo.data;
  sp_repo.stop(`Found existing repo: ${repo.html_url}`);
} else {
  // Repo creation needs write:user scope — use basic auth
  const createRes = await giteaBasicAuth(giteaUrl, adminUsername, adminPassword, 'POST', 'user/repos', {
    name: repoName, description: 'thepopebot project', private: false, auto_init: false,
  });
  if (!createRes.ok) { sp_repo.stop(''); bail(`Could not create repo: ${JSON.stringify(createRes.data)}`); }
  repo = createRes.data;
  sp_repo.stop(`Created: ${repo.html_url || `${giteaUrl}/${giteaUser.login}/${repoName}`}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Push project
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 3/6 — Push project to Gitea');

const hasGit = existsSync(path.join(PROJECT_ROOT, '.git'));
const shouldPush = await confirm({
  message: hasGit
    ? `Push ${PROJECT_ROOT} to Gitea?`
    : `Initialise git and push ${PROJECT_ROOT} to Gitea?`,
  initialValue: true,
});
if (sym(shouldPush)) process.exit(0);

if (shouldPush) {
  const sp = spinner();
  sp.start('Pushing to Gitea…');
  const cloneUrl = repo.clone_url || `${giteaUrl}/${giteaUser.login}/${repoName}.git`;
  const authUrl  = cloneUrl.replace('://', `://${giteaUser.login}:${giteaToken}@`);
  if (!DRY_RUN) {
    try {
      if (!hasGit) {
        run('git init',                       { cwd: PROJECT_ROOT });
        run('git add -A',                     { cwd: PROJECT_ROOT });
        run('git commit -m "Initial commit"', { cwd: PROJECT_ROOT });
      }
      spawnSync('git', ['remote', 'remove', 'gitea'], { cwd: PROJECT_ROOT });
      run(`git remote add gitea "${authUrl}"`,     { cwd: PROJECT_ROOT });
      run('git push -u gitea HEAD:main --force',   { cwd: PROJECT_ROOT });
      sp.stop('Pushed ✓');
    } catch (e) { sp.stop(''); log.warn(`Push failed: ${e.message}\nYou can push manually later.`); }
  } else {
    sp.stop(`[dry-run] Would push ${PROJECT_ROOT} → ${cloneUrl}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: LLM configuration
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 4/6 — LLM configuration');

const llmProvider = await select({
  message: 'LLM provider for agent jobs',
  options: [
    { label: 'Anthropic (Claude) — recommended', value: 'anthropic' },
    { label: 'OpenAI (GPT)',                     value: 'openai'    },
    { label: 'Google (Gemini)',                  value: 'google'    },
    { label: 'Custom / local (OpenAI-compatible)', value: 'custom'  },
  ],
  initialValue: existingEnv.LLM_PROVIDER || 'anthropic',
});
if (sym(llmProvider)) process.exit(0);

const defaultModels = {
  anthropic: 'claude-sonnet-4-20250514',
  openai:    'gpt-4o',
  google:    'gemini-2.5-pro',
  custom:    '',
};
const llmModel = await text({
  message: 'LLM model',
  placeholder: defaultModels[llmProvider] || 'model-name',
  initialValue: existingEnv.LLM_MODEL || defaultModels[llmProvider] || '',
});
if (sym(llmModel)) process.exit(0);

let llmApiKey    = '';
let openaiBaseUrl = '';

if (llmProvider === 'custom') {
  openaiBaseUrl = await text({
    message: 'OpenAI-compatible base URL',
    placeholder: 'http://localhost:11434/v1',
    initialValue: existingEnv.OPENAI_BASE_URL || '',
    validate: v => { try { new URL(v); return undefined; } catch { return 'Enter a valid URL'; } },
  });
  if (sym(openaiBaseUrl)) process.exit(0);

  llmApiKey = await promptPassword({
    message: 'API key  (press Enter to skip if no authentication is required)',
  });
  if (sym(llmApiKey)) process.exit(0);
} else {
  llmApiKey = await promptPassword({
    message: `${llmProvider[0].toUpperCase() + llmProvider.slice(1)} API key`,
    validate: v => v.trim() ? undefined : 'Required',
  });
  if (sym(llmApiKey)) process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Agent job image source
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 5/6 — Agent job image');

const jobImageMode = await select({
  message: 'Which Docker image should agent jobs use?',
  options: [
    {
      label: 'Published stephengpope/thepopebot images  (recommended)',
      value: 'published',
    },
    {
      label: 'Custom Docker image URL  (for local builds or development branches)',
      value: 'custom',
    },
  ],
  initialValue: existingEnv.JOB_IMAGE_URL ? 'custom' : 'published',
});
if (sym(jobImageMode)) process.exit(0);

let jobImageUrl = '';
if (jobImageMode === 'custom') {
  jobImageUrl = await text({
    message: 'Docker image URL',
    placeholder: 'registry.local/thepopebot:mybranch',
    initialValue: existingEnv.JOB_IMAGE_URL || '',
    validate: v => v.trim() ? undefined : 'Required',
  });
  if (sym(jobImageUrl)) process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5b: Fork source (used by rebuild-agent-image and sync-from-fork workflows)
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 5b/6 — Fork source (for rebuild and auto-sync workflows)');

const forkRepoUrl = await text({
  message: 'Git URL of the pope-bot fork to build from and sync with',
  placeholder: 'https://github.com/your-org/thepopebot.git',
  initialValue: existingEnv.FORK_REPO_URL || '',
  hint: 'Used by rebuild-agent-image and sync-from-fork workflows. Use HTTPS for public repos, SSH for private.',
  validate: v => v.trim() ? undefined : 'Required',
});
if (sym(forkRepoUrl)) process.exit(0);

const forkBranch = await text({
  message: 'Default branch to build/sync from',
  placeholder: 'feature/all-features',
  initialValue: existingEnv.FORK_BRANCH || 'feature/all-features',
  validate: v => v.trim() ? undefined : 'Required',
});
if (sym(forkBranch)) process.exit(0);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: Apply configuration
// ─────────────────────────────────────────────────────────────────────────────

log.step('Step 6/6 — Configuring repo and writing .env');

// Detect Gitea version for quirks
const versionRes  = await giteaAPI(giteaUrl, giteaToken, 'GET', 'version');
const giteaVersion = versionRes.ok ? (versionRes.data.version || '') : '';
const needsQuirks  = giteaVersion.startsWith('1.25');
if (needsQuirks) {
  log.warn(`Gitea ${giteaVersion}: underscore-parameter quirk detected — GITEA_QUIRKS=1.25 will be set`);
}

const owner = giteaUser.login;

// ── Repo variables ────────────────────────────────────────────────────────────
// Note: names starting with GITEA_ are reserved by the runner and will be
// rejected with HTTP 400. GITEA_URL is derived from github.server_url in the
// workflow instead of being stored as a repo variable.
const sp_vars = spinner();
sp_vars.start('Setting repo variables…');

const varsToSet = [
  ['GH_WRAPPER_BACKEND', 'gitea'        ],
  ['LLM_PROVIDER',       llmProvider    ],
  ['LLM_MODEL',          llmModel       ],
  ['RUNS_ON',            'ubuntu-latest'],
];
if (openaiBaseUrl)        varsToSet.push(['OPENAI_BASE_URL', openaiBaseUrl]);
if (jobImageUrl)          varsToSet.push(['JOB_IMAGE_URL',   jobImageUrl  ]);
if (forkRepoUrl.trim())   varsToSet.push(['FORK_REPO_URL',   forkRepoUrl.trim()]);
if (forkBranch.trim())    varsToSet.push(['FORK_BRANCH',     forkBranch.trim()]);

for (const [name, value] of varsToSet) {
  await setVar(giteaUrl, giteaToken, owner, repoName, name, value);
}
sp_vars.stop(`${varsToSet.length} variables set ✓`);

// ── Repo secrets ──────────────────────────────────────────────────────────────
const sp_sec = spinner();
sp_sec.start('Setting repo secrets…');

// AGENT_GITEA_TOKEN → stripped to GITEA_TOKEN inside the agent container
await setSecret(giteaUrl, giteaToken, owner, repoName, 'AGENT_GITEA_TOKEN', giteaToken);

if (llmApiKey) {
  // AGENT_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY in the agent container via SECRETS
  await setSecret(giteaUrl, giteaToken, owner, repoName,
    `AGENT_${llmProvider.toUpperCase()}_API_KEY`, llmApiKey);
}
sp_sec.stop('Secrets set ✓');

// ── Write project .env ────────────────────────────────────────────────────────
const sp_env = spinner();
sp_env.start('Updating .env…');

// Event-handler reaches Gitea via the internal Docker hostname when using
// Docker mode; via the external URL when connecting to an existing instance.
const internalGiteaUrl = gitea_mode === 'docker' ? 'http://gitea:3000' : giteaUrl;

_writeEnvKey('GH_WRAPPER_BACKEND', 'gitea'          );
_writeEnvKey('GITEA_URL',           internalGiteaUrl );
_writeEnvKey('GITEA_TOKEN',         giteaToken       );
_writeEnvKey('GH_OWNER',            owner            );
_writeEnvKey('GH_REPO',             repoName         );
_writeEnvKey('LLM_PROVIDER',        llmProvider      );
_writeEnvKey('LLM_MODEL',           llmModel         );
if (openaiBaseUrl)                      _writeEnvKey('OPENAI_BASE_URL', openaiBaseUrl);
if (llmApiKey && llmProvider !== 'custom') _writeEnvKey(`${llmProvider.toUpperCase()}_API_KEY`, llmApiKey);
if (llmApiKey && llmProvider === 'custom') _writeEnvKey('CUSTOM_API_KEY', llmApiKey);
if (needsQuirks)                        _writeEnvKey('GITEA_QUIRKS',    '1.25'       );
if (gitea_mode === 'docker')            _writeEnvKey('GITEA_COMPOSE_DIR', composeDir );
if (forkRepoUrl.trim())                 _writeEnvKey('FORK_REPO_URL',   forkRepoUrl.trim());
if (forkBranch.trim())                  _writeEnvKey('FORK_BRANCH',     forkBranch.trim());

sp_env.stop(`.env updated ✓`);

// ─── Summary ──────────────────────────────────────────────────────────────────

outro(`Gitea setup ${DRY_RUN ? '(dry run) ' : ''}complete!`);

const repoUrl = repo.html_url || `${giteaUrl}/${owner}/${repoName}`;
note([
  `Gitea:    ${giteaUrl}`,
  `Repo:     ${repoUrl}`,
  `User:     ${owner}`,
  giteaVersion ? `Version:  ${giteaVersion}${needsQuirks ? ' (quirks applied)' : ''}` : '',
  '',
  'Next steps:',
  '  1. Start (or restart) the event handler:',
  '       docker compose up -d event-handler',
  '',
  '  2. Send a test job:',
  '       curl -X POST http://localhost/api/jobs \\',
  "            -H 'x-api-key: YOUR_API_KEY' \\",
  "            -d '{\"job\":\"say hello from Gitea\"}'",
  '',
  gitea_mode === 'docker' ? `  3. Gitea compose dir: ${composeDir}` : '',
  DRY_RUN ? '  ⚠  Dry run — no changes were made.' : '',
].filter(Boolean).join('\n'), 'Summary');
