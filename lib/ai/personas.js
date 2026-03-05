/**
 * Standalone persona data-loading and delegation utilities.
 * No LangChain dependency — safe to import in tests and non-agent contexts.
 */

import fs from 'fs';
import path from 'path';
import { personasDir, personasFile } from '../paths.js';

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Load PERSONAS.json registry. Returns {} on missing/invalid file.
 *
 * @param {string} [overridePath] - Optional path override (for testing)
 * @returns {object}
 */
export function loadPersonasRegistry(overridePath) {
  try {
    return JSON.parse(fs.readFileSync(overridePath || personasFile, 'utf8'));
  } catch {
    return {};
  }
}

// ─── Persona content ──────────────────────────────────────────────────────────

/**
 * Load a persona's markdown content from disk.
 * Returns empty string when the persona or its file cannot be found.
 *
 * @param {string} personaId - Persona name ('default' or a registry key)
 * @param {object} [pathOverrides={}] - Optional path overrides for testing
 * @param {string} [pathOverrides.dir]  - Override for personasDir
 * @param {string} [pathOverrides.file] - Override for personasFile (PERSONAS.json path)
 * @returns {string}
 */
export function loadPersonaContent(personaId, { dir, file } = {}) {
  const pd = dir || personasDir;
  const pf = file || personasFile;

  if (!personaId || personaId === 'default') {
    const defaultPath = path.join(pd, 'default.md');
    if (fs.existsSync(defaultPath)) {
      return fs.readFileSync(defaultPath, 'utf8');
    }
    return '';
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(pf, 'utf8'));
  } catch {
    return '';
  }

  const entry = registry[personaId];
  if (!entry || !entry.file) return '';

  const personaPath = path.join(pd, entry.file.replace(/^personas\//, ''));
  if (!fs.existsSync(personaPath)) return '';

  return fs.readFileSync(personaPath, 'utf8');
}

// ─── Delegation logic ─────────────────────────────────────────────────────────

/**
 * Core delegation logic — usable independently of the LangChain tool wrapper.
 * If the target persona has a remoteUrl, POSTs to that bot's /api/chat endpoint.
 * Otherwise, delegates in-process by calling the local chat() function.
 *
 * @param {string} persona   - Persona name to delegate to
 * @param {string} message   - Task message
 * @param {string} [threadId] - Optional thread ID for continuity
 * @param {object} [opts={}]
 * @param {string} [opts.registryPath] - Override PERSONAS.json path (for testing)
 * @returns {Promise<object>} Result object (always safe to JSON.stringify)
 */
export async function delegateToPersona(persona, message, threadId, { registryPath } = {}) {
  const registry = loadPersonasRegistry(registryPath);
  const entry = registry[persona];

  if (!entry) {
    const available = Object.keys(registry).join(', ') || '(none)';
    return { error: `Unknown persona: "${persona}". Available: ${available}` };
  }

  // ── Remote delegation ─────────────────────────────────────────────────────
  if (entry.remoteUrl) {
    const apiKeyEnv = entry.remoteApiKeyEnv || 'API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      return { error: `Remote API key env var ${apiKeyEnv} is not set` };
    }

    try {
      const { default: https } = await import('https');
      const { default: http } = await import('http');

      const url = new URL('/api/chat', entry.remoteUrl);
      const body = JSON.stringify({ message, threadId: threadId || undefined, personaId: persona });

      const responseData = await new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve({ response: data });
              }
            });
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      return responseData;
    } catch (err) {
      return { error: `Remote delegation failed: ${err.message}` };
    }
  }

  // ── Local in-process delegation ───────────────────────────────────────────
  try {
    const { chat } = await import('./index.js');
    const delegateThreadId = threadId
      ? `${threadId}:${persona}`
      : `delegate:${persona}:${Date.now()}`;
    const response = await chat(delegateThreadId, message, [], { personaId: persona });
    return { response };
  } catch (err) {
    return { error: `Local delegation failed: ${err.message}` };
  }
}
