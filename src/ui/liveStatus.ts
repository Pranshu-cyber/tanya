import type { TanyaEvent } from "../events/types";
import { envValue } from "../config/envCompat";
import { estimateRunCost } from "../memory/runLogs";

export type LiveRouteStep = "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";

export type LiveStatus = {
  provider: string;
  model: string;
  routeStep?: LiveRouteStep;
  spend: {
    usd: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
  };
  contextPressure?: { used: number; cap: number };
  activeTools: Array<{ id: string; tool: string; startedAt: string }>;
  activeChildren: Array<{ subRunId: string; workspace: string; startedAt: string }>;
  pendingPermission?: { tool: string; matchedRule?: string };
  lastEscalation?: { from: string; to: string; reason: string; at: string };
  lastCompaction?: { type: string; removedTokens: number; at: string };
  promptBudgetWarning?: { droppedSections: string[]; at: string };
};

export type LiveStatusController = {
  snapshot(): LiveStatus;
  consume(event: TanyaEvent): void;
};

export type LiveStatusRenderer = {
  consume(event: TanyaEvent): void;
  render(): void;
  snapshot(): LiveStatus;
  enabled(): boolean;
};

export function createLiveStatus(options: {
  now?: () => Date;
  estimateUsd?: (provider: string, model: string, inputTokens: number, outputTokens: number) => number;
} = {}): LiveStatusController {
  const now = options.now ?? (() => new Date());
  const activeTools = new Map<string, { id: string; tool: string; startedAt: string }>();
  const activeChildren = new Map<string, { subRunId: string; workspace: string; startedAt: string }>();
  let provider = "";
  let model = "";
  let routeStep: LiveRouteStep | undefined;
  let spend: LiveStatus["spend"] = { usd: 0, inputTokens: 0, outputTokens: 0 };
  let contextPressure: LiveStatus["contextPressure"];
  let pendingPermission: LiveStatus["pendingPermission"];
  let lastEscalation: LiveStatus["lastEscalation"];
  let lastCompaction: LiveStatus["lastCompaction"];
  let promptBudgetWarning: LiveStatus["promptBudgetWarning"];

  function stamp(): string {
    return now().toISOString();
  }

  return {
    snapshot() {
      return {
        provider,
        model,
        ...(routeStep ? { routeStep } : {}),
        spend: { ...spend },
        ...(contextPressure ? { contextPressure: { ...contextPressure } } : {}),
        activeTools: [...activeTools.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)),
        activeChildren: [...activeChildren.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.subRunId.localeCompare(b.subRunId)),
        ...(pendingPermission ? { pendingPermission: { ...pendingPermission } } : {}),
        ...(lastEscalation ? { lastEscalation: { ...lastEscalation } } : {}),
        ...(lastCompaction ? { lastCompaction: { ...lastCompaction } } : {}),
        ...(promptBudgetWarning ? { promptBudgetWarning: { ...promptBudgetWarning, droppedSections: [...promptBudgetWarning.droppedSections] } } : {}),
      };
    },
    consume(event) {
      switch (event.type) {
        case "model_routed":
          provider = event.provider;
          model = event.model;
          routeStep = event.stepType;
          break;
        case "tool_call":
          activeTools.set(event.id, { id: event.id, tool: event.tool, startedAt: stamp() });
          break;
        case "tool_result":
          activeTools.delete(event.id);
          break;
        case "subtask_started":
          activeChildren.set(event.subRunId, {
            subRunId: event.subRunId,
            workspace: event.workspace,
            startedAt: stamp(),
          });
          break;
        case "subtask_completed":
          activeChildren.delete(event.subRunId);
          break;
        case "permission_request":
          pendingPermission = {
            tool: event.tool,
            ...(event.matchedRule ? { matchedRule: event.matchedRule } : {}),
          };
          break;
        case "permission_decision":
          pendingPermission = undefined;
          break;
        case "escalation_event":
          lastEscalation = {
            from: `${event.from.provider}:${event.from.model}`,
            to: `${event.to.provider}:${event.to.model}`,
            reason: event.reason,
            at: stamp(),
          };
          break;
        case "compact_event":
          lastCompaction = {
            type: event.compactType,
            removedTokens: event.removedTokens,
            at: stamp(),
          };
          break;
        case "prompt_budget_exceeded":
          contextPressure = { used: event.totalTokens, cap: event.cap };
          promptBudgetWarning = { droppedSections: [...event.droppedSections], at: stamp() };
          break;
        case "message_start":
          promptBudgetWarning = undefined;
          break;
        case "final": {
          const metrics = event.metrics;
          if (!metrics) break;
          const inputTokens = metrics.promptTokens ?? 0;
          const outputTokens = metrics.completionTokens ?? 0;
          const reasoningTokens = (metrics as { reasoningTokens?: number }).reasoningTokens ?? 0;
          spend = {
            usd: spend.usd + (options.estimateUsd?.(provider, model, inputTokens, outputTokens) ?? 0),
            inputTokens: spend.inputTokens + inputTokens,
            outputTokens: spend.outputTokens + outputTokens,
            ...(reasoningTokens > 0
              ? { reasoningTokens: (spend.reasoningTokens ?? 0) + reasoningTokens }
              : spend.reasoningTokens !== undefined
                ? { reasoningTokens: spend.reasoningTokens }
                : {}),
          };
          break;
        }
        default:
          break;
      }
    },
  };
}

