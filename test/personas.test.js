/**
 * Tests for the persona system:
 *   - loadPersonaContent  (lib/ai/personas.js)
 *   - loadPersonasRegistry (lib/ai/personas.js)
 *   - delegateToPersona   (lib/ai/personas.js)
 *
 * All imports are from the standalone personas.js module which has no LangChain
 * dependency, making the tests runnable without peer packages installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

const { loadPersonaContent, loadPersonasRegistry, delegateToPersona } = await import('../lib/ai/personas.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temp directory with a PERSONAS.json and optional persona files.
 * @param {object} [opts]
 * @param {object} [opts.registry]  - Content for PERSONAS.json
 * @param {object} [opts.files]     - Extra files: { 'name.md': 'content' }
 * @returns {{ dir, registryFile, cleanup }}
 */
function makeTempPersonasDir({ registry = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pope-personas-'));
  const registryFile = path.join(dir, 'PERSONAS.json');
  fs.writeFileSync(registryFile, JSON.stringify(registry), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return { dir, registryFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Start a minimal HTTP mock server. captured[] records each request.
 */
function startMockServer(handlers = []) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw || null; }
      captured.push({ method: req.method, url: req.url, headers: req.headers, body });

      const h = handlers.find((h) => h.method === req.method && req.url === h.path);
      if (h) {
        res.writeHead(h.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(h.response !== undefined ? JSON.stringify(h.response) : '{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const stop = () => {
        server.closeAllConnections();
        return new Promise((r) => server.close(r));
      };
      resolve({ port, captured, stop });
    });
  });
}

// ─── loadPersonasRegistry ─────────────────────────────────────────────────────

test('loadPersonasRegistry: returns parsed JSON from file', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: { default: { file: 'personas/default.md', description: 'Default' } },
  });
  try {
    const reg = loadPersonasRegistry(registryFile);
    assert.ok(reg.default, 'should have default key');
    assert.equal(reg.default.description, 'Default');
  } finally {
    cleanup();
  }
});

test('loadPersonasRegistry: returns {} for missing file', () => {
  assert.deepEqual(loadPersonasRegistry('/nonexistent/PERSONAS.json'), {});
});

test('loadPersonasRegistry: returns {} for malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pope-reg-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ invalid }', 'utf8');
  try {
    assert.deepEqual(loadPersonasRegistry(bad), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── loadPersonaContent ───────────────────────────────────────────────────────

test('loadPersonaContent: returns default.md content for "default"', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {},
    files: { 'default.md': '# Default\n\nI am default.' },
  });
  try {
    assert.equal(
      loadPersonaContent('default', { dir, file: registryFile }),
      '# Default\n\nI am default.'
    );
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: returns empty string for "default" when default.md is absent', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({ registry: {} });
  try {
    assert.equal(loadPersonaContent('default', { dir, file: registryFile }), '');
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: null personaId is treated as "default"', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {},
    files: { 'default.md': 'hello default' },
  });
  try {
    assert.equal(loadPersonaContent(null, { dir, file: registryFile }), 'hello default');
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: empty string personaId is treated as "default"', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {},
    files: { 'default.md': 'default content' },
  });
  try {
    assert.equal(loadPersonaContent('', { dir, file: registryFile }), 'default content');
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: loads named persona content from registry', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: { manager: { file: 'personas/manager.md', description: 'Manager' } },
    files: { 'manager.md': '# Manager\n\nI coordinate.' },
  });
  try {
    assert.equal(
      loadPersonaContent('manager', { dir, file: registryFile }),
      '# Manager\n\nI coordinate.'
    );
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: strips "personas/" prefix from registry file field', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: { worker: { file: 'personas/worker.md' } },
    files: { 'worker.md': '# Worker' },
  });
  try {
    assert.equal(loadPersonaContent('worker', { dir, file: registryFile }), '# Worker');
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: returns empty string for unknown persona not in registry', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({ registry: {} });
  try {
    assert.equal(loadPersonaContent('unknown', { dir, file: registryFile }), '');
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: returns empty string when PERSONAS.json is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pope-empty-'));
  try {
    const fakeFile = path.join(dir, 'nonexistent.json');
    assert.equal(loadPersonaContent('manager', { dir, file: fakeFile }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPersonaContent: returns empty string when PERSONAS.json is malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pope-bad-'));
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{ bad json }', 'utf8');
  try {
    assert.equal(loadPersonaContent('manager', { dir, file: badFile }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPersonaContent: returns empty string when persona file is listed but missing on disk', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: { ghost: { file: 'personas/ghost.md' } },
    // ghost.md intentionally not created
  });
  try {
    assert.equal(loadPersonaContent('ghost', { dir, file: registryFile }), '');
  } finally {
    cleanup();
  }
});

test('loadPersonaContent: returns empty string when registry entry has no file field', () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: { broken: { description: 'No file field' } },
  });
  try {
    assert.equal(loadPersonaContent('broken', { dir, file: registryFile }), '');
  } finally {
    cleanup();
  }
});

// ─── delegateToPersona: error cases ──────────────────────────────────────────

test('delegateToPersona: returns error object for unknown persona', async () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({ registry: {} });
  try {
    const result = await delegateToPersona('nonexistent', 'hello', undefined, { registryPath: registryFile });
    assert.ok(result.error, 'should have an error field');
    assert.match(result.error, /Unknown persona/i);
    assert.match(result.error, /nonexistent/);
  } finally {
    cleanup();
  }
});

