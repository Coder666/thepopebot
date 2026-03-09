/**
 * Tests for config/index.js — withThepopebot() Next.js config wrapper.
 *
 * Key invariant: 'thepopebot' must NOT appear in serverExternalPackages.
 * When it is listed as external, Next.js skips webpack processing of the
 * package and cannot see 'use client' boundaries, causing useContext errors
 * at runtime.  Only native-binding packages (better-sqlite3, drizzle-orm)
 * should be external.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { withThepopebot } = await import('../config/index.js');

test('withThepopebot returns a config object', () => {
  const cfg = withThepopebot({});
  assert.ok(cfg && typeof cfg === 'object', 'config must be an object');
});

test('serverExternalPackages does NOT contain thepopebot', () => {
  const cfg = withThepopebot({});
  assert.ok(
    Array.isArray(cfg.serverExternalPackages),
    'serverExternalPackages must be an array'
  );
  assert.ok(
    !cfg.serverExternalPackages.includes('thepopebot'),
    `thepopebot must not be in serverExternalPackages — found: [${cfg.serverExternalPackages.join(', ')}]`
  );
});

test('serverExternalPackages includes better-sqlite3', () => {
  const cfg = withThepopebot({});
  assert.ok(
    cfg.serverExternalPackages.includes('better-sqlite3'),
    'better-sqlite3 must be external (native bindings)'
  );
});

test('serverExternalPackages includes drizzle-orm', () => {
  const cfg = withThepopebot({});
  assert.ok(
    cfg.serverExternalPackages.includes('drizzle-orm'),
    'drizzle-orm must be external (native bindings)'
  );
});

test('user serverExternalPackages are merged in', () => {
  const cfg = withThepopebot({ serverExternalPackages: ['my-native-pkg'] });
  assert.ok(
    cfg.serverExternalPackages.includes('my-native-pkg'),
    'user-supplied externals must be preserved'
  );
  assert.ok(
    cfg.serverExternalPackages.includes('better-sqlite3'),
    'built-in externals must still be present after merge'
  );
});

test('distDir defaults to .next', () => {
  delete process.env.NEXT_BUILD_DIR;
  const cfg = withThepopebot({});
  assert.equal(cfg.distDir, '.next');
});

test('distDir uses NEXT_BUILD_DIR env var when set', () => {
  process.env.NEXT_BUILD_DIR = '/tmp/custom-next';
  const cfg = withThepopebot({});
  assert.equal(cfg.distDir, '/tmp/custom-next');
  delete process.env.NEXT_BUILD_DIR;
});

test('user nextConfig properties are spread into result', () => {
  const cfg = withThepopebot({ reactStrictMode: true, poweredByHeader: false });
  assert.equal(cfg.reactStrictMode, true);
  assert.equal(cfg.poweredByHeader, false);
});

test('env object is merged with user env', () => {
  const cfg = withThepopebot({ env: { MY_VAR: 'hello' } });
  assert.equal(cfg.env.MY_VAR, 'hello', 'user env vars must be preserved');
  assert.ok('NEXT_PUBLIC_CODE_WORKSPACE' in cfg.env, 'built-in env vars must be present');
});
