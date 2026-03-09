/**
 * lib/channels/telegram-polling.js — Long-polling alternative to webhooks.
 *
 * When TELEGRAM_MODE=polling, this module polls the Telegram Bot API for
 * updates instead of requiring a public HTTPS endpoint. Messages are
 * routed through the same TelegramAdapter → processChannelMessage pipeline
 * as webhook mode.
 *
 * Usage:
 *   import { startPolling, stopPolling } from './telegram-polling.js';
 *   startPolling(botToken, processChannelMessage);
 *
 * The polling loop runs in the same Node.js process — no separate service
 * or runner is required.
 */

import { getTelegramAdapter } from './index.js';

let _polling = false;
let _timeout = null;
let _offset = 0;

/**
 * Start long-polling for Telegram updates.
 *
 * @param {string} botToken   - Telegram bot token
 * @param {Function} onMessage - async (adapter, normalizedMessage) => void
 *                               Same signature as processChannelMessage in api/index.js
 */
export function startPolling(botToken, onMessage) {
  if (_polling) {
    console.log('[telegram-polling] Already running');
    return;
  }

  _polling = true;
  console.log('[telegram-polling] Starting long-polling mode');

  // Delete any existing webhook so getUpdates works
  // (Telegram ignores getUpdates while a webhook is set)
  fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, { method: 'POST' })
    .then(r => r.json())
    .then(r => {
      if (r.ok) console.log('[telegram-polling] Cleared webhook');
      else console.warn('[telegram-polling] deleteWebhook:', r.description);
    })
    .catch(err => console.warn('[telegram-polling] deleteWebhook error:', err.message));

  poll(botToken, onMessage);
}

/**
 * Stop the polling loop.
 */
export function stopPolling() {
  _polling = false;
  if (_timeout) {
    clearTimeout(_timeout);
    _timeout = null;
  }
  console.log('[telegram-polling] Stopped');
}

/**
 * Single poll iteration — calls getUpdates with long-polling timeout,
 * processes each update, and schedules the next iteration.
 */
async function poll(botToken, onMessage) {
  if (!_polling) return;

  try {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?` +
      `offset=${_offset}&timeout=25&allowed_updates=["message","edited_message"]`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(35_000), // 25s long-poll + 10s buffer
    });
    const data = await res.json();

    if (data.ok && data.result && data.result.length > 0) {
      for (const update of data.result) {
        _offset = update.update_id + 1;

        // Build a minimal Request-like object that TelegramAdapter.receive() expects
        const fakeRequest = {
          json: async () => update,
          headers: new Headers({
            'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET || '',
          }),
        };

        const adapter = getTelegramAdapter(botToken);
        try {
          const normalized = await adapter.receive(fakeRequest);
          if (normalized) {
            // Process asynchronously — same as webhook handler
            onMessage(adapter, normalized).catch(err => {
              console.error('[telegram-polling] Message processing error:', err);
            });
          }
        } catch (err) {
          console.error('[telegram-polling] Error handling update:', err);
        }
      }
    }
  } catch (err) {
    // Network errors, timeouts — back off briefly then retry
    if (err.name !== 'TimeoutError') {
      console.error('[telegram-polling] Poll error:', err.message);
    }
  }

  // Schedule next poll (immediate on success, 2s backoff on error)
  if (_polling) {
    _timeout = setTimeout(() => poll(botToken, onMessage), 100);
  }
}