test('delegateToPersona: error lists available personas when registry is non-empty', async () => {
  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      worker: { file: 'personas/worker.md' },
      analyst: { file: 'personas/analyst.md' },
    },
  });
  try {
    const result = await delegateToPersona('bogus', 'hi', undefined, { registryPath: registryFile });
    assert.match(result.error, /worker|analyst/);
  } finally {
    cleanup();
  }
});

test('delegateToPersona: returns error when remoteApiKeyEnv var is not set', async () => {
  const envKey = 'POPE_TEST_MISSING_KEY_XYZZY';
  delete process.env[envKey];

  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      remote_worker: {
        file: 'personas/worker.md',
        remoteUrl: 'http://127.0.0.1:9999',
        remoteApiKeyEnv: envKey,
      },
    },
  });
  try {
    const result = await delegateToPersona('remote_worker', 'do something', undefined, { registryPath: registryFile });
    assert.ok(result.error, 'should have an error field');
    assert.match(result.error, new RegExp(envKey));
  } finally {
    cleanup();
  }
});

// ─── delegateToPersona: remote delegation ────────────────────────────────────

test('delegateToPersona: POSTs to /api/chat on the remote bot', async () => {
  const mock = await startMockServer([
    {
      method: 'POST',
      path: '/api/chat',
      response: { response: 'Task complete.', threadId: 'remote-thread-1' },
    },
  ]);

  const envKey = 'POPE_TEST_REMOTE_KEY_ABC';
  process.env[envKey] = 'secret-test-key';

  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      remote_worker: {
        file: 'personas/worker.md',
        remoteUrl: `http://127.0.0.1:${mock.port}`,
        remoteApiKeyEnv: envKey,
      },
    },
  });

  try {
    const result = await delegateToPersona('remote_worker', 'Do the thing', 'parent-thread-42', {
      registryPath: registryFile,
    });

    // Response forwarded correctly
    assert.equal(result.response, 'Task complete.');

    // Exactly one request captured
    assert.equal(mock.captured.length, 1);
    const req = mock.captured[0];

    // Correct HTTP method and path
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/chat');

    // Correct request body fields
    assert.equal(req.body.message, 'Do the thing');
    assert.equal(req.body.personaId, 'remote_worker');
    assert.equal(req.body.threadId, 'parent-thread-42');

    // Auth header sent correctly
    assert.equal(req.headers['x-api-key'], 'secret-test-key');
    assert.equal(req.headers['content-type'], 'application/json');
  } finally {
    delete process.env[envKey];
    cleanup();
    await mock.stop();
  }
});

