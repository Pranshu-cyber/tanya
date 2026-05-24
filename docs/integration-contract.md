# Tanya Integration Contract

Tanya exposes a CLI contract for automation consumers. Integrations should invoke
the generic JSONL stream instead of depending on product-specific event modes.

## Invocation

```bash
tanya run --json --cwd <path> "task"
tanya run --json --cwd <path> --prompt-file <prompt.md>
```

The legacy `tania` binary alias is still supported. The removed `--cosmo` mode is
not part of this contract.

## Stream Format

`--json` writes one JSON object per line to stdout. Each object has a `type`
field and may include `subRunId` when the event came from a child run.
Consumers must ignore unknown fields and should treat unknown event types as
forward-compatible additions.

| Event type | Fields |
| --- | --- |
| `status` | `message` |
| `message_start` | `elapsedMs?`, `headingStartedAt?` |
| `message_delta` | `text` |
| `message_end` | none |
| `reasoning_chunk` | `content`, `provider`, `model`, `runId`, `turn?`, `tokens?` |
| `reasoning_truncated` | `provider`, `model`, `usedTokens`, `capTokens`, `stepType` |
| `tool_call` | `id`, `tool`, `input` |
| `tool_progress` | `toolCallId`, `chunk`, `timestamp`, `stream` |
| `tool_cancel_requested` | `toolCallId`, `tool?`, `timestamp` |
| `tool_cancelled` | `toolCallId`, `tool?`, `timestamp`, `partialOutput?` |
| `permission_request` | `id`, `tool`, `input`, `matchedRule?`, `projectedCostUsd?`, `projectedTokens?` |
| `permission_decision` | `id`, `decision`, `source`, `persistAs?`, `matchedRule?`, `projectedCostUsd?`, `projectedTokens?`, `thresholdUsd?`, `thresholdTokens?` |
| `tool_result` | `id`, `tool`, `ok`, `summary`, `output?`, `error?`, `reason?`, `modelView?`, `verifierView?` |
| `tool_call_parse_warning` | `reason`, `provider?`, `turn?`, `attempt?`, `toolCallId?`, `tool?` |
| `schema_flatten_warning` | `reason`, `path`, `provider?`, `tool?` |
| `provider_throttle` | `provider`, `attempt`, `waitMs` |
| `model_routed` | `stepType`, `provider`, `model`, `reason`, `cacheImpact?` |
| `escalation_event` | `from`, `to`, `reason`, `stepType` |
| `compact_event` | `compactType`, `removedTokens`, `summaryTokens?`, `aggression?` |
| `prompt_budget_exceeded` | `droppedSections`, `totalTokens`, `cap` |
| `subtask_started` | `subRunId`, `parentRunId`, `prompt`, `workspace` |
| `subtask_completed` | `subRunId`, `parentRunId`, `verdict`, `summary`, `tokensUsed` |
| `command_invoked` | `name`, `args`, `runId?` |
| `subtask_start` | `subtask_id`, `title`, `files` |
| `subtask_done` | `subtask_id`, `files_changed`, `summary`, `ok` |
| `final` | `message`, `suppressHumanMessage?`, `files?`, `manifest?`, `metrics?` (`costUsd` is the actual run cost in USD, or `0` when pricing is unknown) |
| `error` | `message`, `detail?` |

`stepType` is one of `planning`, `tool_call`, `synthesis`, `verification`,
`reasoning`, or `unknown`.

## Final Verdict

Coding runs keep the backward-compatible final report verdict line:

```text
TANIA RESULT: PASSED
TANIA RESULT: FAIL
```

The literal prefix is `TANIA`, not `TANYA`. Consumers that inspect human final
reports should continue matching `TANIA RESULT: PASSED|FAIL`.
