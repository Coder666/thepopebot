# Chat History Search (RAG)

The agent can search past conversations using full-text search over the message history stored in SQLite. This lets the agent recall context from previous chats without having to keep all history in the context window.

## How it works

1. **Indexing** — A SQLite FTS5 virtual table (`messages_fts`) sits alongside the `messages` table. An `AFTER INSERT` trigger automatically indexes every new message. Existing messages are backfilled when the migration runs on first startup.

2. **Search** — The agent has a `search_chat_history` tool it can call when it needs to look something up from a past conversation. Results are ranked by FTS5 relevance and returned as annotated snippets.

3. **Cleanup** — An `AFTER DELETE` trigger removes entries from the FTS index when messages are deleted, keeping the index consistent.

## When the agent uses it

The agent calls `search_chat_history` when:

- The user says something like "remember when we talked about X?"
- A question refers to a past decision, project, or context
- The agent needs information it doesn't have in the current conversation thread

The agent receives results like:

```
[Mar 5, 2026 — "Deploy automation setup"] user: We decided to **deploy** on Fridays only to avoid weekend incidents...

[Feb 20, 2026 — "API key rotation"] assistant: The **deploy** script lives in scripts/deploy.sh — I updated it to pull the key from the environment...
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_ENABLED` | `true` | Set to `false` to disable the `search_chat_history` tool entirely |

## Implementation details

- **Storage**: FTS5 external content table — indexes only the token inverted index, not the raw text. The actual content is always read from `messages` at query time, so there's no data duplication.
- **No new dependencies**: FTS5 is built into SQLite. No embedding models, no vector databases, no network calls.
- **Works offline**: Fully local. Compatible with local LLMs.
- **Performance**: FTS5 queries are fast (sub-millisecond on typical chat history sizes). The index is maintained incrementally via triggers.
- **Query sanitization**: Special FTS5 syntax characters are stripped before querying, so user input cannot cause parse errors.

## Disabling

Set `RAG_ENABLED=false` in your `.env` to skip tool registration. The FTS5 table and triggers remain in place (they're low overhead) but the agent won't have access to the search tool.
