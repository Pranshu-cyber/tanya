# Reasoning Models

Tanya treats reasoning output as UI/log data, not conversation history. This
keeps golden-task replay stable and prevents non-deterministic reasoning text
from influencing later turns or verifier authority.

## Provider Support

| Provider | Model detection | Reasoning source | History behavior |
| --- | --- | --- | --- |
| DeepSeek | `deepseek-reasoner` or R1-style model names | `delta.reasoning_content` | archived only |
| Qwen | `qwen3-thinking-*` and thinking model names | `<think>...</think>` wrappers | archived only |
| Grok | `grok-3-reasoning` and reasoning model names | `<think>...</think>` wrappers | archived only |
| Groq, Together, Ollama, OpenAI-compatible chat | adapter capability stays false unless routed to a reasoning-style model | normal assistant text | unchanged |

Reasoning chunks are appended to `.tanya/runs/<runId>/reasoning.jsonl` with
provider, model, turn, timestamp, content, and estimated token count.

## Billing And Budgets

Reasoning tokens are counted separately from normal output tokens in run logs,
`/cost`, and `/budget`. DeepSeek-style endpoints can report explicit reasoning
tokens. OpenAI-compatible hosts that do not report them are estimated from the
reasoning chunk length and priced at the output-token rate.

Routes may include:

```json
{
  "match": "synthesis",
  "provider": "deepseek",
  "model": "deepseek-reasoner",
  "reasoningCap": { "maxTokens": 8000 }
}
```

Built-in caps are 2,000 reasoning tokens for planning/tool-call/unknown turns
and 8,000 for synthesis, verification, and reasoning turns. When a turn exceeds
its cap Tanya emits `reasoning_truncated` and injects a synthetic user message:

```text
[your reasoning budget for this turn is exhausted. Give your final answer now.]
```

## UX Modes

Human REPL output shows reasoning dimmed and italic with a `thinking...` prefix,
then collapses to `thinking for Ns...` when the assistant response starts or the
turn ends. Set `TANYA_HIDE_REASONING=1` (or legacy `TANYA_HIDE_REASONING=1`) to
suppress reasoning from the human UI. JSONL output still receives full reasoning
events.

Use `/memory --reasoning <runId>` to replay archived reasoning. Add `--turn N`
to inspect one turn.

## Verifier Annotations

Reasoning is never verifier authority. The verifier still derives verdicts from
observable run state: changed files, tool results, validation, and child
verdicts. Optional annotations can add "Why the agent thought this" context to
blockers, but only when enabled with:

```bash
tanya run --verbose-verifier "fix the failing test"
TANYA_VERIFIER_INCLUDE_REASONING=1 tanya run "fix the failing test"
```

The annotations are marked `confidence: advisory` in the manifest and are
strictly additive. Default verifier behavior is unchanged.

## Compaction

Live history is already reasoning-free, so compaction never has to remove
reasoning from model-visible messages. When compaction pressure appears, Tanya
evicts the on-disk reasoning archive first and leaves an eviction tombstone in
`reasoning.jsonl`.
