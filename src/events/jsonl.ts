import type { EventSink, TanyaEvent } from "./types";

const knownEventTypes = new Set([
  "status",
  "message_start",
  "message_delta",
  "message_end",
  "reasoning_chunk",
  "reasoning_truncated",
  "tool_call",
  "tool_progress",
  "tool_cancel_requested",
  "tool_cancelled",
  "permission_request",
  "permission_decision",
  "tool_result",
  "tool_call_parse_warning",
  "schema_flatten_warning",
  "provider_throttle",
  "provider.raw",
  "model_routed",
  "escalation_event",
  "compact_event",
  "prompt_budget_exceeded",
  "subtask_started",
  "subtask_completed",
  "subtask_start",
  "subtask_done",
  "command_invoked",
  "final",
  "error",
]);

function isKnownEvent(event: unknown): event is TanyaEvent {
  return Boolean(
    event &&
    typeof event === "object" &&
    typeof (event as { type?: unknown }).type === "string" &&
    knownEventTypes.has((event as { type: string }).type),
  );
}

export function createJsonlSink(stream: NodeJS.WritableStream = process.stdout): EventSink {
  return (event: TanyaEvent) => {
    if (!isKnownEvent(event)) return;
    stream.write(`${JSON.stringify(event)}\n`);
  };
}
