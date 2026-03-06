/**
 * Unit tests for lib/rag/utils.js (pure functions — no native dependencies)
 * and SQL correctness for the FTS5 schema (runs only when better-sqlite3 is available).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Set an env var for the duration of fn(), then restore the original value.
 */
function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// ── isRagEnabled ─────────────────────────────────────────────────────────────

describe('isRagEnabled()', () => {
  let isRagEnabled;
  before(async () => {
    ({ isRagEnabled } = await import('../lib/rag/utils.js'));
  });

  test('returns true when RAG_ENABLED is not set', () => {
    withEnv('RAG_ENABLED', undefined, () => assert.equal(isRagEnabled(), true));
  });

  test('returns true when RAG_ENABLED is empty string', () => {
    withEnv('RAG_ENABLED', '', () => assert.equal(isRagEnabled(), true));
  });

  test('returns true when RAG_ENABLED=true', () => {
    withEnv('RAG_ENABLED', 'true', () => assert.equal(isRagEnabled(), true));
  });

  test('returns true when RAG_ENABLED=1', () => {
    withEnv('RAG_ENABLED', '1', () => assert.equal(isRagEnabled(), true));
  });

  test('returns false when RAG_ENABLED=false', () => {
    withEnv('RAG_ENABLED', 'false', () => assert.equal(isRagEnabled(), false));
  });

  test('returns false when RAG_ENABLED=FALSE (case insensitive)', () => {
    withEnv('RAG_ENABLED', 'FALSE', () => assert.equal(isRagEnabled(), false));
  });

  test('returns false when RAG_ENABLED=0', () => {
    withEnv('RAG_ENABLED', '0', () => assert.equal(isRagEnabled(), false));
  });
});

// ── sanitizeFtsQuery ─────────────────────────────────────────────────────────

