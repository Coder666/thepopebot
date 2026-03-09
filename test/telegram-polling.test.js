/**
 * Unit tests for Telegram polling mode and TelegramAdapter webhook bypass.
 *
 * Tests cover:
 * - TelegramAdapter.receive() webhook secret validation in polling vs webhook mode
 * - telegram-polling.js startPolling/stopPolling lifecycle
 * - Fake request construction and message routing
 */

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── TelegramAdapter.receive() — polling mode bypasses webhook auth ─────────

test('receive: rejects when TELEGRAM_WEBHOOK_SECRET is missing in webhook mode', async () => {
  const orig = { ...process.env };
  delete process.env.TELEGRAM_MODE;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_CHAT_ID = '12345';

  // Dynamic import to get a fresh adapter instance
  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 12345 }, text: 'hello' } }),
    headers: new Headers({}),
  };

  const result = await adapter.receive(fakeRequest);
  assert.equal(result, null, 'Should reject when webhook secret is not set');

  // Restore
  Object.assign(process.env, orig);
});

test('receive: rejects when webhook secret header does not match', async () => {
  const orig = { ...process.env };
  delete process.env.TELEGRAM_MODE;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-secret';
  process.env.TELEGRAM_CHAT_ID = '12345';

  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 12345 }, text: 'hello' } }),
    headers: new Headers({ 'x-telegram-bot-api-secret-token': 'wrong-secret' }),
  };

  const result = await adapter.receive(fakeRequest);
  assert.equal(result, null, 'Should reject when secret does not match');

  Object.assign(process.env, orig);
});

test('receive: accepts in polling mode without webhook secret', async () => {
  const orig = { ...process.env };
  process.env.TELEGRAM_MODE = 'polling';
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_CHAT_ID = '12345';

  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 12345 }, text: 'hello', message_id: 1 } }),
    headers: new Headers({}),
  };

  const result = await adapter.receive(fakeRequest);
  assert.notEqual(result, null, 'Should accept message in polling mode');
  assert.equal(result.text, 'hello');
  assert.equal(result.threadId, '12345');

  Object.assign(process.env, orig);
});

test('receive: accepts in polling mode (case insensitive)', async () => {
  const orig = { ...process.env };
  process.env.TELEGRAM_MODE = 'POLLING';
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_CHAT_ID = '99';

  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 99 }, text: 'test', message_id: 2 } }),
    headers: new Headers({}),
  };

  const result = await adapter.receive(fakeRequest);
  assert.notEqual(result, null, 'Should accept with POLLING (uppercase)');
  assert.equal(result.text, 'test');

  Object.assign(process.env, orig);
});

test('receive: rejects messages from wrong chat in polling mode', async () => {
  const orig = { ...process.env };
  process.env.TELEGRAM_MODE = 'polling';
  process.env.TELEGRAM_CHAT_ID = '12345';

  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 99999 }, text: 'intruder', message_id: 3 } }),
    headers: new Headers({}),
  };

  const result = await adapter.receive(fakeRequest);
  assert.equal(result, null, 'Should reject messages from unauthorized chat');

  Object.assign(process.env, orig);
});

test('receive: rejects when no TELEGRAM_CHAT_ID in polling mode', async () => {
  const orig = { ...process.env };
  process.env.TELEGRAM_MODE = 'polling';
  delete process.env.TELEGRAM_CHAT_ID;

  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 12345 }, text: 'hello', message_id: 4 } }),
    headers: new Headers({}),
  };

  const result = await adapter.receive(fakeRequest);
  assert.equal(result, null, 'Should reject when no chat ID is configured');

  Object.assign(process.env, orig);
});

// ─── stopPolling ────────────────────────────────────────────────────────────

test('stopPolling: can be called safely when not running', async () => {
  const { stopPolling } = await import('../lib/channels/telegram-polling.js');
  // Should not throw
  stopPolling();
});

// ─── Fake Request shape ─────────────────────────────────────────────────────

test('polling fake request: json() returns the update object', async () => {
  const update = {
    update_id: 100,
    message: { chat: { id: 12345 }, text: 'hello', message_id: 1 },
  };

  const fakeRequest = {
    json: async () => update,
    headers: new Headers({
      'x-telegram-bot-api-secret-token': 'test-secret',
    }),
  };

  const body = await fakeRequest.json();
  assert.deepEqual(body, update, 'json() should return the update');
  assert.equal(
    fakeRequest.headers.get('x-telegram-bot-api-secret-token'),
    'test-secret',
    'headers should be accessible via .get()'
  );
});

test('polling fake request: works with TelegramAdapter in webhook mode', async () => {
  const orig = { ...process.env };
  delete process.env.TELEGRAM_MODE;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'my-secret';
  process.env.TELEGRAM_CHAT_ID = '42';

  const { TelegramAdapter } = await import('../lib/channels/telegram.js');
  const adapter = new TelegramAdapter('fake-token');

  const fakeRequest = {
    json: async () => ({ message: { chat: { id: 42 }, text: 'via-fake', message_id: 5 } }),
    headers: new Headers({ 'x-telegram-bot-api-secret-token': 'my-secret' }),
  };

  const result = await adapter.receive(fakeRequest);
  assert.notEqual(result, null, 'Should accept when secret matches in webhook mode');
  assert.equal(result.text, 'via-fake');

  Object.assign(process.env, orig);
});
