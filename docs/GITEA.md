# Gitea Integration

thepopebot ships a `gh`-compatible shim (`lib/gh-wrapper`) that lets the Docker agent use the same `gh` CLI commands whether your repos are on GitHub or a self-hosted Gitea instance. The calling code never knows which backend it is talking to.

## Quick start (Docker Compose stack)

The fastest way to get a full Gitea + thepopebot stack running locally:

```sh
# 1. Copy the stack template to a working directory
cp -r node_modules/thepopebot/templates/docker/gitea-stack ./gitea-stack
cd gitea-stack

# 2. Configure environment
cp .env.example .env
$EDITOR .env    # set GITEA_DOMAIN, GITEA_SECRET_KEY, passwords, etc.

# 3. Start Gitea first
docker compose up -d gitea

# 4. Complete the Gitea install wizard at http://localhost:3000
#    Then get the Actions runner token:
#    Site Administration → Actions → Runners → Create runner
#    — or via CLI:
docker compose exec gitea gitea actions generate-runner-token

# 5. Add GITEA_RUNNER_TOKEN to .env, then bring up the full stack
docker compose up -d

# 6. Run the interactive setup wizard (creates repo, sets secrets/vars)
node path/to/your/project/setup/setup-gitea.mjs
```

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
| `GITEA_URL` | Repo variable | Base URL of your Gitea instance, e.g. `https://gitea.example.com` |
| `AGENT_GITEA_TOKEN` | Repo **secret** | Gitea PAT — automatically unpacked as `GITEA_TOKEN` inside the agent container |

Also set in your event handler `.env`:

```sh
GH_WRAPPER_BACKEND=gitea
GITEA_URL=https://gitea.example.com
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

**`GITEA_URL is not set`** — `GH_WRAPPER_BACKEND=gitea` is set but `GITEA_URL` is missing. Add it to your repo variables.

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
