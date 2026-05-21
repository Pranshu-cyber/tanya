# 04 - Host integration

Use JSONL mode from a host process that already owns orchestration and wants
machine-readable Tanya events.

## Prerequisites

- Node.js 20 or newer
- Tanya installed or linked locally
- Provider credentials configured

## Run

```bash
tanya run --json --context-file examples/04-cosmochat-integration/context.json --prompt-file examples/04-cosmochat-integration/prompt.md
```

## What to expect

The host can consume one JSON object per line, including tool calls, progress,
results, and the final manifest. The sample context is sanitized and contains no
CosmoChat-specific private data.
