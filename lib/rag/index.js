import Database from 'better-sqlite3';
import { thepopebotDb } from '../paths.js';
import { sanitizeFtsQuery } from './utils.js';

export { isRagEnabled, sanitizeFtsQuery, formatResults } from './utils.js';

let _db = null;

/**
 * Lazy singleton — direct better-sqlite3 connection for raw FTS5 queries.
 * A separate connection from the Drizzle ORM instance is fine with WAL mode.
 */
function getDb() {
  if (!_db) {
    _db = new Database(thepopebotDb);
  }
  return _db;
}

/**
 * Search past chat messages using SQLite FTS5 full-text search.
 *
 * Returns results ranked by FTS5 relevance (best matches first).
 * Each result includes a highlighted snippet showing where the match occurred.
 *
 * @param {string} query - Search terms (plain text, not FTS5 syntax)
 * @param {object} [options]
 * @param {number} [options.limit=5] - Max results to return
 * @param {string} [options.excludeChatId] - Skip results from this chat (e.g. current chat)
 * @returns {Array<{id, chatId, chatTitle, role, snippet, createdAt}>}
 */
export function searchChatHistory(query, { limit = 5, excludeChatId } = {}) {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const db = getDb();

  try {
    let stmt;
    let rows;

    if (excludeChatId) {
      stmt = db.prepare(`
        SELECT m.id,
               m.chat_id,
               c.title   AS chat_title,
               m.role,
               m.created_at,
               snippet(messages_fts, 0, '**', '**', '...', 32) AS snippet
        FROM messages m
        JOIN chats c          ON c.id = m.chat_id
        JOIN messages_fts     ON messages_fts.rowid = m.rowid
        WHERE messages_fts MATCH ?
          AND m.chat_id != ?
        ORDER BY rank
        LIMIT ?
      `);
      rows = stmt.all(ftsQuery, excludeChatId, limit);
    } else {
      stmt = db.prepare(`
        SELECT m.id,
               m.chat_id,
               c.title   AS chat_title,
               m.role,
               m.created_at,
               snippet(messages_fts, 0, '**', '**', '...', 32) AS snippet
        FROM messages m
        JOIN chats c          ON c.id = m.chat_id
        JOIN messages_fts     ON messages_fts.rowid = m.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      rows = stmt.all(ftsQuery, limit);
    }

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      role: row.role,
      snippet: row.snippet,
      createdAt: row.created_at, // milliseconds since epoch (Date.now())
    }));
  } catch (err) {
    // FTS table may not exist on older installs before migration — fail gracefully
    if (err.message?.includes('no such table')) {
      console.warn('[rag] messages_fts table not found — run migrations to enable chat history search');
      return [];
    }
    throw err;
  }
}
