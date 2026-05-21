import type { EventSink } from "../events/types";
import { runIdDepth } from "../agent/subAgentContext";
import { createLiveStatusRenderer, type LiveStatusRenderer } from "./liveStatus";
import { envValue } from "../config/envCompat";
import { formatClock, formatElapsed } from "../utils/formatElapsed";

const toolGlyph = ">";
const ansiDimItalic = "\x1b[2m\x1b[3m";
const ansiReset = "\x1b[0m";
const reasoningPreviewLimit = 600;

function eventPrefix(event: { subRunId?: string }): string {
  if (!event.subRunId) return "";
  return `${"  ".repeat(Math.max(0, runIdDepth(event.subRunId) - 1))}↳ `;
}

export function createHumanSink(stream: NodeJS.WritableStream = process.stdout, options: {
  liveStatus?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  columns?: number;
} = {}): EventSink {
  let inMessage = false;
  let messageHasText = false;
  let reasoningStartedAt: number | null = null;
  let reasoningChars = 0;
  let reasoningCollapsed = false;
  const hideReasoning = /^(1|true|yes|on)$/i.test(envValue(options.env ?? process.env, "TANYA_HIDE_REASONING").trim());
  const liveStatus: LiveStatusRenderer | null = options.liveStatus
    ? createLiveStatusRenderer({
        stream,
        ...(options.env ? { env: options.env } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.columns !== undefined ? { columns: options.columns } : {}),
      })
    : null;

  function finishReasoning(prefix: string): void {
    if (reasoningStartedAt === null || hideReasoning) return;
    const seconds = (Date.now() - reasoningStartedAt) / 1000;
    stream.write(`\n${prefix}${ansiDimItalic}thinking for ${seconds.toFixed(1)}s...${ansiReset}\n`);
    reasoningStartedAt = null;
    reasoningChars = 0;
    reasoningCollapsed = false;
  }

  const sink: EventSink = (event) => {
    const prefix = eventPrefix(event);
    switch (event.type) {
      case "status":
        stream.write(`\n${prefix}${event.message}\n`);
        break;
      case "message_start":
        inMessage = true;
        messageHasText = false;
        reasoningStartedAt = null;
        reasoningChars = 0;
        reasoningCollapsed = false;
        stream.write(`\n${prefix}${
          event.headingStartedAt !== undefined ? `[${formatClock(new Date(event.headingStartedAt))}] ` : ""
        }${event.elapsedMs !== undefined ? `Tanya · ${formatElapsed(event.elapsedMs)}:` : "Tanya:"} `);
        break;
      case "message_delta":
        if (reasoningStartedAt !== null) finishReasoning(prefix);
        messageHasText = true;
        stream.write(event.text);
        break;
      case "message_end":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        messageHasText = false;
        break;
      case "reasoning_chunk":
        if (hideReasoning) break;
        stream.write(ansiDimItalic);
        if (reasoningStartedAt === null) {
          reasoningStartedAt = Date.now();
          if (inMessage && !messageHasText) {
            stream.write("thinking... ");
          } else {
            stream.write(`\n${prefix}thinking... `);
          }
        }
        reasoningChars += event.content.length;
        if (reasoningChars <= reasoningPreviewLimit) {
          stream.write(event.content);
        } else if (!reasoningCollapsed) {
          stream.write(" ...");
          reasoningCollapsed = true;
        }
        stream.write(ansiReset);
        break;
      case "reasoning_truncated":
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`${prefix}[reasoning truncated at ${event.capTokens} tokens; used ${event.usedTokens}]\n`);
        break;
      case "tool_call":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`\n${prefix}${toolGlyph} ${event.tool}\n`);
        stream.write(`${prefix}  input: ${JSON.stringify(event.input)}\n`);
        break;
      case "tool_result":
        stream.write(`${prefix}  ${event.ok ? "ok" : "error"}: ${event.summary}\n`);
        break;
      case "tool_progress":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`${prefix}  ${event.stream}: ${event.chunk}${event.chunk.endsWith("\n") ? "" : "\n"}`);
        break;
      case "tool_cancel_requested":
        stream.write(`${prefix}  cancelling: ${event.tool ?? event.toolCallId}\n`);
        break;
      case "tool_cancelled":
        stream.write(`${prefix}  cancelled: ${event.tool ?? event.toolCallId}\n`);
        break;
      case "permission_request":
        stream.write(`  permission requested: ${event.tool}${event.matchedRule ? ` (${event.matchedRule})` : ""}\n`);
        break;
      case "permission_decision":
        stream.write(`  permission ${event.decision}: ${event.matchedRule ?? event.source}\n`);
        break;
      case "command_invoked":
        break;
      case "tool_call_parse_warning":
        stream.write(`  warning: malformed tool call (${event.reason})\n`);
        break;
      case "schema_flatten_warning":
        stream.write(`  warning: flattened schema${event.tool ? ` for ${event.tool}` : ""} (${event.reason})\n`);
        break;
      case "provider_throttle":
        stream.write(`\nProvider ${event.provider} throttled; waiting ${Math.ceil(event.waitMs / 1000)}s before retry ${event.attempt}.\n`);
        break;
      case "model_routed":
        stream.write(`${prefix}  route: ${event.stepType} -> ${event.provider}/${event.model}${event.cacheImpact === "miss" ? " (cache miss)" : ""}\n`);
        break;
      case "escalation_event":
        stream.write(`${prefix}  escalation: ${event.from.provider}/${event.from.model} -> ${event.to.provider}/${event.to.model} (${event.reason})\n`);
        break;
      case "compact_event":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`[compaction: removed ~${Math.ceil(event.removedTokens / 1000)}k tokens via ${event.compactType}]\n`);
        break;
      case "prompt_budget_exceeded":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`${prefix}[prompt budget: dropped ${event.droppedSections.join(", ")}; ${event.totalTokens} tokens > cap ${event.cap}]\n`);
        break;
      case "subtask_started":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`\n${prefix}subtask started: ${event.subRunId} (${event.workspace})\n`);
        break;
      case "subtask_completed":
        finishReasoning(prefix);
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`${prefix}subtask ${event.verdict}: ${event.summary}\n`);
        break;
      case "subtask_start":
        if (inMessage) stream.write("\n");
        inMessage = false;
        stream.write(`\nSubtask ${event.subtask_id}: ${event.title}\n`);
        if (event.files.length) stream.write(`  files: ${event.files.join(", ")}\n`);
        break;
      case "subtask_done":
        stream.write(`  ${event.ok ? "done" : "failed"}: ${event.summary}\n`);
        break;
      case "final":
        if (!event.suppressHumanMessage) {
          stream.write(`\n${event.message.trim()}\n`);
        }
        if (event.files?.length) stream.write(`Files: ${event.files.join(", ")}\n`);
        break;
      case "error":
        stream.write(`\nError: ${event.message}${event.detail ? `\n${event.detail}` : ""}\n`);
        break;
      default:
        break;
    }
    liveStatus?.consume(event);
  };
  (sink as EventSink & { tanyaSinkKind?: "human" }).tanyaSinkKind = "human";
  return sink;
}
