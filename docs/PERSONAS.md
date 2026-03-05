# Personas

Personas let you give your bot different identities, roles, and behaviours. A single bot can switch between personas per chat, or you can wire multiple separate bot instances together so they delegate work to each other over HTTP.

---

## Configuration

### `config/PERSONAS.json`

Registry of all available personas. Example:

```json
{
  "default": {
    "file": "personas/default.md",
    "description": "Default bot personality — diligent generalist"
  },
  "manager": {
    "file": "personas/manager.md",
    "description": "Coordinates work and delegates to subordinates",
    "subordinates": ["worker"]
  },
  "worker": {
    "file": "personas/worker.md",
    "description": "Focused executor that carries out delegated tasks",
    "reportsTo": "manager"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | Path to the persona markdown file, relative to `config/personas/` |
| `description` | no | Human-readable summary |
| `subordinates` | no | Persona names this persona may delegate to |
| `reportsTo` | no | Parent persona in the hierarchy |
| `remoteUrl` | no | Base URL of a remote bot instance to delegate to |
| `remoteApiKeyEnv` | no | Env var name containing the API key for the remote instance (default: `API_KEY`) |

### Persona files

Markdown files in `config/personas/`. Their content is injected into the bot's system prompt as `{{soul}}` — prepended before all task instructions.

Example `config/personas/manager.md`:

```markdown
# Manager Persona

## Identity

You are a strategic coordinator. You break complex goals into clear tasks
and delegate them to specialised subordinates.

## Working Style

- Think before delegating — understand the full scope first
- Use the `delegate_to_persona` tool for sub-tasks
- Synthesise all results before responding to the user
```

---

## How It Works

### The `{{soul}}` variable

`config/JOB_PLANNING.md` starts with `{{soul}}`. When the agent is invoked, that placeholder is replaced with the active persona's markdown content, producing a persona-specific system prompt. Each persona gets its own cached agent instance — same tools, different identity.

### Persona-aware agent cache

`getAgent(personaId)` maintains a `Map` keyed by persona ID. The first call for a given persona builds and caches the agent; subsequent calls return the cached instance. The `resetAgent()` export clears the cache (useful after config changes).

### The `delegate_to_persona` tool

Every agent has a `delegate_to_persona` tool. Given a target persona name and a message, it:

1. Looks up the persona in `PERSONAS.json`
2. If the persona has a `remoteUrl` → makes a `POST /api/chat` request to the remote bot instance, authenticated with `x-api-key`
3. Otherwise → runs the persona in-process as a local LangGraph agent

---

## Hierarchical Delegation

### Local (in-process)

Both personas run inside the same process. Useful for a manager/worker split within a single bot instance:

```json
{
  "manager": {
    "file": "personas/manager.md",
    "subordinates": ["worker"]
  },
  "worker": {
    "file": "personas/worker.md",
    "reportsTo": "manager"
  }
}
```

The manager agent calls `delegate_to_persona("worker", "Summarise the last 5 PRs")`. A worker agent runs inline and returns its response. Thread ID is scoped (`{parentThreadId}:{personaId}`) to keep conversation context separate.

### Remote (bot-to-bot)

The worker persona lives on a separate thepopebot instance:

```json
{
  "worker": {
    "file": "personas/worker.md",
    "remoteUrl": "https://worker-bot.example.com",
    "remoteApiKeyEnv": "WORKER_BOT_API_KEY"
  }
}
```

When the manager delegates to `"worker"`, the event handler POSTs to `https://worker-bot.example.com/api/chat`:

```json
{ "message": "Summarise the last 5 PRs", "threadId": "parent-thread:worker", "personaId": "worker" }
```

The remote bot processes the message with its own agent and responds:

```json
{ "response": "Here is the summary…", "threadId": "parent-thread:worker" }
```

Set the API key as a secret so the calling bot can authenticate:

```bash
npx thepopebot set-agent-llm-secret WORKER_BOT_API_KEY <key>
```

---

## Bot-to-Bot API

### `POST /api/chat`

Machine-to-machine endpoint. Authenticated via `x-api-key` (same as all other `/api` routes).

**Request**

```json
{
  "message": "Do the thing",
  "threadId": "optional-thread-id-for-continuity",
  "personaId": "worker"
}
```

**Response**

```json
{
  "response": "Done. Here are the results…",
  "threadId": "optional-thread-id-for-continuity"
}
```

If `threadId` is omitted a new thread is created (`api-chat-<timestamp>`). Re-use the same `threadId` across calls to maintain conversation context.

---

## Adding a New Persona

1. Create `config/personas/my-persona.md` — write the identity and instructions
2. Add an entry to `config/PERSONAS.json`
3. The persona is available immediately — no restart required

To activate a persona for a web chat, pass `personaId` in the request body to `/stream/chat`. To use it via the bot-to-bot API, pass `personaId` in the `POST /api/chat` body.

---

## Security Notes

- `/api/chat` uses the same `x-api-key` authentication as all other `/api` routes — generate keys through the admin UI
- Remote API keys are read from env vars (never hard-coded in `PERSONAS.json`)
- Delegation is fire-and-respond; the calling agent waits for the delegated agent's response before continuing
