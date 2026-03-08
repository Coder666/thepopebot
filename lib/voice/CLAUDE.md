# lib/voice/ — Voice Input (AssemblyAI)

Real-time voice transcription using AssemblyAI's WebSocket streaming API. Requires `ASSEMBLYAI_API_KEY` env var. If missing, the voice button is hidden in the UI and `voiceAvailable` is `false`.

## getVoiceToken() — Server Action

Fetches a temporary AssemblyAI streaming token (60-second TTL). Auth via `requireAuth()`. The token only needs to be valid at WebSocket handshake time — active streams continue after expiry.

## useVoiceInput() — React Hook

```
useVoiceInput({ getToken, onTranscript, onError, onVolumeChange })
→ { voiceAvailable, isConnecting, isRecording, startRecording, stopRecording }
```

**Audio pipeline**: `getUserMedia` → `AudioContext` (16kHz) → inline `AudioWorkletProcessor` → WebSocket

**Token management**: Pre-fetches on mount so it's ready when the user clicks. Cached for 50s (10s safety margin on 60s TTL). Invalidated after use; next token refreshed in background.

**AudioWorklet (PcmProcessor)**: Buffers 4096 samples, converts Float32 → Int16 PCM, sends binary to WebSocket. Calculates RMS volume for visual feedback.

**Transcript handling**: Only fires `onTranscript()` on `{ type: 'Turn', end_of_turn: true }` messages (finalized text, not partials).

**Cleanup**: Sends `{ type: 'Terminate' }` to WebSocket, stops mic tracks, closes AudioContext, revokes Blob URL. Guards against double-clicks via `connectingRef`.

## Package Exports

- `thepopebot/voice` → `useVoiceInput` hook (client)
- `thepopebot/voice/actions` → `getVoiceToken` server action
