# lib/ — Action Dispatch System

Both cron jobs and webhook triggers use the same shared dispatch system (`lib/actions.js`). Every action has a `type` field — `"agent"` (default), `"command"`, or `"webhook"`.

| | `agent` | `command` | `webhook` |
|---|---------|-----------|-----------|
| **Uses LLM** | Yes — Docker agent container | No — shell command | No — HTTP request |
| **Runtime** | Minutes to hours | Milliseconds to seconds | Milliseconds to seconds |
| **Cost** | LLM API calls + GitHub Actions | Free (runs on event handler) | Free (runs on event handler) |

If the task needs to *think*, use `agent`. If it just needs to *do*, use `command`. If it needs to *call an external service*, use `webhook`.

**Agent**: Creates a Docker Agent job via `createJob()`. Pushes a `job/*` branch; `run-job.yml` spins up the container. The `job` string is the LLM task prompt. Agent backend selected via `agent_backend` in `job.config.json`.

**Command**: Runs a shell command on the event handler. Working directory: `cron/` for crons, `triggers/` for triggers.

**Webhook**: Makes an HTTP request. `GET` skips the body; `POST` (default) sends `{ ...vars }` or `{ ...vars, data: <payload> }`.

## Cron Jobs

Defined in `config/CRONS.json`, loaded by `lib/cron.js` at startup via `node-cron`. Each entry has `name`, `schedule` (cron expression), `type` (`agent`/`command`/`webhook`), and the corresponding action fields (`job`, `command`, or `url`/`method`/`headers`/`vars`). Set `enabled: false` to disable. Agent-type entries support optional `llm_provider` and `llm_model` fields to override the default LLM (passed to Docker agent via `job.config.json`).

## Webhook Triggers

Defined in `config/TRIGGERS.json`, loaded by `lib/triggers.js`. Each trigger watches an endpoint path (`watch_path`) and fires an array of actions (fire-and-forget, after auth, before route handler). Actions use the same `type`/`job`/`command`/`url` fields as cron jobs, including optional `llm_provider`/`llm_model` overrides.

Template tokens in `job` and `command` strings: `{{body}}`, `{{body.field}}`, `{{query}}`, `{{query.field}}`, `{{headers}}`, `{{headers.field}}`.
