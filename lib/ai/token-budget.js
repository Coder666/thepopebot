/**
 * Token budget utilities for managing context window limits.
 *
 * Designed to work with any LLM provider — especially local models
 * (Ollama, LM Studio, llama.cpp, etc.) that have strict context windows.
 *
 * Token counting uses a character-based approximation (1 token ≈ 4 chars)
 * that requires no external dependencies or network calls, making it safe
 * for offline/local-first use.
 *
 * Configure via environment variables:
 *   TOKEN_BUDGET_ENABLED   — Enable/disable the feature (default: true)
 *   CONTEXT_WINDOW         — Model context window in tokens (default: 8192)
 *   RESPONSE_RESERVE       — Tokens reserved for model response (default: 1024)
 *   MAX_TOOL_OUTPUT_CHARS  — Max characters per tool result (default: 8000)
 */

const CHARS_PER_TOKEN = 4;

export const DEFAULTS = {
  CONTEXT_WINDOW: 8192,
  RESPONSE_RESERVE: 1024,
  MAX_TOOL_OUTPUT_CHARS: 8000,
};

/**
 * Whether the token budget feature is active.
 * Reads TOKEN_BUDGET_ENABLED. Defaults to true when not set.
 * Set to "false" or "0" to disable.
 * @returns {boolean}
 */
export function isTokenBudgetEnabled() {
  const val = process.env.TOKEN_BUDGET_ENABLED;
  if (val === undefined || val === '') return true;
  return val !== '0' && val.toLowerCase() !== 'false';
}

/**
 * Estimate the token count for a string using character-based approximation.
 * 1 token ≈ 4 characters — accurate enough for windowing without network calls.
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

/**
 * Token counter compatible with LangChain's trimMessages `tokenCounter` option.
 * Accepts an array of LangChain messages and returns total estimated token count.
 * @param {Array<{content: string | unknown[]}>} messages
 * @returns {number}
 */
export function messageTokenCounter(messages) {
  return messages.reduce((sum, m) => {
    const content =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + countTokens(content);
  }, 0);
}

/**
 * Get the configured context window size in tokens.
 * Reads CONTEXT_WINDOW env var. Defaults to 8192.
 * @returns {number}
 */
export function getContextWindow() {
  return parseInt(
    process.env.CONTEXT_WINDOW || String(DEFAULTS.CONTEXT_WINDOW),
    10
  );
}

/**
 * Get the number of tokens to reserve for the model's response.
 * Reads RESPONSE_RESERVE env var. Defaults to 1024.
 * @returns {number}
 */
export function getResponseReserve() {
  return parseInt(
    process.env.RESPONSE_RESERVE || String(DEFAULTS.RESPONSE_RESERVE),
    10
  );
}

/**
 * Get the maximum characters allowed per tool result.
 * Reads MAX_TOOL_OUTPUT_CHARS env var. Defaults to 8000.
 * @returns {number}
 */
export function getMaxToolOutputChars() {
  return parseInt(
    process.env.MAX_TOOL_OUTPUT_CHARS || String(DEFAULTS.MAX_TOOL_OUTPUT_CHARS),
    10
  );
}

/**
 * Truncate a string to maxChars, appending a marker when truncated.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncate(text, maxChars = DEFAULTS.MAX_TOOL_OUTPUT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const remaining = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n... [truncated — ${remaining} more characters not shown]`;
}
