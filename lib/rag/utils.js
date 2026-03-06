/**
 * Pure utility functions for RAG — no external dependencies.
 * Kept separate so unit tests can import these without needing better-sqlite3.
 */

/**
 * Whether RAG (chat history search) is enabled.
 * Defaults to true. Set RAG_ENABLED=false to disable.
 *
 * @returns {boolean}
 */
export function isRagEnabled() {
  const val = process.env.RAG_ENABLED;
  if (val === undefined || val === '') return true;
  return val !== '0' && val.toLowerCase() !== 'false';
}

/**
 * Sanitize a user query for safe use in FTS5 MATCH expressions.
 * Strips characters that have special meaning in FTS5 query syntax.
 *
 * @param {string} query
 * @returns {string|null} Sanitized query, or null if empty after sanitization
 */
export function sanitizeFtsQuery(query) {
  const cleaned = String(query)
    .replace(/['"*^(){}[\]<>:!]/g, ' ') // strip FTS5 special chars
    .replace(/\b(AND|OR|NOT)\b/g, ' ')   // strip boolean operators
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

/**
 * Format RAG search results into a compact string for the LLM.
 *
 * @param {Array<{chatTitle, role, snippet, createdAt}>} results
 * @returns {string}
 */
export function formatResults(results) {
  if (results.length === 0) return 'No relevant past conversations found.';

  return results
    .map((r) => {
      const date = new Date(r.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      return `[${date} — "${r.chatTitle}"] ${r.role}: ${r.snippet}`;
    })
    .join('\n\n');
}