export function formatLiveStatus(status: LiveStatus, options: {
  now?: Date;
  columns?: number;
  fadeMs?: number;
} = {}): string {
  const now = options.now ?? new Date();
  const fadeMs = options.fadeMs ?? 5_000;
  const promptBudget = status.promptBudgetWarning;
  const escalation = status.lastEscalation && withinWindow(status.lastEscalation.at, now, fadeMs)
    ? status.lastEscalation
    : undefined;
  const compaction = status.lastCompaction && withinWindow(status.lastCompaction.at, now, fadeMs)
    ? status.lastCompaction
    : undefined;

  if (status.pendingPermission) {
    return fitLine(`[awaiting permission: ${status.pendingPermission.tool}${status.pendingPermission.matchedRule ? ` (${status.pendingPermission.matchedRule})` : ""}]`, options.columns);
  }
  if (promptBudget) {
    return fitLine(`[prompt budget: dropped ${promptBudget.droppedSections.join(", ")}]`, options.columns);
  }
  if (escalation) {
    return fitLine(`[escalated ${escalation.from}->${escalation.to}: ${escalation.reason}]`, options.columns);
  }
  if (compaction) {
    return fitLine(`[compacted ~${compactTokenCount(compaction.removedTokens)} tokens via ${compaction.type}]`, options.columns);
  }

  const route = status.provider && status.model ? `${status.provider}:${status.model}` : "no route";
  const step = status.routeStep ?? "unknown";
  const tools = `${status.activeTools.length} tool${status.activeTools.length === 1 ? "" : "s"}`;
  const children = `${status.activeChildren.length} child${status.activeChildren.length === 1 ? "" : "ren"}`;
  const context = status.contextPressure ? ` | ctx ${compactTokenCount(status.contextPressure.used)}/${compactTokenCount(status.contextPressure.cap)}` : "";
  return fitLine(`[${route} | ${step} | ${formatUsd(status.spend.usd)} | ${tools} | ${children}${context}]`, options.columns);
}

export function createLiveStatusRenderer(options: {
  stream?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  columns?: number;
} = {}): LiveStatusRenderer {
  const stream = options.stream ?? process.stdout;
  const now = options.now ?? (() => new Date());
  const status = createLiveStatus({
    now,
    estimateUsd: (provider, model, inputTokens, outputTokens) => estimateRunCost({
      provider,
      model,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    }).usd ?? 0,
  });

  function enabled(): boolean {
    return liveStatusEnabled({
      stream,
      ...(options.env ? { env: options.env } : {}),
    });
  }

  function render(): void {
    if (!enabled()) return;
    const columns = options.columns ?? terminalColumns(stream);
    const line = formatLiveStatus(status.snapshot(), { now: now(), columns });
    // Escape sequences are guarded by liveStatusEnabled(), which requires a TTY.
    stream.write(`\x1b7\r\x1b[2K${line}\x1b8`);
  }

  return {
    consume(event) {
      status.consume(event);
      if (shouldRenderLiveStatus(event)) render();
    },
    render,
    snapshot: status.snapshot,
    enabled,
  };
}

export function liveStatusEnabled(options: {
  stream?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
} = {}): boolean {
  const stream = options.stream ?? process.stdout;
  if ((stream as { isTTY?: boolean }).isTTY !== true) return false;
  const raw = envValue(options.env ?? process.env, "TANYA_LIVE_STATUS").trim();
  return !/^(0|false|off|no)$/i.test(raw);
}

function shouldRenderLiveStatus(event: TanyaEvent): boolean {
  return ![
    "message_start",
    "message_delta",
    "tool_progress",
    "command_invoked",
  ].includes(event.type);
}

function withinWindow(iso: string, now: Date, windowMs: number): boolean {
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && now.getTime() - ts <= windowMs;
}

function terminalColumns(stream: NodeJS.WritableStream): number {
  const columns = (stream as { columns?: number }).columns;
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? columns : 80;
}

function fitLine(line: string, columns = 80): string {
  const width = Math.max(20, columns);
  if (line.length <= width) return line;
  return `${line.slice(0, Math.max(0, width - 3))}...`;
}

function compactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`;
  return `${Math.max(0, Math.round(tokens))}`;
}

function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(3)}`;
}