test('delegateToPersona: omits threadId from body when threadId is not provided', async () => {
  const mock = await startMockServer([
    {
      method: 'POST',
      path: '/api/chat',
      response: { response: 'Done.', threadId: 'new-thread' },
    },
  ]);

  const envKey = 'POPE_TEST_REMOTE_KEY_DEF';
  process.env[envKey] = 'any-key';

  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      remote_worker: {
        file: 'personas/worker.md',
        remoteUrl: `http://127.0.0.1:${mock.port}`,
        remoteApiKeyEnv: envKey,
      },
    },
  });

  try {
    await delegateToPersona('remote_worker', 'Quick task', undefined, { registryPath: registryFile });

    assert.equal(mock.captured.length, 1);
    // threadId should be absent (undefined drops out of JSON.stringify)
    assert.equal(mock.captured[0].body.threadId, undefined);
  } finally {
    delete process.env[envKey];
    cleanup();
    await mock.stop();
  }
});

test('delegateToPersona: falls back to API_KEY when remoteApiKeyEnv is not specified', async () => {
  const mock = await startMockServer([
    { method: 'POST', path: '/api/chat', response: { response: 'ok' } },
  ]);

  const savedKey = process.env.API_KEY;
  process.env.API_KEY = 'default-api-key';

  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      remote_worker: {
        file: 'personas/worker.md',
        remoteUrl: `http://127.0.0.1:${mock.port}`,
        // no remoteApiKeyEnv — should fall back to API_KEY
      },
    },
  });

  try {
    await delegateToPersona('remote_worker', 'test', undefined, { registryPath: registryFile });
    assert.equal(mock.captured[0].headers['x-api-key'], 'default-api-key');
  } finally {
    if (savedKey !== undefined) process.env.API_KEY = savedKey;
    else delete process.env.API_KEY;
    cleanup();
    await mock.stop();
  }
});

test('delegateToPersona: handles non-JSON response from remote bot gracefully', async () => {
  // Spin up a plain-text server
  const plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('plain text response');
  });
  await new Promise((r) => plainServer.listen(0, '127.0.0.1', r));
  const { port } = plainServer.address();
  const stopPlain = () => {
    plainServer.closeAllConnections();
    return new Promise((r) => plainServer.close(r));
  };

  const envKey = 'POPE_TEST_REMOTE_KEY_GHI';
  process.env[envKey] = 'any';

  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      plain_worker: {
        file: 'personas/worker.md',
        remoteUrl: `http://127.0.0.1:${port}`,
        remoteApiKeyEnv: envKey,
      },
    },
  });

  try {
    const result = await delegateToPersona('plain_worker', 'test', undefined, { registryPath: registryFile });
    // Falls back to { response: rawBodyText }
    assert.equal(result.response, 'plain text response');
  } finally {
    delete process.env[envKey];
    cleanup();
    await stopPlain();
  }
});

test('delegateToPersona: returns error object when remote server is unreachable', async () => {
  // Port 1 is reserved — nothing should be listening there
  const envKey = 'POPE_TEST_REMOTE_KEY_JKL';
  process.env[envKey] = 'any';

  const { dir, registryFile, cleanup } = makeTempPersonasDir({
    registry: {
      dead_worker: {
        file: 'personas/worker.md',
        remoteUrl: 'http://127.0.0.1:1',
        remoteApiKeyEnv: envKey,
      },
    },
  });

  try {
    const result = await delegateToPersona('dead_worker', 'test', undefined, { registryPath: registryFile });
    assert.ok(result.error, 'should return error object on network failure');
    assert.match(result.error, /Remote delegation failed/i);
  } finally {
    delete process.env[envKey];
    cleanup();
  }
});
