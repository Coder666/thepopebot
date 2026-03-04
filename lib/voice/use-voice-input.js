'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Reusable voice input hook using AssemblyAI real-time transcription.
 *
 * @param {Object} options
 * @param {() => Promise<{token?: string, error?: string}>} options.getToken - Async function returning a temporary token
 * @param {(text: string) => void} options.onTranscript - Called with finalized transcript text
 * @param {(error: string) => void} [options.onError] - Called on errors
 * @returns {{ isRecording: boolean, startRecording: () => void, stopRecording: () => void }}
 */
export function useVoiceInput({ getToken, onTranscript, onError }) {
  const [isRecording, setIsRecording] = useState(false);
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const cleaningUpRef = useRef(false);

  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'Terminate' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsRecording(false);
    cleaningUpRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const startRecording = useCallback(async () => {
    if (isRecording) return;

    try {
      const result = await getToken();
      if (result.error) {
        onError?.(result.error);
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      const ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?token=${result.token}&sample_rate=16000&format_turns=true&encoding=pcm_s16le`
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(int16.buffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'Turn' && data.turn_is_formatted === true) {
            const text = data.transcript?.trim();
            if (text) onTranscript(text);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        onError?.('Voice connection error');
        cleanup();
      };

      ws.onclose = () => {
        cleanup();
      };
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        onError?.('Microphone permission denied');
      } else {
        onError?.('Failed to start voice input');
      }
      cleanup();
    }
  }, [isRecording, getToken, onTranscript, onError, cleanup]);

  const stopRecording = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { isRecording, startRecording, stopRecording };
}