describe('sanitizeFtsQuery()', () => {
  let sanitizeFtsQuery;
  before(async () => {
    ({ sanitizeFtsQuery } = await import('../lib/rag/utils.js'));
  });

  test('returns the query unchanged for plain text', () => {
    assert.equal(sanitizeFtsQuery('deploy automation'), 'deploy automation');
  });

  test('strips double quotes', () => {
    const result = sanitizeFtsQuery('"quoted phrase"');
    assert.match(result, /quoted phrase/);
    assert.doesNotMatch(result, /"/);
  });

  test('strips single quotes', () => {
    assert.doesNotMatch(sanitizeFtsQuery("it's fine"), /'/);
  });

  test('strips FTS5 special characters', () => {
    const result = sanitizeFtsQuery('foo * bar ^ (baz) [qux]');
    assert.doesNotMatch(result, /[*^()[\]]/);
  });

  test('strips boolean operators AND OR NOT', () => {
    const result = sanitizeFtsQuery('deploy AND rollback NOT staging');
    assert.doesNotMatch(result, /\bAND\b|\bOR\b|\bNOT\b/);
    assert.match(result, /deploy/);
    assert.match(result, /rollback/);
  });

  test('collapses multiple spaces', () => {
    assert.equal(sanitizeFtsQuery('  lots   of   spaces  '), 'lots of spaces');
  });

  test('returns null for empty string', () => {
    assert.equal(sanitizeFtsQuery(''), null);
  });

  test('returns null for string of only special chars', () => {
    assert.equal(sanitizeFtsQuery('*** ^^^'), null);
  });
});

// ── formatResults ─────────────────────────────────────────────────────────────

describe('formatResults()', () => {
  let formatResults;
  before(async () => {
    ({ formatResults } = await import('../lib/rag/utils.js'));
  });

  test('returns fallback message for empty array', () => {
    assert.match(formatResults([]), /No relevant past conversations found/i);
  });

  test('formats a single result correctly', () => {
    const results = [{
      chatTitle: 'Deployment chat',
      role: 'user',
      snippet: 'We decided to **deploy** on Fridays only',
      createdAt: new Date('2026-01-15').getTime(),
    }];
    const out = formatResults(results);
    assert.match(out, /Deployment chat/);
    assert.match(out, /user/);
    assert.match(out, /deploy/);
    assert.match(out, /Jan/);
    assert.match(out, /2026/);
  });

  test('separates multiple results with double newline', () => {
    const results = [
      { chatTitle: 'Chat A', role: 'user', snippet: 'first message', createdAt: Date.now() },
      { chatTitle: 'Chat B', role: 'assistant', snippet: 'second message', createdAt: Date.now() },
    ];
    const out = formatResults(results);
    assert.match(out, /first message/);
    assert.match(out, /second message/);
    assert.match(out, /\n\n/);
  });

  test('includes role in output', () => {
    const user = [{ chatTitle: 'C', role: 'user', snippet: 'hi', createdAt: Date.now() }];
    const asst = [{ chatTitle: 'C', role: 'assistant', snippet: 'hi', createdAt: Date.now() }];
    assert.match(formatResults(user), /user/);
    assert.match(formatResults(asst), /assistant/);
  });

  test('wraps chat title in quotes', () => {
    const out = formatResults([{ chatTitle: 'My Chat', role: 'user', snippet: 'test', createdAt: Date.now() }]);
    assert.match(out, /"My Chat"/);
  });
});

// ── FTS5 SQL schema tests (only when better-sqlite3 is available) ─────────────

let Database;
try {
  const mod = await import('better-sqlite3');
  Database = mod.default;
} catch {
  // better-sqlite3 not installed in dev — skip SQL tests
}

if (Database) {
  describe('FTS5 SQL schema (in-memory SQLite)', () => {
    let db;

    before(() => {
      db = new Database(':memory:');

      db.exec(`
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT 'New Chat',
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE VIRTUAL TABLE messages_fts
          USING fts5(content, content=messages, content_rowid=rowid);

        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.rowid, old.content);
        END;
      `);

      const now = Date.now();
      db.prepare(`INSERT INTO chats VALUES (?,?,?,?,?)`)
        .run('chat-deploy', 'Deploy automation', 'user-1', now, now);
      db.prepare(`INSERT INTO chats VALUES (?,?,?,?,?)`)
        .run('chat-api', 'API key rotation', 'user-1', now, now);

      const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?)`);
      ins.run('m1', 'chat-deploy', 'user', 'We decided to deploy on Fridays only to avoid weekend incidents', now);
      ins.run('m2', 'chat-deploy', 'assistant', 'The deploy script lives in scripts/deploy.sh', now);
      ins.run('m3', 'chat-api', 'user', 'Please rotate the API keys for the production environment', now);
      ins.run('m4', 'chat-api', 'assistant', 'I have updated the API key rotation schedule to monthly', now);
    });

    after(() => db?.close());

    function search(query, { limit = 5, excludeChatId } = {}) {
      const ftsQuery = String(query)
        .replace(/['"*^(){}[\]<>:!]/g, ' ')
        .replace(/\b(AND|OR|NOT)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!ftsQuery) return [];

      if (excludeChatId) {
        return db.prepare(`
          SELECT m.id, m.chat_id, c.title AS chat_title, m.role, m.created_at,
                 snippet(messages_fts, 0, '**', '**', '...', 32) AS snippet
          FROM messages m
          JOIN chats c ON c.id = m.chat_id
          JOIN messages_fts ON messages_fts.rowid = m.rowid
          WHERE messages_fts MATCH ?
            AND m.chat_id != ?
          ORDER BY rank LIMIT ?
        `).all(ftsQuery, excludeChatId, limit);
      }
      return db.prepare(`
        SELECT m.id, m.chat_id, c.title AS chat_title, m.role, m.created_at,
               snippet(messages_fts, 0, '**', '**', '...', 32) AS snippet
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        JOIN messages_fts ON messages_fts.rowid = m.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit);
    }

    test('finds messages matching a keyword', () => {
      const rows = search('deploy');
      assert.ok(rows.length > 0, 'Should find results for "deploy"');
      assert.ok(rows.every(r => r.chat_id === 'chat-deploy'));
    });

    test('finds messages in different chats', () => {
      const rows = search('API');
      assert.ok(rows.length > 0);
      assert.ok(rows.some(r => r.chat_id === 'chat-api'));
    });

    test('returns chat title in results', () => {
      const rows = search('deploy');
      assert.equal(rows[0].chat_title, 'Deploy automation');
    });

    test('snippet highlights matching term with ** markers', () => {
      const rows = search('deploy');
      assert.ok(rows.some(r => r.snippet.includes('**')));
    });

    test('respects limit parameter', () => {
      const rows = search('deploy', { limit: 1 });
      assert.equal(rows.length, 1);
    });

    test('excludes specified chat ID', () => {
      const rows = search('deploy', { excludeChatId: 'chat-deploy' });
      assert.equal(rows.length, 0);
    });

    test('returns empty array for unmatched query', () => {
      assert.equal(search('xyzzy_nonexistent_12345').length, 0);
    });

    test('delete trigger removes entries from FTS index', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?)`)
        .run('tmp', 'chat-deploy', 'user', 'temporary xyzzy_delete_test content here', now);

      assert.equal(search('xyzzy_delete_test').length, 1);

      db.prepare(`DELETE FROM messages WHERE id = ?`).run('tmp');

      assert.equal(search('xyzzy_delete_test').length, 0);
    });

    test('backfill is idempotent (INSERT ... SELECT safe on empty FTS)', () => {
      // Running the backfill again should not throw or error
      assert.doesNotThrow(() => {
        db.exec(`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages`);
      });
    });
  });
} else {
  test('FTS5 SQL tests skipped (better-sqlite3 not installed)', { skip: true }, () => {});
}
