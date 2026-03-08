import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { writeEnvKey, loadEnvFile } from '../setup/lib/env.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp dir, return { dir, envPath, cleanup } */
function tempEnv(initial = '') {
  const dir = mkdtempSync(join(tmpdir(), 'pope-setup-test-'));
  const envPath = join(dir, '.env');
  if (initial) writeFileSync(envPath, initial, 'utf-8');
  return {
    dir,
    envPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Start a minimal mock HTTP server, return { port, captured, stop } */
function startMockServer(handlers = []) {
  const captured = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw || null; }
      captured.push({ method: req.method, url: req.url, body });

      const h = handlers.find(h => h.method === req.method && req.url === h.path);
      if (h) {
        res.writeHead(h.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(h.response !== undefined ? JSON.stringify(h.response) : '{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const stop = () => new Promise(r => {
        server.closeAllConnections?.();
        server.close(r);
      });
      resolve({ port, captured, stop });
    });
  });
}

// ─── writeEnvKey ──────────────────────────────────────────────────────────────

test('writeEnvKey: creates .env with key=value when file does not exist', () => {
  const { envPath, cleanup } = tempEnv();
  try {
    writeEnvKey('FORK_REPO_URL', 'https://github.com/Coder666/thepopebot.git', envPath);
    const content = readFileSync(envPath, 'utf-8');
    assert.ok(content.includes('FORK_REPO_URL=https://github.com/Coder666/thepopebot.git'));
  } finally {
    cleanup();
  }
});

test('writeEnvKey: appends new key to existing .env', () => {
  const { envPath, cleanup } = tempEnv('GITEA_URL=http://gitea:3000\n');
  try {
    writeEnvKey('FORK_REPO_URL', 'https://github.com/Coder666/thepopebot.git', envPath);
    const content = readFileSync(envPath, 'utf-8');
    assert.ok(content.includes('GITEA_URL=http://gitea:3000'));
    assert.ok(content.includes('FORK_REPO_URL=https://github.com/Coder666/thepopebot.git'));
  } finally {
    cleanup();
  }
});

test('writeEnvKey: updates existing key in place', () => {
  const { envPath, cleanup } = tempEnv('FORK_REPO_URL=old-value\nFORK_BRANCH=main\n');
  try {
    writeEnvKey('FORK_REPO_URL', 'https://github.com/Coder666/thepopebot.git', envPath);
    const content = readFileSync(envPath, 'utf-8');
    assert.ok(!content.includes('old-value'), 'old value should be replaced');
    assert.ok(content.includes('FORK_REPO_URL=https://github.com/Coder666/thepopebot.git'));
    assert.ok(content.includes('FORK_BRANCH=main'), 'other keys preserved');
  } finally {
    cleanup();
  }
});

test('writeEnvKey: FORK_BRANCH written and readable back via loadEnvFile', () => {
  const { dir, envPath, cleanup } = tempEnv();
  try {
    writeEnvKey('FORK_REPO_URL', 'https://github.com/Coder666/thepopebot.git', envPath);
    writeEnvKey('FORK_BRANCH', 'feature/all-features', envPath);
    const env = loadEnvFile(dir);
    assert.equal(env.FORK_REPO_URL, 'https://github.com/Coder666/thepopebot.git');
    assert.equal(env.FORK_BRANCH, 'feature/all-features');
  } finally {
    cleanup();
  }
});

test('writeEnvKey: SSH URL stored without modification', () => {
  const { envPath, cleanup } = tempEnv();
  try {
    writeEnvKey('FORK_REPO_URL', 'git@github.com:Coder666/thepopebot.git', envPath);
    const env = loadEnvFile(join(tmpdir(), '..', envPath.slice(0, envPath.lastIndexOf('/'))));
    const content = readFileSync(envPath, 'utf-8');
    assert.ok(content.includes('FORK_REPO_URL=git@github.com:Coder666/thepopebot.git'));
  } finally {
    cleanup();
  }
});

// ─── loadEnvFile ──────────────────────────────────────────────────────────────

test('loadEnvFile: returns null when no .env exists', () => {
  const { dir, cleanup } = tempEnv();
  try {
    const env = loadEnvFile(dir);
    assert.equal(env, null);
  } finally {
    cleanup();
  }
});

test('loadEnvFile: parses FORK_REPO_URL and FORK_BRANCH', () => {
  const { dir, cleanup } = tempEnv(
    'FORK_REPO_URL=https://github.com/Coder666/thepopebot.git\n' +
    'FORK_BRANCH=feature/all-features\n'
  );
  try {
    const env = loadEnvFile(dir);
    assert.equal(env.FORK_REPO_URL, 'https://github.com/Coder666/thepopebot.git');
    assert.equal(env.FORK_BRANCH, 'feature/all-features');
  } finally {
    cleanup();
  }
});

test('loadEnvFile: ignores comment lines', () => {
  const { dir, cleanup } = tempEnv(
    '# This is a comment\n' +
    'FORK_REPO_URL=https://github.com/Coder666/thepopebot.git\n'
  );
  try {
    const env = loadEnvFile(dir);
    assert.ok(!Object.keys(env).some(k => k.startsWith('#')));
    assert.equal(env.FORK_REPO_URL, 'https://github.com/Coder666/thepopebot.git');
  } finally {
    cleanup();
  }
});

