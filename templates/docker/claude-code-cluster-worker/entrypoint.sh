#!/bin/bash
set -e

# Git setup — derive identity from GitHub token (useful if tasks need git)
if [ -n "$GH_TOKEN" ]; then
    gh auth setup-git
    GH_USER_JSON=$(gh api user -q '{name: .name, login: .login, email: .email, id: .id}')
    GH_USER_NAME=$(echo "$GH_USER_JSON" | jq -r '.name // .login')
    GH_USER_EMAIL=$(echo "$GH_USER_JSON" | jq -r '.email // "\(.id)+\(.login)@users.noreply.github.com"')
    git config --global user.name "$GH_USER_NAME"
    git config --global user.email "$GH_USER_EMAIL"
fi

cd /home/claude-code/workspace

# Claude Code auth — use OAuth token, not API key
unset ANTHROPIC_API_KEY
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"

# Skip onboarding and trust dialogs
WORKSPACE_DIR=$(pwd)
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'EOF'
{
  "theme": "dark",
  "hasTrustDialogAccepted": true,
  "skipDangerousModePermissionPrompt": true
}
EOF

cat > ~/.claude.json << ENDJSON
{
  "hasCompletedOnboarding": true,
  "projects": {
    "${WORKSPACE_DIR}": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true,
      "hasTrustDialogHooksAccepted": true
    }
  }
}
ENDJSON

# Switch to best-effort mode for logging + claude execution
set +e

# Create log session dir (best-effort)
SESSION_TS=$(date -u +%Y-%m-%d_%H-%M-%S)
LOG_DIR="logs/role-${ROLE_SHORT_ID}/${SESSION_TS}_${WORKER_UUID}"
LOG_READY=false
if mkdir -p "$LOG_DIR" 2>/dev/null; then
    {
        echo "# System Prompt"
        echo ""
        printf '%s' "$SYSTEM_PROMPT"
        echo ""
        echo ""
        echo "# Prompt"
        echo ""
        printf '%s' "$PROMPT"
    } > "$LOG_DIR/prompt.md" 2>/dev/null
    cat > "$LOG_DIR/meta.json" << ENDJSON
{"roleName":"${ROLE_NAME}","startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
ENDJSON
    if [ -n "$TRIGGER_LOG" ]; then
        printf '%s' "$TRIGGER_LOG" > "$LOG_DIR/trigger.json" 2>/dev/null
    fi
    LOG_READY=true
fi

# Build claude args
CLAUDE_ARGS=(-p "$PROMPT" --dangerously-skip-permissions --verbose --output-format stream-json)
if [ -n "$SYSTEM_PROMPT" ]; then
    CLAUDE_ARGS+=(--append-system-prompt "$SYSTEM_PROMPT")
fi

# Run Claude Code — tee to log files if ready, otherwise run normally
if [ "$LOG_READY" = true ]; then
    claude "${CLAUDE_ARGS[@]}" \
        > >(tee "$LOG_DIR/stdout.jsonl") \
        2> >(tee "$LOG_DIR/stderr.txt" >&2)
    EXIT_CODE=$?
else
    claude "${CLAUDE_ARGS[@]}"
    EXIT_CODE=$?
fi

# Finalize meta with end time (best-effort)
if [ "$LOG_READY" = true ]; then
    jq --arg end "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {endedAt: $end}' \
        "$LOG_DIR/meta.json" > "$LOG_DIR/meta.tmp" 2>/dev/null \
        && mv "$LOG_DIR/meta.tmp" "$LOG_DIR/meta.json"
fi

exit $EXIT_CODE
