# Multi-model routing

Tanya can route each model invocation to the cheapest provider/model that is
expected to handle the current step. The router is rule-based; it never calls a
model to decide which model to use.

## Route table

Routes live in project `.tanya/routes.json` and user-global
`~/.tanya/routes.json`. Tanya also reads legacy `~/.tanya/routes.json` when the
new user-global file is absent. Project routes are prepended ahead of user
routes, then the built-in table, and the first matching route wins.

```json
{
  "version": 1,
  "routes": [
    {
      "match": "planning",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "fallback": { "provider": "qwen", "model": "qwen3-coder-plus" },
      "reasoningCap": { "maxTokens": 2000 }
    }
  ],
  "defaults": { "provider": "openai", "model": "gpt-4.1-mini" }
}
```

`match` accepts either a step type string or `{ "regex": "..." }`. Step types
are `planning`, `tool_call`, `synthesis`, `verification`, `reasoning`, and
`unknown`. Regex matches run against the route text supplied by the runner or
slash command.

`reasoningCap.maxTokens` is optional. It bounds reasoning-only tokens for a
single turn before Tanya emits `reasoning_truncated` and asks the model to give
the final answer. Built-in defaults are 2,000 tokens for planning-style turns
and 8,000 tokens for synthesis, verification, and reasoning turns.

## Built-in table

| Step | Provider | Model | Fallback |
| --- | --- | --- | --- |
| `planning` | `deepseek` | `deepseek-chat` | `qwen/qwen3-coder-plus` |
| `tool_call` | `deepseek` | `deepseek-chat` | `groq/llama-3.3-70b-versatile` |
| `synthesis` | `deepseek` | `deepseek-reasoner` | `openai/gpt-4.1-mini` |
| `verification` | `deepseek` | `deepseek-reasoner` | `openai/gpt-4.1-mini` |
| `reasoning` | `deepseek` | `deepseek-reasoner` | `qwen/qwen3-coder-plus` |

If no explicit route matches, Tanya uses the default provider/model resolved
from the current runtime config. This keeps single-tier setups compatible.

## Examples

### 1. Per-project synthesis override

```json
{
  "version": 1,
  "routes": [
    {
      "match": "synthesis",
      "provider": "openai",
      "model": "gpt-4.1-mini"
    }
  ],
  "defaults": { "provider": "deepseek", "model": "deepseek-chat" }
}
```

### 2. Regex route for verifier-like turns

```json
{
  "version": 1,
  "routes": [
    {
      "match": { "regex": "verify|finalize|validate_" },
      "provider": "deepseek",
      "model": "deepseek-reasoner"
    }
  ],
  "defaults": { "provider": "deepseek", "model": "deepseek-chat" }
}
```

### 3. Disable escalation for a cheap-only profile

```json
{
  "version": 1,
  "routes": [
    {
      "match": "tool_call",
      "provider": "groq",
      "model": "llama-3.3-70b-versatile",
      "escalate": false
    }
  ],
  "defaults": { "provider": "groq", "model": "llama-3.3-70b-versatile" }
}
```

### 4. Force reasoning turns to Qwen

```json
{
  "version": 1,
  "routes": [
    {
      "match": "reasoning",
      "provider": "qwen",
      "model": "qwen3-coder-plus",
      "fallback": { "provider": "deepseek", "model": "deepseek-reasoner" }
    }
  ],
  "defaults": { "provider": "deepseek", "model": "deepseek-chat" }
}
```

### 5. Single-provider compatibility

Do nothing. With no route files present, Tanya keeps using the provider/model
from `loadConfig()` for every turn. The built-in table is still available for
inspection and for route files that choose to override it.

## Runtime command

Interactive sessions expose `/route`:

- `/route` prints the effective project + user + built-in table.
- `/route show synthesis` shows the selected route and its source.
- `/route set synthesis qwen/qwen3-coder-plus` patches the session route table
  without writing to disk.
- `/route reset` clears session patches and returns to file-loaded routes.

## Classifier rules

The classifier is deterministic and rule-based:

- First turn with no prior assistant message: `planning`
- Assistant turn with tool calls and no text: `tool_call`
- Text-only assistant turn after at least two tool results since the last user
  turn: `synthesis`
- Tool names `verify`, `finalize`, or `validate_*`, or tools with
  `preferredModel.match === "verification"`: `verification`
- Active `<think>` block or provider reasoning capability: `reasoning`
- Ambiguous states: `unknown`

## Escalation

Escalation is observable. If a cheap-tier route exhausts the tool-call parsing
repair budget, Tanya may use the route fallback for one final attempt and emits
an `escalation_event`. The default session cap is 5 escalations, configurable
with `TANYA_ESCALATION_CAP` or legacy `TANYA_ESCALATION_CAP`. If the cap is
exhausted, Tanya raises `EscalationExhaustedError` instead of silently spending
on capable-tier retries.

## Reasoning budget

Each turn has a reasoning-token budget. Reasoning beyond it is truncated and
Tanya is asked for a final answer, emitting a `reasoning_truncated` event.

A route may pin its own budget with `reasoningCap.maxTokens` in `routes.json`.
When a route sets no cap, the budget falls back to two tiers:

- **short** — `planning`, `tool_call`, and `unknown` turns. Default `2000`.
- **long** — `synthesis`, `verification`, and `reasoning` turns. Default `8000`.

Both tiers are configurable per process:

- `TANYA_REASONING_CAP_SHORT` (legacy `TANYA_REASONING_CAP_SHORT`)
- `TANYA_REASONING_CAP_LONG` (legacy `TANYA_REASONING_CAP_LONG`)

Raise the short tier when a heavy reasoning model needs more headroom to
converge on single-shot work — e.g. `TANYA_REASONING_CAP_SHORT=8000`. An
explicit per-route `reasoningCap` always overrides these tiers.
