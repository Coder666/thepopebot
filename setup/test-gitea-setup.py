#!/usr/bin/env python3
"""
Automated test driver for setup-gitea.mjs.
Uses pexpect to interact with the interactive prompts over a real PTY.

Usage:  python3 setup/test-gitea-setup.py
"""
import pexpect
import sys
import time

TIMEOUT = 600   # 10-minute global timeout (docker pull + startup can be slow)

def send(child, text, delay=0.4):
    time.sleep(delay)
    child.send(text)

def log(msg):
    print(f"\n\033[1;33m[TEST] {msg}\033[0m", flush=True)

log("Starting setup-gitea.mjs …")
child = pexpect.spawn(
    'node /home/twilson/Pope/setup/setup-gitea.mjs --project /home/twilson/popebot-project',
    encoding='utf-8', timeout=TIMEOUT, echo=False,
    dimensions=(50, 200),   # wide terminal so text doesn't wrap mid-keyword
)
child.logfile_read = sys.stdout

# ── Step 1/6: Gitea instance ──────────────────────────────────────────────────
# Select prompt: "How do you want to connect to Gitea?"
# Default (first) option = "Start a fresh Gitea with Docker" → just Enter
child.expect('How do you want to connect', timeout=30)
log("Selecting: Docker mode")
send(child, '\r')

# Text: "Directory for Gitea data and compose files"  (default: ./gitea-stack)
child.expect('Directory for Gitea', timeout=15)
log("Compose dir → /data0/compose/gitea")
send(child, '\x15')                          # Ctrl-U clears the pre-filled value
send(child, '/data0/compose/gitea\r')

# Text: "Gitea HTTP port"  (default: 3000)
child.expect('Gitea HTTP port', timeout=15)
log("Port → 3001")
send(child, '\x15')
send(child, '3001\r')

# Text: "Hostname / domain"  (default: localhost)
child.expect('Hostname', timeout=15)
log("Domain → atlas.local")
send(child, '\x15')
send(child, 'atlas.local\r')

# Text: "Admin username"  (default: admin — accept as-is)
child.expect('Admin username', timeout=15)
log("Admin username → admin (default)")
send(child, '\r')

# Password: "Admin password"
child.expect('Admin password', timeout=15)
log("Admin password → AdminPass123!")
send(child, 'AdminPass123!\r')

# ── Docker operations (container start, admin user, runner token, PAT) ────────
log("Docker operations running — may take up to 3 minutes …")

# ── Step 2/6: Repository ──────────────────────────────────────────────────────
child.expect('Repository name', timeout=300)   # long wait for docker startup
log("Repo name → mybot")
send(child, '\x15')
send(child, 'mybot\r')

# ── Step 3/6: Push ───────────────────────────────────────────────────────────
child.expect(['Push.*to Gitea', 'Initialise git'], timeout=30)
log("Confirm push → yes (Enter)")
send(child, '\r')   # initialValue: true → Enter = yes

# ── Step 4/6: LLM ────────────────────────────────────────────────────────────
# Select: LLM provider  (initialValue from .env = 'custom' → already highlighted)
child.expect('LLM provider', timeout=60)
log("LLM provider → custom (pre-selected from .env, Enter)")
send(child, '\r')

# Text: LLM model  (pre-filled 'qwen2.5-32b' from .env)
child.expect('LLM model', timeout=15)
log("LLM model → qwen2.5-32b (pre-filled, Enter)")
send(child, '\r')

# Text: OpenAI-compatible base URL  (pre-filled from .env)
child.expect('OpenAI-compatible base URL', timeout=15)
log("Base URL → http://llama-qwen32b:8080/v1 (pre-filled, Enter)")
send(child, '\r')

# Password: API key  (no validation for custom → Enter to skip)
child.expect('API key', timeout=15)
log("API key → (empty, Enter)")
send(child, '\r')

# ── Step 5/6: Job image ───────────────────────────────────────────────────────
# Select: first option = "Published stephengpope/thepopebot images"
child.expect('Which Docker image', timeout=15)
log("Job image → published (default, Enter)")
send(child, '\r')

# ── Step 6/6: Apply — fully automated ────────────────────────────────────────
log("Waiting for Step 6 to apply config …")
child.expect(['setup.*complete', 'Gitea setup', 'Summary'], timeout=120)
log("Setup complete! Draining output …")

# Drain any remaining output
try:
    child.expect(pexpect.EOF, timeout=15)
except pexpect.TIMEOUT:
    pass

print("\n\n\033[1;32m=== setup-gitea.mjs TEST PASSED ===\033[0m\n", flush=True)
sys.exit(0)
