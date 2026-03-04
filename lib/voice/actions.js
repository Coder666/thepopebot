'use server';

import { auth } from '../auth/index.js';

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  return session.user;
}

/**
 * Check if voice input is available (ASSEMBLYAI_API_KEY is set).
 */
export async function isVoiceEnabled() {
  await requireAuth();
  return !!process.env.ASSEMBLYAI_API_KEY;
}

/**
 * Get a temporary AssemblyAI streaming token.
 * Token is valid for 60 seconds (only needs to be valid at WebSocket handshake).
 */
export async function getVoiceToken() {
  await requireAuth();

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return { error: 'Voice transcription not configured' };
  }

  const res = await fetch(
    'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60',
    { headers: { Authorization: apiKey } }
  );

  if (!res.ok) {
    return { error: 'Failed to get voice token' };
  }

  const data = await res.json();
  return { token: data.token };
}
