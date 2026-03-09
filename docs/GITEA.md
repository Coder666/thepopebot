# Gitea Integration

thepopebot ships a `gh`-compatible shim (`lib/gh-wrapper`) that lets the Docker agent use the same `gh` CLI commands whether your repos are on GitHub or a self-hosted Gitea instance. The calling code never knows which backend it is talking to.

## Quick start

> **New to this?** See [docs/SETUP_GUIDE.md](SETUP_GUIDE.md) for a step-by-step
> walkthrough with every question explained, covering both fresh installs and
> existing Gitea instances.

### Prerequisites

```sh
# 1. Install deps first — required before the wizard can run
npm install

# 2. Run the wizard
node setup/setup-gitea.mjs
# or, if installed via npx:
node node_modules/thepopebot/setup/setup-gitea.mjs
```

> The wizard auto-runs `npm install` if it detects missing dependencies, but
> running it manually first avoids any confusion.

The wizard walks through seven steps and handles everything automatically:

| Step | What it does |
|---|---|
| **1 — Gitea instance** | **Docker mode**: writes `docker-compose.yml` + `runner-config.yaml`, starts Gitea, creates the admin user, generates a runner token, and starts the Actions runner. **Existing mode**: connects to your running Gitea and creates a PAT. |
| **2 — Repository** | Creates (or finds) the bot repository on Gitea. |
| **3 — Push** | Optionally initialises git and force-pushes the project. |
| **4 — LLM** | Selects provider, model, and API key. |
| **5 — Job image** | Published `stephengpope/thepopebot` images or a custom Docker image URL. |
| **5b — Fork source** | Git URL + branch for `rebuild-agent-image` and `sync-from-fork` workflows. |
| **6 — Apply** | Sets all repo variables and secrets; writes `.env`. |
| **7 — Web UI** | Pulls the event handler image, starts the container, and runs a self-test. |

### Flags

```sh
node setup/setup-gitea.mjs --dry-run          # print what would happen, no changes
node setup/setup-gitea.mjs --project /path    # specify project root (default: cwd)
```

### Compose directory

In Docker mode you are prompted for the directory where Gitea's compose files and data will live. The default is `./gitea-stack` (relative to the current directory). You can enter any absolute or relative path — the wizard creates it if it doesn't exist.

## How the shim works

The shim is installed at `/usr/local/bin/gh` inside the agent Docker image (shadowing the real `/usr/bin/gh`). At runtime it checks `GH_WRAPPER_BACKEND`:

| `GH_WRAPPER_BACKEND` | Behaviour |
|---|---|
| `github` (default) | Passes all arguments to the real `gh` binary |
| `gitea` | Translates the command to a Gitea REST API call, prints GitHub-compatible output |

The shim is automatically included in the `pi-coding-agent-job` and `claude-code-job` Docker images. No extra build steps are needed.

## Environment variables

Set these as Gitea repository variables/secrets (the setup wizard does this for you):

| Variable | Where | Description |
|---|---|---|
| `GH_WRAPPER_BACKEND` | Repo variable | Set to `gitea` to enable the Gitea backend |
| `AGENT_GITEA_TOKEN` | Repo **secret** | Gitea PAT — automatically unpacked as `GITEA_TOKEN` inside the agent container |

> **Note — `GITEA_URL` cannot be a repo variable.** Names starting with `GITEA_` are reserved
> by the Gitea Actions runner and are rejected with HTTP 400 if you try to set them. Instead,
> `run-job.yml` derives the URL from the built-in `github.server_url` expression and passes it
> into the agent container as `GITEA_URL`. No manual configuration needed.

Also set in your event handler `.env`:

```sh
GH_WRAPPER_BACKEND=gitea
GITEA_URL=http://gitea:3000        # internal Docker hostname when using the compose stack
GITEA_TOKEN=<your-pat>
```

### Gitea PAT scopes

Generate a token at **Settings → Applications → Access Tokens**. Required scopes:

- `read:user` — detect authenticated user for git config
- `write:repository` — PR and release operations, branch deletion
- `write:issue` — if you use issue-related workflows
- `write:actionsSecret` — set repo secrets during setup
- `write:actionsVariable` — set repo variables during setup

## Supported commands

| Command | Notes |
|---|---|
| `gh auth status` | Validates token against `/api/v1/user` |
| `gh auth login --with-token` | Reads token from stdin, validates |
| `gh auth setup-git` | Writes token to `~/.git-credentials` |
| `gh secret set NAME --repo owner/repo` | Value via stdin |
| `gh secret list --repo owner/repo` | |
| `gh variable set NAME --repo owner/repo` | Value via stdin |
| `gh api <endpoint> [-q expr]` | Raw Gitea API call |
| `gh repo view [--repo owner/repo]` | Returns `nameWithOwner`, `url`, `defaultBranchRef`, etc. |
| `gh repo create NAME [--private]` | |
| `gh pr view <number>` | |
| `gh pr list [--head branch] [--state open\|closed\|all]` | |
| `gh pr diff <number> [--name-only]` | |
| `gh pr create --title ... --body ... --base main` | |
| `gh pr merge <number\|branch> [--squash] [--delete-branch]` | |
| `gh release list` | |
| `gh release create TAG [--title ...] [--notes ...]` | |

