# config/ — Configuration Files

## Template Config Files

Users customize behavior through these files in `config/`:

- `SOUL.md` — Agent personality/identity
- `JOB_PLANNING.md` — Event handler system prompt (supports `{{skills}}`, `{{web_search}}`, `{{datetime}}`)
- `CODE_PLANNING.md` — Code workspace system prompt
- `CRONS.json`, `TRIGGERS.json` — Scheduled jobs and webhook triggers

## Markdown File Includes

Markdown files in `config/` support includes and built-in variables, powered by `lib/utils/render-md.js`.

- **File includes**: `{{ filepath.md }}` — resolves relative to project root, recursive with circular detection. Missing files are left as-is.
- **`{{datetime}}`** — Current ISO timestamp.
- **`{{skills}}`** — Dynamic bullet list of active skill descriptions from `skills/active/*/SKILL.md` frontmatter. Never hardcode skill names — this is resolved at runtime.
- **`{{web_search}}`** — Conditionally includes `config/WEB_SEARCH_AVAILABLE.md` or `config/WEB_SEARCH_UNAVAILABLE.md` based on provider support.

## Next.js Config Wrapper (index.js)

`withThepopebot()` wraps user's `next.config.mjs`. Adds `transpilePackages` and `serverExternalPackages` for the npm package's dependencies that need special bundling.

## Instrumentation (instrumentation.js)

Server startup hook loaded by Next.js. Sequence: loads `.env`, initializes database, starts cron scheduler, starts cluster runtime. Skipped during `next build` (checks `NEXT_PHASE`).