// ─── Gitea setVar API calls ───────────────────────────────────────────────────

/**
 * Replicate the setVar call from setup-gitea.mjs so we can test it directly.
 * PUT /api/v1/repos/{owner}/{repo}/actions/variables/{name}
 * POST if it doesn't exist; PUT if it does.
 */
async function setVar(baseUrl, token, owner, repo, name, value) {
  const ep = `repos/${owner}/${repo}/actions/variables/${name}`;
  const url = `${baseUrl}/api/v1/${ep}`;
  const hdrs = { 'Content-Type': 'application/json', Authorization: `token ${token}` };
  // Try PUT (update) first; fall back to POST (create)
  const put = await fetch(url, { method: 'PUT', headers: hdrs, body: JSON.stringify({ name, value }) });
  if (!put.ok) {
    await fetch(url.replace(`/${name}`, ''), { method: 'POST', headers: hdrs, body: JSON.stringify({ name, value }) });
  }
}

test('setVar: sends FORK_REPO_URL to Gitea actions/variables endpoint', async () => {
  const mock = await startMockServer([
    { method: 'PUT', path: '/api/v1/repos/admin/pope-bot/actions/variables/FORK_REPO_URL', status: 200, response: {} },
  ]);
  try {
    await setVar(`http://127.0.0.1:${mock.port}`, 'tok', 'admin', 'pope-bot',
      'FORK_REPO_URL', 'https://github.com/Coder666/thepopebot.git');
    const req = mock.captured.find(r => r.url.includes('FORK_REPO_URL'));
    assert.ok(req, 'request to FORK_REPO_URL variable endpoint was made');
    assert.equal(req.body.name, 'FORK_REPO_URL');
    assert.equal(req.body.value, 'https://github.com/Coder666/thepopebot.git');
  } finally {
    await mock.stop();
  }
});

test('setVar: sends FORK_BRANCH to Gitea actions/variables endpoint', async () => {
  const mock = await startMockServer([
    { method: 'PUT', path: '/api/v1/repos/admin/pope-bot/actions/variables/FORK_BRANCH', status: 200, response: {} },
  ]);
  try {
    await setVar(`http://127.0.0.1:${mock.port}`, 'tok', 'admin', 'pope-bot',
      'FORK_BRANCH', 'feature/all-features');
    const req = mock.captured.find(r => r.url.includes('FORK_BRANCH'));
    assert.ok(req, 'request to FORK_BRANCH variable endpoint was made');
    assert.equal(req.body.value, 'feature/all-features');
  } finally {
    await mock.stop();
  }
});

test('setVar: falls back to POST when PUT returns non-ok', async () => {
  const mock = await startMockServer([
    { method: 'PUT', path: '/api/v1/repos/admin/pope-bot/actions/variables/FORK_REPO_URL', status: 404, response: {} },
    { method: 'POST', path: '/api/v1/repos/admin/pope-bot/actions/variables', status: 201, response: {} },
  ]);
  try {
    await setVar(`http://127.0.0.1:${mock.port}`, 'tok', 'admin', 'pope-bot',
      'FORK_REPO_URL', 'https://github.com/Coder666/thepopebot.git');
    const post = mock.captured.find(r => r.method === 'POST' && r.url.includes('variables'));
    assert.ok(post, 'POST was made after PUT failed');
    assert.equal(post.body.name, 'FORK_REPO_URL');
  } finally {
    await mock.stop();
  }
});

// ─── Workflow YAML structure ───────────────────────────────────────────────────

const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('rebuild-agent-image.yml: references vars.FORK_REPO_URL', () => {
  const yml = readFileSync(
    join(PROJECT_ROOT, 'templates/.github/workflows/rebuild-agent-image.yml'), 'utf-8'
  );
  assert.ok(yml.includes('vars.FORK_REPO_URL'), 'FORK_REPO_URL must be read from repo vars');
  assert.ok(yml.includes('vars.FORK_BRANCH'), 'FORK_BRANCH must be read from repo vars');
  assert.ok(yml.includes('workflow_dispatch'), 'must support manual dispatch');
  assert.ok(!yml.includes('gitea-local'), 'must not contain hardcoded gitea-local SSH alias');
});

test('sync-from-fork.yml: has schedule and FORK_REPO_URL', () => {
  const yml = readFileSync(
    join(PROJECT_ROOT, 'templates/.github/workflows/sync-from-fork.yml'), 'utf-8'
  );
  assert.ok(yml.includes('schedule'), 'must have scheduled trigger');
  assert.ok(yml.includes('vars.FORK_REPO_URL'), 'must use FORK_REPO_URL from repo vars');
  assert.ok(yml.includes('workflow_dispatch'), 'must support manual dispatch');
  assert.ok(yml.includes('AGENT_GITEA_TOKEN'), 'must use AGENT_GITEA_TOKEN secret for auth');
});

test('sync-from-fork.yml: branch can be specified via workflow_dispatch input', () => {
  const yml = readFileSync(
    join(PROJECT_ROOT, 'templates/.github/workflows/sync-from-fork.yml'), 'utf-8'
  );
  assert.ok(yml.includes('github.event.inputs.branch'), 'branch input must be used');
  // Default falls back to main
  assert.ok(yml.includes("|| 'main'"), 'must default to main when branch not specified');
});
