# lib/channels/ — Channel Adapters

## ChannelAdapter Base Class (base.js)

Abstract interface for platform integrations. Methods:

| Method | Purpose | Returns |
|--------|---------|---------|
| `receive(request)` | Parse webhook → normalized message | `{ threadId, text, attachments, metadata }` or `null` |
| `acknowledge(metadata)` | Show receipt (e.g. emoji reaction) | void |
| `startProcessingIndicator(metadata)` | Show typing/processing | Stop function |
| `sendResponse(threadId, text, metadata)` | Send complete response | void |
| `get supportsStreaming` | Can stream responses? | boolean |

## Attachment Handling — Images vs Audio

**Critical distinction**: Audio is preprocessed at the adapter layer. Images are passed through to the LLM.

- **Images** (`message.photo`) → Downloaded, passed as `{ category: 'image', mimeType, data: Buffer }` attachment → LLM receives as vision content
- **Audio** (`message.voice`/`message.audio`) → Transcribed via Whisper → merged into `text` field → **never passed as attachment**
- **Documents** (`message.document`) → Downloaded as `{ category: 'document', mimeType, data: Buffer }`

## Factory (index.js) — Lazy Singleton

`getTelegramAdapter(botToken)` caches a singleton keyed by `botToken`. If the token changes (rotation), a new instance is created.

## Telegram Adapter (telegram.js)

- **Chat ID filtering**: `TELEGRAM_CHAT_ID` required. Messages from other chats are silently dropped. If not configured, all messages rejected.
- **Verification flow**: If `TELEGRAM_VERIFICATION` env is set and user sends that code, bot responds with the chat ID (for initial setup).
- **Webhook auth**: Validates `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`.
- **Streaming**: `supportsStreaming` returns `false` — sends complete responses only.
