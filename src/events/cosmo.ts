import type { EventSink } from "./types";

const PREFIX = "__E:";

function writeEvent(stream: NodeJS.WritableStream, event: unknown): void {
  stream.write(`${PREFIX}${JSON.stringify(event)}\n`);
}

function subRunMeta(event: { subRunId?: string }): { subRunId?: string } {
  return event.subRunId ? { subRunId: event.subRunId } : {};
}

export function createCosmoSink(stream: NodeJS.WritableStream = process.stdout): EventSink {
  let textOpen = false;

  function ensureEventLine(): void {
    if (textOpen) {
      stream.write("\n");
      textOpen = false;
    }
  }

  return (event) => {
    switch (event.type) {
      case "status":
        ensureEventLine();
        writeEvent(stream, { t: "status", message: event.message, key: `tanya:${event.message.slice(0, 80)}` });
        break;
      case "message_delta":
        stream.write(event.text);
        textOpen = !event.text.endsWith("\n");
        break;
      case "reasoning_chunk":
        ensureEventLine();
        writeEvent(stream, {
          t: "reasoning_chunk",
          content: event.content,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          turn: event.turn,
          tokens: event.tokens,
          ...subRunMeta(event),
        });
        break;
      case "reasoning_truncated":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Reasoning truncated at ${event.capTokens} tokens.`,
          key: `tanya:reasoning-truncated:${event.provider}:${event.model}`,
          provider: event.provider,
          model: event.model,
          usedTokens: event.usedTokens,
          capTokens: event.capTokens,
          stepType: event.stepType,
        });
        break;
      case "tool_call":
        ensureEventLine();
        writeEvent(stream, {
          t: "tool_call",
          tool: event.tool,
          detail: JSON.stringify(event.input).slice(0, 200),
          content: "",
          id: event.id,
          ...subRunMeta(event),
        });
        break;
      case "tool_result":
        ensureEventLine();
        writeEvent(stream, {
          t: "tool_result",
          id: event.id,
          output: event.summary,
          error: !event.ok,
          ...subRunMeta(event),
        });
        break;
      case "tool_progress":
        ensureEventLine();
        writeEvent(stream, {
          t: "tool_progress",
          id: event.toolCallId,
          stream: event.stream,
          chunk: event.chunk,
          timestamp: event.timestamp,
          ...subRunMeta(event),
        });
        break;
      case "tool_cancel_requested":
        ensureEventLine();
        writeEvent(stream, {
          t: "tool_cancel_requested",
          id: event.toolCallId,
          tool: event.tool,
          timestamp: event.timestamp,
          ...subRunMeta(event),
        });
        break;
      case "tool_cancelled":
        ensureEventLine();
        writeEvent(stream, {
          t: "tool_cancelled",
          id: event.toolCallId,
          tool: event.tool,
          timestamp: event.timestamp,
          partialOutput: event.partialOutput,
          ...subRunMeta(event),
        });
        break;
      case "permission_request":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Permission requested for ${event.tool}`,
          key: `tanya:permission-request:${event.id}`,
          id: event.id,
          tool: event.tool,
          matchedRule: event.matchedRule,
          projectedCostUsd: event.projectedCostUsd,
          projectedTokens: event.projectedTokens,
        });
        break;
      case "permission_decision":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Permission ${event.decision}`,
          key: `tanya:permission-decision:${event.id}`,
          id: event.id,
          decision: event.decision,
          source: event.source,
          persistAs: event.persistAs,
          matchedRule: event.matchedRule,
        });
        break;
      case "command_invoked":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Command invoked: /${event.name}`,
          key: `tanya:command:${event.name}`,
          command: event.name,
          args: event.args,
          runId: event.runId,
        });
        break;
      case "tool_call_parse_warning":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Tool-call parse warning: ${event.reason}`,
          key: `tanya:tool-call-parse-warning:${event.toolCallId ?? event.turn ?? "unknown"}`,
          provider: event.provider,
          tool: event.tool,
          attempt: event.attempt,
        });
        break;
      case "schema_flatten_warning":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Schema flatten warning: ${event.reason}`,
          key: `tanya:schema-flatten-warning:${event.tool ?? event.path}`,
          provider: event.provider,
          tool: event.tool,
          path: event.path,
        });
        break;
      case "provider_throttle":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Provider throttle: waiting ${Math.ceil(event.waitMs / 1000)}s before retry ${event.attempt}.`,
          key: `tanya:provider-throttle:${event.provider}:${event.attempt}`,
          provider: event.provider,
          attempt: event.attempt,
          waitMs: event.waitMs,
        });
        break;
      case "model_routed":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Model routed: ${event.stepType} -> ${event.provider}/${event.model}`,
          key: `tanya:model-routed:${event.stepType}:${event.provider}:${event.model}`,
          stepType: event.stepType,
          provider: event.provider,
          model: event.model,
          reason: event.reason,
          cacheImpact: event.cacheImpact,
        });
        break;
      case "escalation_event":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Escalated ${event.stepType}: ${event.from.provider}/${event.from.model} -> ${event.to.provider}/${event.to.model}`,
          key: `tanya:escalation:${event.stepType}:${event.reason}`,
          from: event.from,
          to: event.to,
          reason: event.reason,
          stepType: event.stepType,
        });
        break;
      case "compact_event":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Compaction: removed ~${Math.ceil(event.removedTokens / 1000)}k tokens via ${event.compactType}.`,
          key: `tanya:compact:${event.compactType}:${event.aggression ?? "none"}`,
          compactType: event.compactType,
          removedTokens: event.removedTokens,
          summaryTokens: event.summaryTokens,
          aggression: event.aggression,
        });
        break;
      case "subtask_started":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Subtask started: ${event.subRunId}`,
          key: `tanya:subtask-started:${event.subRunId}`,
          subRunId: event.subRunId,
          parentRunId: event.parentRunId,
          prompt: event.prompt,
          workspace: event.workspace,
        });
        break;
      case "subtask_completed":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Subtask ${event.verdict}: ${event.subRunId}`,
          key: `tanya:subtask-completed:${event.subRunId}`,
          subRunId: event.subRunId,
          parentRunId: event.parentRunId,
          verdict: event.verdict,
          summary: event.summary,
          tokensUsed: event.tokensUsed,
        });
        break;
      case "prompt_budget_exceeded":
        ensureEventLine();
        writeEvent(stream, {
          t: "status",
          message: `Prompt budget exceeded: dropped ${event.droppedSections.join(", ")}.`,
          key: `tanya:prompt-budget:${event.droppedSections.join("+")}`,
          droppedSections: event.droppedSections,
          totalTokens: event.totalTokens,
          cap: event.cap,
        });
        break;
      case "subtask_start":
        ensureEventLine();
        writeEvent(stream, {
          t: "subtask_start",
          subtask_id: event.subtask_id,
          title: event.title,
          files: event.files,
        });
        break;
      case "subtask_done":
        ensureEventLine();
        writeEvent(stream, {
          t: "subtask_done",
          subtask_id: event.subtask_id,
          files_changed: event.files_changed,
          summary: event.summary,
          ok: event.ok,
        });
        break;
      case "final":
        ensureEventLine();
        if (event.message.trim()) {
          stream.write(`${event.message.trim()}\n`);
        }
        writeEvent(stream, {
          t: "status",
          message: `Tanya finished. Changed files: ${event.files?.length ?? 0}. Tool errors: ${event.metrics?.toolErrorCount ?? 0}.`,
          key: "tanya:final",
          metrics: event.metrics,
          files: event.files ?? [],
        });
        break;
      case "error":
        ensureEventLine();
        writeEvent(stream, {
          t: "tool_result",
          id: "tanya:error",
          output: event.detail ? `${event.message}\n${event.detail}` : event.message,
          error: true,
        });
        break;
      case "message_start":
        break;
      case "message_end":
        if (textOpen) {
          stream.write("\n");
          textOpen = false;
        }
        break;
      default:
        break;
    }
  };
}
