# Lightweight Live Status

Tanya renders a compact live status line in interactive `tanya chat` sessions.
It is a read-only projection over existing EventSink events; it does not replace
human output, JSONL output, audit logs, or verifier inputs.

Example snapshots:

```text
[deepseek:deepseek-chat | tool_call | $0.040 | 2 tools | 1 child]
[awaiting permission: write_file (write_file:.*")]
[escalated deepseek:deepseek-chat->openai:gpt-4.1-mini: parse_failure]
[compacted ~12.3k tokens via auto]
[prompt budget: dropped repo-map, artifact index]
```

## What It Surfaces

The status line derives state from events Tanya already emits:

- `model_routed` sets the current provider, model, and route step.
- `tool_call` and `tool_result` track active tools.
- `subtask_started` and `subtask_completed` track active child agents.
- `permission_request` and `permission_decision` show pending permission prompts.
- `escalation_event` shows recent route escalations for a short fade window.
- `compact_event` shows recent compactions for a short fade window.
- `prompt_budget_exceeded` shows a sticky prompt-budget warning until the next turn.
- `final.metrics` accumulates the session token and spend totals.

No new events are emitted by the live status layer.

## TTY Behavior

Terminal control sequences are only written when `stdout` is an interactive TTY.
When output is piped, redirected, or written as JSONL, the live status renderer
is a no-op. This keeps CI logs and machine-readable streams byte-stable.

Disable the renderer explicitly:

```bash
TANYA_LIVE_STATUS=0 tanya chat
```

The legacy alias is also accepted:

```bash
TANYA_LIVE_STATUS=0 tanya chat
```

## Streaming Compatibility

M11 uses the conservative event-boundary strategy: status is rendered after
discrete events and skipped during streaming spans such as `message_delta` and
`tool_progress`. Long model output and shell output stay readable because the
status line does not repaint in the middle of streamed chunks.

This avoids a full-screen TUI. The M6 gap analysis kept a full TUI out of the
roadmap because it would create a second rendering surface and raise the risk of
log corruption. The live status line provides the useful operational feedback
without changing EventSink semantics.

See also [docs/claude-code-gap-analysis.md](./claude-code-gap-analysis.md) for
the earlier TUI rejection context.
