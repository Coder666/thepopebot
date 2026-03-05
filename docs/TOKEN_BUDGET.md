# Token Budget

The token budget feature manages context window usage to prevent overflow — particularly important for local LLMs (Ollama, LM Studio, llama.cpp) which have strict token limits and no cloud-side truncation.

Two mechanisms work together:

1. **Message trimming** — oldest conversation messages are dropped when the history would exceed the context window. The system prompt and most recent messages are always preserved.
2. **Tool output truncation** — responses from tools that read large files (CLAUDE.md, skill guides, repository files) are capped at a configurable character limit.

Token counting uses a character-based approximation (1 token ≈ 4 chars). This requires no external dependencies or network calls, making it safe for offline and air-gapped environments.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_BUDGET_ENABLED` | `true` | Set to `false` or `0` to disable entirely |
| `CONTEXT_WINDOW` | `8192` | Model's maximum context window in tokens |
| `RESPONSE_RESERVE` | `1024` | Tokens reserved for the model's response |
| `MAX_TOOL_OUTPUT_CHARS` | `8000` | Maximum characters returned by any single tool call (~2 000 tokens) |

Set these in your project's `.env` file.

---

## How It Works

### Message trimming

On every agent call, the prompt function calculates how many tokens are available for conversation history:

```
history budget = CONTEXT_WINDOW − system_prompt_tokens − RESPONSE_RESERVE
```

If the accumulated history (stored in the LangGraph SQLite checkpoint) exceeds that budget, `trimMessages` from `@langchain/core/messages` drops the oldest messages until it fits. The system prompt is always included; the checkpoint record is not modified (full history is preserved for review).

A log line is emitted whenever trimming occurs:

```
[token-budget] Trimmed 4 messages to fit 8192-token context window (system: ~3500 tokens, history budget: 3668 tokens)
```

### Tool output truncation

The following tools apply `maybeTruncate()` to their results before returning to the LLM:

| Tool | Why it can be large |
|------|---------------------|
| `get_system_technical_specs` | Reads the entire `CLAUDE.md` |
| `get_skill_building_guide` | Concatenates the guide + all skill inventories |
| `get_skill_details` | Reads a full `SKILL.md` |
| `get_repository_details` | Fetches `CLAUDE.md` + `README.md` from GitHub |
| `get_branch_file` | Fetches arbitrary repository files |

When a result is truncated a marker is appended:

```
... [truncated — 4231 more characters not shown]
```

---

## Local LLM Setup

Set `CONTEXT_WINDOW` to match your model's actual limit. Common values:

| Model family | Typical context |
|---|---|
| Llama 3.2 3B / 8B | 8 192 (default) |
| Mistral 7B | 8 192 |
| Llama 3.1 8B | 131 072 |
| Qwen2.5 7B | 32 768 |
| Gemma 2 9B | 8 192 |
| Phi-3 mini | 4 096 |

Example `.env` for a small model with a tight window:

```env
CONTEXT_WINDOW=4096
RESPONSE_RESERVE=512
MAX_TOOL_OUTPUT_CHARS=4000
TOKEN_BUDGET_ENABLED=true
```

Example for a large-context model where trimming is rarely needed:

```env
CONTEXT_WINDOW=131072
MAX_TOOL_OUTPUT_CHARS=32000
```

---

## Disabling

```env
TOKEN_BUDGET_ENABLED=false
```

This restores the original behaviour exactly — no trimming, no truncation. Useful for debugging or when using a cloud provider with automatic context management.

---

## Implementation Notes

- **No external tokenizer dependency** — character/4 approximation avoids network fetches (the built-in `@langchain/core/utils/tiktoken` module fetches tokenizer data from a CDN at runtime, making it unsuitable for local-first use).
- **Full history preserved** — the LangGraph SQLite checkpoint always stores the complete conversation. Only the slice sent to the LLM is trimmed.
- **Anthropic prompt caching** — when using the Anthropic provider, the system prompt tokens that are identical across turns are automatically cached by the API (no code changes needed). Combined with message trimming this further reduces cost and latency.
