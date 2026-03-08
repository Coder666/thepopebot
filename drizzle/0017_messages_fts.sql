-- FTS5 full-text search index over messages.content for chat history RAG.
-- External content table: stores only the inverted index, joins back to `messages`
-- for content at query time — no data duplication.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content=`messages`, content_rowid=`rowid`);
--> statement-breakpoint
-- Auto-index new messages on insert
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON `messages` BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
--> statement-breakpoint
-- Remove from index when messages are deleted
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
--> statement-breakpoint
-- Backfill existing messages into the FTS index (safe on empty table)
INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM `messages`;
