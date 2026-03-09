# thepopebot Setup Guide

## Which path are you on?

| My situation | Go to |
|---|---|
| I have no Gitea and want everything from scratch | [Option A — Fresh setup](#option-a-fresh-setup-new-gitea-with-docker) |
| I already have Gitea running | [Option B — Existing Gitea](#option-b-existing-gitea) |
| Setup ran but I need to start the web UI manually | [Starting the web UI manually](#starting-the-web-ui-manually) |
| Something broke | [Troubleshooting](#troubleshooting) |

---

## Prerequisites (everyone)

### 1. Node.js 18 or higher

```sh
node --version   # must print v18.x or higher
```

Download from https://nodejs.org if needed.

### 2. Docker

```sh
docker --version   # must be installed
docker ps          # must not error — Docker daemon must be running
```

Download from https://docs.docker.com/get-docker/ if needed.

### 3. Clone the repo and install dependencies

```sh
git clone https://github.com/stephengpope/thepopebot.git
cd thepopebot
npm install        # ← REQUIRED before running setup
```

> **Why?** The setup script uses `@clack/prompts` (an interactive UI library)
> that lives in `node_modules/`. The script will auto-run `npm install` if it
> detects the package is missing, but running it manually first is safer.

---

## Option A: Fresh setup (new Gitea with Docker)

This starts Gitea, a workflow runner, and the thepopebot web UI — all in
Docker. Best for clean machines with nothing installed yet.

**Run the wizard:**

```sh
node setup/setup-gitea.mjs
```

When asked _"How do you want to connect to Gitea?"_, choose:

> **Start a fresh Gitea with Docker (recommended for new setups)**

After answering, the wizard:
1. Starts Gitea in Docker and creates the admin account
2. Generates a runner registration token and starts the Actions runner
3. Creates your bot repository on Gitea
4. Sets all secrets and variables on the repo
5. Starts the thepopebot event handler and tests it

**When it finishes, open your browser:**

```
http://localhost:3001     ← thepopebot web UI
http://localhost:3000     ← Gitea (optional, for debugging)
```

The first login to thepopebot creates the admin account. There is no
pre-set password — just fill in the form on first visit.

---

## Option B: Existing Gitea

Your Gitea is already running. You want to add thepopebot on top of it.

**What you need handy:**
- Your Gitea URL, e.g. `http://gitea.myserver.com:3000`
- The Gitea admin username and password

**Run the wizard:**

```sh
node setup/setup-gitea.mjs
```

When asked _"How do you want to connect to Gitea?"_, choose:

> **Use an existing Gitea instance**

Then continue through the same prompts as Option A (see full question list below).

---

## Complete question-by-question walkthrough

Every question the wizard asks, the default answer, and what it means in practice.

### Step 1 — Gitea instance

**Q: How do you want to connect to Gitea?**

| Choice | When to pick it |
|---|---|
| **Start a fresh Gitea with Docker** _(default)_ | You don't have Gitea yet |
| **Use an existing Gitea instance** | Gitea is already running on your machine or network |

---

**[Fresh Gitea only] Q: Directory for Gitea data and compose files**

- Default: `./gitea-stack`
- What it means: A folder is created here containing the Docker Compose file, runner config, and Gitea's SQLite database. You can use any path — absolute or relative. **Keep this folder; it's where all your Gitea data lives.**

---

**[Fresh Gitea only] Q: Gitea HTTP port**

- Default: `3000`
- What it means: The port on your machine where you'll access Gitea's web UI (`http://localhost:3000`). Change this if port 3000 is taken (e.g. use `3001` or `8080`).

---

**[Fresh Gitea only] Q: Hostname / domain for Gitea**

- Default: `localhost`
- What it means: Gitea uses this in the clone URLs it shows you (e.g. `git clone http://localhost:3000/admin/mybot.git`). If you want to access Gitea from other machines on your network, use your machine's LAN hostname or IP (e.g. `myserver.local` or `192.168.1.10`).

---

**[Fresh Gitea only] Q: Admin username**

- Default: `admin`
- What it means: The Gitea admin account created automatically. You'll use this to log into Gitea's web UI (`http://localhost:3000`). **This is Gitea's admin account, not thepopebot's admin account** — they are separate.

---

**[Fresh Gitea only] Q: Admin password**

- Default: _(none, you must enter one)_
- What it means: Password for the Gitea admin account. Minimum 8 characters. Stored only in Gitea's database.

---

**[Existing Gitea only] Q: Gitea instance URL**

- Default: _(pre-filled from `.env` if set)_
- What it means: The full URL of your running Gitea, including port. Example: `http://gitea.myserver.com:3001`. The wizard will connect here to create an API token.

---

**[Existing Gitea only] Q: Gitea admin username + password**

- What it means: Your existing Gitea admin credentials. Used **only** to create an API token (PAT) via the Gitea REST API. The password is **not saved** to `.env` — only the generated token is.

---

### Step 2 — Bot repository

**Q: Repository name on Gitea**

- Default: name of your project folder (e.g. `mybot`)
- What it means: The wizard creates a repo with this name under your Gitea admin account. thepopebot stores workflows, config, and skills here. Agent jobs create branches and PRs in this repo. If the repo already exists, the wizard finds and uses it rather than creating a new one.

---

### Step 3 — Push project to Gitea

**Q: Push [project dir] to Gitea?**

- Default: `Yes`
- What it means: The wizard runs `git push` to send your local project to the Gitea repo. If the folder isn't a git repo yet, it runs `git init` and makes an initial commit first. The push is force-pushed so it always matches your local state. **Skip this** (`No`) if you want to push manually or already have the repo set up.

---

### Step 4 — LLM configuration

**Q: LLM provider for agent jobs**

| Choice | What it uses |
|---|---|
| **Anthropic (Claude)** _(default)_ | Claude API — needs an `ANTHROPIC_API_KEY` |
| **OpenAI (GPT)** | OpenAI API — needs an `OPENAI_API_KEY` |
| **Google (Gemini)** | Google AI Studio — needs a `GOOGLE_API_KEY` |
| **Custom / local** | Any OpenAI-compatible API (Ollama, llama.cpp, etc.) |

---

**Q: LLM model**

- Default: `claude-sonnet-4-20250514` (Anthropic), `gpt-4o` (OpenAI), `gemini-2.5-pro` (Google)
- What it means: The model name passed to the LLM API when running agent jobs. For a local server pick whatever model name your server expects (e.g. `qwen2.5-32b`).

---

**[Custom/local only] Q: OpenAI-compatible base URL**

- Default: `http://localhost:11434/v1` (Ollama default)
- What it means: The base URL of your local LLM API server. Must end in `/v1`. Examples: `http://localhost:11434/v1` (Ollama), `http://localhost:8000/v1` (llama.cpp proxy).

---

**Q: API key**

- Default: _(pre-filled from `.env` on re-runs — press Enter to keep)_
- What it means: Your LLM provider's API key. For local servers this is often not needed — press Enter to skip. The key is stored in `.env` on your machine and set as a Gitea repo secret for agent containers.

---

### Step 5 — Agent job image

**Q: Which Docker image should agent jobs use?**

| Choice | When to pick it |
|---|---|
| **Published stephengpope/thepopebot images** _(default)_ | Normal use — pulls the official image |
| **Custom Docker image URL** | You built a custom image (e.g. `registry.local/mypopebot:dev`) |

- What it means: When a job runs, Gitea Actions spins up a Docker container from this image. The agent (Claude Code, Pi, etc.) runs inside that container, clones your repo, executes the task, and opens a PR.

---

### Step 5b — Fork source

**Q: Git URL of the pope-bot fork to build from and sync with**

- Default: _(pre-filled from `.env`)_
- What it means: The URL of your thepopebot fork (e.g. `https://github.com/Coder666/thepopebot.git`). Used by the `rebuild-agent-image` and `sync-from-fork` Gitea workflows. **If you're not doing custom development on thepopebot itself, enter the upstream URL**: `https://github.com/stephengpope/thepopebot.git`

---

**Q: Default branch to build/sync from**

- Default: `feature/all-features`
- What it means: The branch on the fork URL that gets built into the Docker image. For the upstream published image, leave this as `main`. For the Coder666 fork with all features, use `feature/all-features`.

---

### Step 6 — Apply configuration

No questions — the wizard automatically:
- Sets Gitea repo variables (`GH_WRAPPER_BACKEND`, `LLM_PROVIDER`, `LLM_MODEL`, etc.)
- Sets Gitea repo secrets (`AGENT_GITEA_TOKEN`, `AGENT_ANTHROPIC_API_KEY`, etc.)
- Writes all settings to your `.env` file

---

### Step 7 — Web UI (event handler)

**Q: Start the thepopebot web UI (event handler) with Docker now?**

- Default: `Yes`
- What it means: Pulls the event handler Docker image and starts it. If you say `No`, the `.env` is still fully configured — you can start the container manually any time (see [Starting the web UI manually](#starting-the-web-ui-manually)).

---

**Q: Host port for the web UI**

- Default: `3001` (auto-adjusted to `3002` if Gitea is already on `3001`)
- What it means: The port on your machine where you'll access thepopebot's chat UI (e.g. `http://localhost:3001`). The wizard detects the port your Gitea is running on and automatically picks a different default so they don't conflict. Change it to whatever port you prefer.
- The wizard will reject the same port number as Gitea to prevent a conflict.

---

**Q: Hostname / IP where you will access the UI**

- Default: `localhost`
- What it means: This sets the `APP_URL` in `.env`, which thepopebot uses for auth callbacks and redirects. **If you want to access the UI from another machine** (phone, laptop, etc.), put your server's LAN hostname or IP here (e.g. `myserver.local` or `192.168.1.10`). If you use `localhost` but then try to open the UI from another machine, login will redirect to `localhost` and break.

---

### Important: GITEA_URL inside Docker

The event handler runs inside Docker. If your Gitea also runs in Docker on the
same host, the event handler may not be able to reach `http://localhost:3000`
from inside its container.

**Options:**
- Use your machine's LAN hostname: `http://myserver.local:3000`
- Use the host IP: `http://192.168.1.10:3000`
- If both containers are on the same Docker network, use the container name: `http://gitea:3000`

After setup, `GITEA_URL` in `.env` will be set to whatever URL you gave the
wizard. You can change it by editing `.env` and restarting.

### If you don't have a Gitea Actions runner yet

Check in your Gitea UI at:
`http://your-gitea/admin/runners`

If there are no runners, jobs will queue but never execute. Start one:

```sh
# Get a runner registration token
docker exec -u git gitea gitea actions generate-runner-token

# Start the runner (replace TOKEN and GITEA_URL)
docker run -d \
  --name gitea-runner \
  -e GITEA_INSTANCE_URL=http://your-gitea:3000 \
  -e GITEA_RUNNER_REGISTRATION_TOKEN=<TOKEN> \
  -v /var/run/docker.sock:/var/run/docker.sock \
  gitea/act_runner:latest
```

---

## Starting the web UI manually

If you skipped the "start now" step, or need to restart after a reboot:

### Option B — Existing Gitea (uses `docker-compose.popebot.yml`)

The wizard generates a **dedicated** `docker-compose.popebot.yml` for the event
handler. This avoids touching any existing `docker-compose.yml` you might have
(which could be running Traefik on ports 80/443 or other services).

```sh
# Start
docker compose -f docker-compose.popebot.yml up -d

# Stop
docker compose -f docker-compose.popebot.yml down

# Restart
docker compose -f docker-compose.popebot.yml restart

# View logs (live)
docker logs -f thepopebot
```

To change the port after setup, edit `THEPOPEBOT_PORT` in `.env` and restart:

```sh
# In .env:
THEPOPEBOT_PORT=8080     # change to whatever port you want

# Then restart:
docker compose -f docker-compose.popebot.yml restart
```

### Option A — Fresh Gitea stack (uses gitea-stack/docker-compose.yml)

Everything lives in a single compose file in the gitea-stack directory:

```sh
cd ./gitea-stack    # or wherever you put it during setup

# Start all services (Gitea + runner + thepopebot)
docker compose up -d

# Start just thepopebot (Gitea already running)
docker compose up -d thepopebot

# Restart thepopebot only (e.g. after editing .env)
docker kill thepopebot
docker compose up -d thepopebot
```

### Verify it's running

```sh
curl http://localhost:3001/api/ping
# Expected response: {"ok":true}
```

### Using docker run directly (without compose)

```sh
docker run -d \
  --name thepopebot \
  --restart unless-stopped \
  -p 3001:80 \
  -v $(pwd):/app \
  --env-file .env \
  stephengpope/thepopebot:event-handler-latest
```

> **Note on ports:** The `3001:80` means "expose host port 3001, forwarding to
> container port 80". The container always listens on port 80 internally (Next.js
> + PM2). You can use any host port you like — just change the left side
> (e.g. `8080:80`, `3001:80`). Never change the right side (80).

---

## First login walkthrough

1. Open the web UI in your browser: `http://localhost:3001` (or your chosen port/hostname)
2. You will see a **Create Admin Account** form — fill it in. This only appears on first run.
3. After logging in, go to **Settings → API Keys**
4. Click **Create API Key**, give it a name (e.g. `cli`)
5. Copy the key — you'll use it in API requests

### Test with curl

```sh
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY_HERE" \
  -d '{"job": "say hello from thepopebot"}'
```

Expected: a job ID and status URL.

---

## Troubleshooting

### "Cannot find module '@clack/prompts'"

```sh
npm install
node setup/setup-gitea.mjs
```

The setup wizard auto-detects this and runs `npm install` for you on newer
versions, but if your version predates that fix, run it manually.

### Docker not running

```sh
# macOS / Windows: start Docker Desktop from your Applications / system tray

# Linux:
sudo systemctl start docker
sudo systemctl enable docker  # start on boot
```

### Web UI won't start — check logs

```sh
docker logs thepopebot
```

Common errors:

| Error in logs | Fix |
|---|---|
| `EADDRINUSE` or `port already in use` | Change `THEPOPEBOT_PORT` in `.env` (e.g. `8080`), restart |
| `GITEA_URL is not set` | Add `GITEA_URL=http://...` to `.env`, restart |
| `Failed to fetch` or connection refused to Gitea | Check `GITEA_URL` is reachable from inside Docker; use LAN IP or hostname |
| `AUTH_SECRET` warnings | Add `AUTH_SECRET=<random>` to `.env` (`openssl rand -hex 32`) |
| Next.js build errors on first start | Wait 30–60 s; first startup compiles — check `docker logs -f thepopebot` |

### Web UI shows auth loop / redirects to wrong URL

Set `APP_URL` in `.env` to the **exact** URL you use in your browser,
including the port:

```sh
APP_URL=http://myserver.local:3001   # include :port
APP_HOSTNAME=myserver.local
```

Restart after editing:

```sh
docker compose restart
# or
docker kill thepopebot && docker compose up -d thepopebot
```

### Jobs queue but never execute

1. Check your runner is registered: Gitea UI → **Site Administration → Actions → Runners**
2. If empty, follow the runner setup instructions in [Option B](#if-you-dont-have-a-gitea-actions-runner-yet)
3. Check the runner logs: `docker logs gitea-runner`

### Re-running setup (safe to re-run)

The wizard is idempotent — re-running it updates `.env` and repo secrets
without destroying existing data. Use `--dry-run` to preview:

```sh
node setup/setup-gitea.mjs --dry-run
```

---

## Architecture overview

```
Browser (you)
    │  http://yourserver:3001
    ▼
┌─────────────────────────────────────┐
│    thepopebot event handler         │
│    (Next.js web UI + dispatcher)    │
│    container: thepopebot            │
└──────────────┬──────────────────────┘
               │  creates branch in
               ▼
┌─────────────────────────────────────┐
│    Gitea                            │
│    (self-hosted Git server)         │
│    container: gitea                 │
└──────────────┬──────────────────────┘
               │  triggers workflow on push
               ▼
┌─────────────────────────────────────┐
│    Gitea Actions Runner             │
│    (runs Docker jobs)               │
│    container: gitea-runner          │
└──────────────┬──────────────────────┘
               │  spins up ephemeral container
               ▼
┌─────────────────────────────────────┐
│    AI Agent container               │
│    (claude-code-job, pi-agent, …)   │
│    Clones repo → runs task → PR     │
└─────────────────────────────────────┘
```

---

## Key files after setup

| File | Purpose |
|---|---|
| `.env` | Runtime config — edit here, then restart |
| `docker-compose.yml` | Start/stop the event handler |
| `config/SOUL.md` | Agent personality / system prompt |
| `config/CRONS.json` | Scheduled jobs |
| `skills/` | Active agent skills |
| `docs/GITEA.md` | Gitea integration technical reference |
