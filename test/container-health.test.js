/**
 * Container health checks for the self-hosted Docker image.
 *
 * These tests hit a running thepopebot container over HTTP and verify that
 * the key routes respond correctly.  They are skipped automatically when no
 * container is reachable, so they are safe to include in `npm test`.
 *
 * Override the base URL with:
 *   THEPOPEBOT_URL=http://myserver.local:3002 npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.THEPOPEBOT_URL || 'http://localhost:3002';

/** Probe the container once; skip all tests if unreachable. */
async function probe() {
  try {
    const res = await fetch(`${BASE_URL}/api/ping`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await probe();

// ─── /api/ping ────────────────────────────────────────────────────────────────

test('/api/ping returns 200 and Pong body', { skip: !reachable }, async () => {
  const res = await fetch(`${BASE_URL}/api/ping`);
  assert.equal(res.status, 200, `/api/ping must return 200 (got ${res.status})`);
  const body = await res.json();
  assert.ok(
    body?.message?.toLowerCase().includes('pong'),
    `body must contain pong, got: ${JSON.stringify(body)}`
  );
});

// ─── /login ───────────────────────────────────────────────────────────────────

test('/login returns 200 and renders HTML', { skip: !reachable }, async () => {
  const res = await fetch(`${BASE_URL}/login`);
  assert.equal(res.status, 200, `/login must return 200 (got ${res.status})`);
  const html = await res.text();
  assert.ok(html.includes('<html'), 'response must be HTML');
  // Verify no unhandled React errors leaked into the SSR output
  assert.ok(
    !html.includes('Application error'),
    'page must not contain "Application error"'
  );
  assert.ok(
    !html.includes('useContext'),
    'page must not contain raw useContext error text'
  );
});

// ─── / (root — auth redirect) ─────────────────────────────────────────────────

test('/ redirects unauthenticated requests (3xx)', { skip: !reachable }, async () => {
  // fetch follows redirects by default — use manual to catch the first response
  const res = await fetch(`${BASE_URL}/`, { redirect: 'manual' });
  assert.ok(
    res.status >= 300 && res.status < 400,
    `/ must redirect unauthenticated users (got ${res.status})`
  );
});

// ─── No stray React hook errors in /login ────────────────────────────────────

test('/login does not include RSC error markers', { skip: !reachable }, async () => {
  const res = await fetch(`${BASE_URL}/login`);
  const html = await res.text();
  // Next.js embeds serialised errors as E{"digest":"..."} in the RSC stream
  // when a component throws during rendering
  const errorMarkers = html.match(/:E\{"digest"/g) || [];
  assert.equal(
    errorMarkers.length,
    0,
    `Found ${errorMarkers.length} RSC error marker(s) in /login — ` +
    'a component is throwing during server render'
  );
});

// ─── Skip notice ─────────────────────────────────────────────────────────────

if (!reachable) {
  console.log(
    `[container-health] Skipping — no container reachable at ${BASE_URL}\n` +
    `  Start one first or set THEPOPEBOT_URL to override.`
  );
}
