# 02 - Custom provider

Point Tanya at any OpenAI-compatible endpoint. This example uses a local Ollama
server exposing `/v1/chat/completions`.

## Prerequisites

- Node.js 20 or newer
- Tanya installed or linked locally
- A reachable OpenAI-compatible provider
- A model available at that provider

## Run

```bash
TANYA_PROVIDER=custom TANYA_API_KEY=ollama TANYA_BASE_URL=http://127.0.0.1:11434/v1 TANYA_MODEL=qwen2.5-coder tanya ask "hello"
```

## Notes

For hosted providers, replace the base URL, model name, and API key with the
values from that service.
