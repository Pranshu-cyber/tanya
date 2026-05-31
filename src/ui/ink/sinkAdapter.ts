import type { Dispatch } from "react";
import type { EventSink, TanyaEvent } from "../../events/types";
import { estimateRunCost } from "../../memory/runLogs";
import { formatElapsed } from "../../utils/formatElapsed";
import type { InkAction } from "./state";

export function createInkSink(dispatch: Dispatch<InkAction>, options: {
  provider: string;
  model: string;
  startedAt: number;
  flushIntervalMs?: number;
}): EventSink {
  let assistantId: string | null = null;
  let streamedText = false;
  let buffer = "";
  let flushHandle: ReturnType<typeof setTimeout> | null = null;
  let reasoningId: string | null = null;
  let reasoningBuffer = "";
  let reasoningFlushHandle: ReturnType<typeof setTimeout> | null = null;
  let reasoningStartedAt: number | null = null;
  let streamedTokenChars = 0;
  let streamedReasoningChars = 0;
  let lastProgressCompletionTokens = 0;
  let lastProgressReasoningTokens = 0;
  let toolCount = 0;
  const flushIntervalMs = options.flushIntervalMs ?? 30;

  // Estimate completion/reasoning tokens from streamed characters (~4 chars/token)
  // and push a live turn_progress so the footer updates in real time. De-duped so
  // a burst of tiny deltas that doesn't move the ~4-char bucket dispatches once.
  const dispatchProgressEstimate = () => {
    const completionTokens = Math.ceil(streamedTokenChars / 4);
    const reasoningTokens = Math.ceil(streamedReasoningChars / 4);
    if (completionTokens === lastProgressCompletionTokens && reasoningTokens === lastProgressReasoningTokens) return;
    lastProgressCompletionTokens = completionTokens;
    lastProgressReasoningTokens = reasoningTokens;
    dispatch({ type: "turn_progress", completionTokens, reasoningTokens });
  };

  const ensureAssistant = () => {
    if (assistantId) return assistantId;
    const timestampMs = Date.now();
    assistantId = `assistant-${timestampMs}`;
    dispatch({
      type: "assistant_start",
      id: assistantId,
      timestampMs,
      elapsedMs: timestampMs - options.startedAt,
    });
    return assistantId;
  };

  const flushBuffer = () => {
    if (flushHandle !== null) {
      clearTimeout(flushHandle);
      flushHandle = null;
    }
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    dispatch({ type: "assistant_delta", id: ensureAssistant(), text });
  };

  const scheduleFlush = () => {
    if (flushHandle !== null) return;
    flushHandle = setTimeout(() => {
      flushHandle = null;
      flushBuffer();
    }, flushIntervalMs);
  };

  const ensureReasoning = () => {
    if (reasoningId) return reasoningId;
    const startedAt = Date.now();
    reasoningStartedAt = startedAt;
    reasoningId = `reasoning-${startedAt}`;
    dispatch({
      type: "activity_start",
      item: {
        id: reasoningId,
        kind: "reasoning",
        status: "active",
        summary: "thinking…",
        startedAt,
      },
    });
    return reasoningId;
  };

  const flushReasoningBuffer = () => {
    if (reasoningFlushHandle !== null) {
      clearTimeout(reasoningFlushHandle);
      reasoningFlushHandle = null;
    }
    if (!reasoningBuffer) return;
    const text = reasoningBuffer;
    reasoningBuffer = "";
    dispatch({ type: "activity_progress", id: ensureReasoning(), text });
  };

  const scheduleReasoningFlush = () => {
    if (reasoningFlushHandle !== null) return;
    reasoningFlushHandle = setTimeout(() => {
      reasoningFlushHandle = null;
      flushReasoningBuffer();
    }, flushIntervalMs);
  };

  const sink: EventSink = (event: TanyaEvent) => {
    switch (event.type) {
      case "message_delta": {
        streamedText = true;
        ensureAssistant();
        buffer += event.text;
        streamedTokenChars += event.text.length;
        dispatchProgressEstimate();
        scheduleFlush();
        break;
      }
      case "message_end":
        flushBuffer();
        break;
      case "reasoning_chunk":
        reasoningBuffer += event.content;
        streamedReasoningChars += event.content.length;
        dispatchProgressEstimate();
        scheduleReasoningFlush();
        break;
      case "tool_call": {
        flushBuffer();
        flushReasoningBuffer();
        toolCount += 1;
        dispatch({
          type: "activity_start",
          item: {
            id: event.id,
            kind: "tool",
            status: "active",
            summary: `running ${formatToolCallSummary(event.tool, event.input)}`,
            startedAt: Date.now(),
          },
        });
        break;
      }
      case "tool_result":
        flushBuffer();
        flushReasoningBuffer();
        dispatch({
          type: "activity_end",
          id: event.id,
          summary: `${event.tool}: ${event.summary}`,
          status: event.ok ? "done" : "error",
          endedAt: Date.now(),
        });
        break;
      case "tool_progress":
        flushBuffer();
        flushReasoningBuffer();
        dispatch({ type: "activity_progress", id: event.toolCallId, text: event.chunk.trimEnd() });
        break;
      case "status":
        flushBuffer();
        dispatch({ type: "system_message", content: event.message });
        break;
      case "error":
        flushBuffer();
        dispatch({ type: "system_message", content: `Error: ${event.message}${event.detail ? `\n${event.detail}` : ""}` });
        break;
      case "final": {
        flushBuffer();
        flushReasoningBuffer();
        if (!streamedText && event.message.trim()) {
          buffer += event.message.trim();
          flushBuffer();
        }
        const now = Date.now();
        const streamedTokens = event.metrics?.completionTokens ?? streamedTokenChars;
        dispatch({
          type: "system_message",
          content: `ran ${toolCount} tool${toolCount === 1 ? "" : "s"} · took ${formatElapsed(now - options.startedAt)}${reasoningStartedAt === null ? "" : ` (thought ${formatElapsed(now - reasoningStartedAt)})`} · streamed ${streamedTokens} token${streamedTokens === 1 ? "" : "s"}`,
          timestampMs: now,
        });
        const metrics = event.metrics;
        const cost = metrics ? estimateRunCost({
          provider: options.provider,
          model: options.model,
          promptTokens: metrics.promptTokens ?? 0,
          completionTokens: metrics.completionTokens ?? 0,
          reasoningTokens: metrics.reasoningTokens ?? 0,
        }).usd : null;
        if (event.metrics) {
          dispatch({
            type: "turn_complete",
            elapsedMs: Date.now() - options.startedAt,
            costUsd: cost,
            ...(metrics?.promptTokens !== undefined ? { promptTokens: metrics.promptTokens } : {}),
            ...(metrics?.completionTokens !== undefined ? { completionTokens: metrics.completionTokens } : {}),
            ...(metrics?.reasoningTokens !== undefined ? { reasoningTokens: metrics.reasoningTokens } : {}),
          });
        } else {
          dispatch({ type: "turn_complete", elapsedMs: Date.now() - options.startedAt, costUsd: null });
        }
        break;
      }
      default:
        break;
    }
  };
  (sink as EventSink & { tanyaSinkKind?: "ink" }).tanyaSinkKind = "ink";
  return sink;
}

function formatToolCallSummary(tool: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return `${tool}()`;
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 2)
    .map(([key, value]) => `${key}=${formatToolValue(value)}`);
  return `${tool}(${entries.join(", ")})`;
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return `"${compact.length > 40 ? `${compact.slice(0, 37)}...` : compact}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{…}";
}
