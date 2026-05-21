# Provider Robustness

Tanya targets OpenAI-compatible APIs, with adapter shims for providers that are
mostly compatible but differ in tool-calling, schema handling, rate limiting, or
streaming behavior.

Live provider tests are opt-in because they spend credits:

```bash
TANYA_RUN_LIVE_PROVIDER_TESTS=1 tanya providers test --provider deepseek
```

Legacy `TANIA_RUN_LIVE_PROVIDER_TESTS=1` is also accepted for compatibility.

## Supported Providers

| Provider | Default base URL | Default model | Known quirks | Mock conformance |
| --- | --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-pro` | Generally OpenAI-compatible; occasional missing tool-call fields are recovered by the parser. | Passing |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` | Rejects complex `$ref` / `oneOf` tool schemas on some hosts; schemas are flattened before send. | Passing |
| Grok | `https://api.x.ai/v1` | `grok-3-mini` | Some endpoints reject stricter `tool_choice` modes; adapter avoids provider-specific required-tool forcing. | Passing |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Rate-limit responses can be frequent under load; retry policy honors `Retry-After`. | Passing |
| Together | `https://api.together.xyz/v1` | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` | Hosted models vary; Qwen-family schemas are flattened where needed. | Passing |
| Ollama | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | Local OpenAI-compatible surface varies by model; tool-call parser is permissive. | Passing |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | Baseline adapter for unknown OpenAI-compatible endpoints. | Passing |

## Robustness Behavior

- Tool-call parser accepts stringified JSON arguments, object arguments, missing
  IDs, and missing `function` wrappers.
- Malformed tool calls emit `tool_call_parse_warning` and get a correction turn
  before becoming a structured tool result after the retry cap.
- Narrow-provider schemas emit `schema_flatten_warning` when `$ref` or `oneOf`
  flattening is lossy.
- HTTP `429` responses honor `Retry-After`; `5xx` responses use exponential
  backoff with a 30s ceiling.
- A per-provider semaphore caps concurrent requests to avoid retry storms.

## Configuration

```bash
TANYA_PROVIDER=qwen
TANYA_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
TANYA_MODEL=qwen3-coder-plus
TANYA_API_KEY=...
```

The `TANIA_*` aliases remain supported as legacy fallbacks. `TANYA_*` wins when
both names are present.

Tanya defaults to `deepseek-v4-pro` since v0.17. Set
`TANYA_MODEL=deepseek-v4-flash` if you want the cheaper sibling, or
`TANYA_MODEL=deepseek-chat` / `TANYA_MODEL=deepseek-reasoner` to keep the
legacy aliases. Legacy aliases still work but print a deprecation warning until
DeepSeek removes them on `2026-07-24`.

## Cost estimate accuracy

Tanya's current cost estimates assume cache-miss rates for all DeepSeek requests.
Real DeepSeek bills are typically 30-80% lower because of cache hits on stable
system prompts and tool schemas. We surface this as `[cache-miss estimate]` in
`/cost` and `/budget` until proper cache-hit modeling ships with V4 thinking-mode
support (M13).

## DeepSeek V4 deprecation

DeepSeek scheduled the legacy API model names `deepseek-chat` and
`deepseek-reasoner` for deprecation on `2026-07-24`.

`deepseek-v4-flash` is the underlying V4 model behind both legacy names. The
legacy names remain convenience aliases that pin a thinking-mode choice:

| Legacy name | V4 equivalent (post-M13) |
| --- | --- |
| `deepseek-chat` | `deepseek-v4-flash` with `thinking: false` |
| `deepseek-reasoner` | `deepseek-v4-flash` with `thinking: true` |

Tanya is not auto-migrating those defaults yet because V4 moves thinking mode
from the model name into request configuration. Tanya's router currently
distinguishes routes by model name, so the proper redesign needs a real
`{ model, thinking }` request shape instead of a string-only model swap. That
work is tracked as M13.

For now, users can keep explicit legacy names if they need exact alias behavior.
Tanya prints a one-time warning per process when either legacy alias is used.
Suppress that warning with `TANYA_SUPPRESS_DEPRECATION=1`; legacy
`TANIA_SUPPRESS_DEPRECATION=1` is also accepted.

After M13, `routes.json` will accept an explicit `thinking: boolean` field.
The legacy `deepseek-chat` and `deepseek-reasoner` shortcuts will remain usable
as syntactic sugar until DeepSeek removes them on `2026-07-24`.

DeepSeek V4 also introduces cache-sensitive pricing for
`deepseek-v4-flash`: `$0.0028` per 1M input tokens on cache hit versus `$0.14`
per 1M input tokens on cache miss. Tanya's current `/cost` and `/budget`
reporting assumes cache-miss rates and labels those figures as
`[cache-miss estimate]` until proper cache-hit modeling ships with M13.