All commands support `--json fields` and `--jq expr` / `-q expr` for output filtering.

## jq-lite

The shim uses a built-in `jq-lite` implementation. Most common expressions work:

- Field access: `.field`, `.a.b`, `.[0]`, `.[-1]`, `.[]`
- Pipe: `a | b`
- Alternative: `a // b`
- Object construction: `{key: expr, ...}`
- Array construction: `[expr]`
- String interpolation: `"\(.field) text"`
- `select(cond)`, `map(expr)`, `sort_by(expr)`
- `to_entries`, `from_entries`, `with_entries`
- `length`, `keys`, `values`, `has`, `contains`
- `tojson`, `fromjson`, `tostring`, `tonumber`

### Known jq-lite limitation: comparison operators

`==`, `!=`, `<`, `>` are not implemented. `select()` only works with truthy field checks:

```sh
# Works — passes items where .merged is truthy
gh pr list --json merged,number --jq '.[] | select(.merged) | .number'

# Does NOT work — equality check silently passes everything through
gh pr list --json state,number --jq '.[] | select(.state == "open") | .number'
```

As a workaround, use `--state open|closed` flags directly instead of jq filtering on state.

## Known issues

### Underscore parameters in Gitea 1.25

Gitea 1.25 has a bug where API endpoints silently ignore body fields containing underscores (e.g. `delete_branch_after_merge`, `target_commitish`).

**The shim detects this automatically.** On the first command that needs it, it calls `GET /api/v1/version` and caches the result. If the server is running 1.25.x, it applies workarounds transparently:

- `gh pr merge --delete-branch` — omits `delete_branch_after_merge` from the merge body, then calls `DELETE /repos/{owner}/{repo}/branches/{branch}` separately.
- `gh release create --target <commitish>` — omits `target_commitish` and prints a warning. Ensure the tag already points to the correct commit.

Force the workaround without a version check:

```sh
GITEA_QUIRKS=underscore   # or GITEA_QUIRKS=1.25
```

Useful in CI environments where the version endpoint is unavailable.

### `gh pr merge --auto`

Gitea does not support auto-merge. `--auto` is accepted but the merge is performed immediately rather than being queued for passing checks.

### Interactive auth

`gh auth login` (without `--with-token`) is not supported. Use `--with-token` and pipe the token via stdin, or set `GITEA_TOKEN` directly.

## Troubleshooting

**`GITEA_URL is not set`** — `GH_WRAPPER_BACKEND=gitea` is set but `GITEA_URL` is missing. Check that `run-job.yml` contains `GITEA_SERVER_URL: ${{ github.server_url }}` in the `env:` block and `-e GITEA_URL="${GITEA_SERVER_URL:-}"` in the `docker run` call. Re-run the managed-files sync (`npx thepopebot init`) to update to the latest workflow.

**`No Gitea token found`** — Neither `GITEA_TOKEN` nor `GH_TOKEN` is set. Add `AGENT_GITEA_TOKEN` as a repo secret.

**`404` on secret/variable endpoints** — Gitea Actions API requires Gitea ≥ 1.19. Older instances do not expose these endpoints.

**Agent jobs clone from github.com** — Check that `GH_WRAPPER_BACKEND` and `GITEA_URL` are set as repo *variables* (not secrets) and that `run-job.yml` passes them via `-e`. Re-run `setup-gitea.mjs` to reset.

**SSH remote not detected** — `repoFromGit()` parses standard SSH remotes (`git@host:owner/repo.git`). Non-standard SSH configs may not be detected — pass `--repo owner/repo` explicitly.

## File layout

```
lib/gh-wrapper/
├── bin/
│   └── gh              # Node.js shim entry point (on PATH inside Docker)
└── lib/
    ├── config.js       # Reads GH_WRAPPER_BACKEND / GITEA_URL / GITEA_TOKEN
    ├── args.js         # gh CLI argument parser
    ├── http.js         # Gitea REST API client
    ├── jq-lite.js      # Minimal jq evaluator
    └── backends/
        ├── gitea.js    # Gitea REST API translator
        └── github.js   # Passthrough to real gh binary

templates/docker/gitea-stack/
├── docker-compose.yml  # Gitea + runner + thepopebot compose stack
├── runner-config.yaml  # Gitea act_runner configuration
└── .env.example        # Environment variable template

setup/
└── setup-gitea.mjs     # Interactive setup wizard
```
