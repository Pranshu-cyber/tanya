import type { ActivityItem, InkMessage, InkSessionStats } from "./types";
import type { PermissionRequest } from "../../safety/permissions/host";
import { estimateRunCost } from "../../memory/runLogs";

export interface PendingTurn {
  startedAt: number;
  spinnerVisible: boolean;
}

// Live, in-flight token + cost estimate for the turn currently running. Prompt
// tokens are estimated at turn start; completion/reasoning tokens are estimated
// from streamed characters during the turn; cost is recomputed each tick from
// the configured per-model pricing (see runLogs.resolvePricing).
export interface InflightTurn {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

export type BootStage = "loading" | "ready";

export interface InkState {
  messages: InkMessage[];
  assistantMessageIndexes: Record<string, number>;
  liveAssistantId: string | null;
  pendingTurn: PendingTurn | null;
  activityItems: ActivityItem[];
  sessionStartMs: number;
  sessionGenerateMs: number;
  turnCount: number;
  stats: InkSessionStats;
  inflight: InflightTurn;
  provider: string;
  model: string;
  pendingPermission: PermissionRequest | null;
  bootStage: BootStage;
  bootMessage: string;
  bootStartedAt: number;
}

const EMPTY_INFLIGHT: InflightTurn = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };

function computeInflight(
  state: { provider: string; model: string },
  partial: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number },
  previous: InflightTurn,
): InflightTurn {
  const next: InflightTurn = {
    promptTokens: partial.promptTokens ?? previous.promptTokens,
    completionTokens: partial.completionTokens ?? previous.completionTokens,
    reasoningTokens: partial.reasoningTokens ?? previous.reasoningTokens,
    costUsd: previous.costUsd,
  };
  if (state.provider && state.model) {
    next.costUsd = estimateRunCost({
      provider: state.provider,
      model: state.model,
      promptTokens: next.promptTokens,
      completionTokens: next.completionTokens,
      reasoningTokens: next.reasoningTokens,
    }).usd;
  }
  return next;
}

export interface InitialInkStateOptions {
  provider?: string | undefined;
  model?: string | undefined;
  now?: number | undefined;
  initialMessages?: InkMessage[] | undefined;
  initialStats?: InkSessionStats | undefined;
  initialGenerateMs?: number | undefined;
  initialTurnCount?: number | undefined;
}

export type InkAction =
  | { type: "user_message"; content: string; timestampMs: number }
  | { type: "system_message"; content: string; timestampMs?: number }
  | { type: "assistant_start"; id: string; timestampMs: number; elapsedMs: number }
  | { type: "assistant_delta"; id: string; text: string }
  | { type: "turn_start"; startedAt: number }
  | { type: "turn_progress"; promptTokens?: number; completionTokens?: number; reasoningTokens?: number }
  | { type: "turn_complete"; elapsedMs: number; promptTokens?: number; completionTokens?: number; reasoningTokens?: number; costUsd?: number | null }
  | { type: "turn_error"; message: string }
  | { type: "activity_start"; item: ActivityItem }
  | { type: "activity_progress"; id: string; text: string }
  | { type: "activity_end"; id: string; summary: string; status: "done" | "error"; endedAt: number }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_clear" }
  | { type: "boot_progress"; message: string }
  | { type: "boot_complete" }
  | { type: "replace_session"; messages: InkMessage[]; stats: InkSessionStats; generateMs: number; turnCount: number }
  | { type: "clear" };

export function createInitialInkState(options: InitialInkStateOptions = {}): InkState {
  const now = options.now ?? Date.now();
  const warmupMessages: InkMessage[] = options.provider && options.model
    ? [{
        id: `system-connect-${now}`,
        role: "system",
        content: `Tanya · connecting to ${options.provider}:${options.model}…`,
        timestampMs: now,
      }]
    : [];
  const messages = [...warmupMessages, ...(options.initialMessages ?? [])];
  return {
    messages,
    assistantMessageIndexes: {},
    liveAssistantId: null,
    pendingTurn: null,
    activityItems: [],
    sessionStartMs: now,
    sessionGenerateMs: options.initialGenerateMs ?? 0,
    turnCount: options.initialTurnCount ?? 0,
    stats: options.initialStats ?? { costUsd: 0, totalTokens: 0 },
    inflight: { ...EMPTY_INFLIGHT },
    provider: options.provider ?? "",
    model: options.model ?? "",
    pendingPermission: null,
    bootStage: "loading",
    bootMessage: "Preparing Tanya…",
    bootStartedAt: now,
  };
}

export function inkReducer(state: InkState, action: InkAction): InkState {
  switch (action.type) {
    case "user_message":
      return {
        ...state,
        messages: [...state.messages, {
          id: `user-${action.timestampMs}-${state.messages.length}`,
          role: "user",
          content: action.content,
          timestampMs: action.timestampMs,
        }],
      };
    case "system_message":
      return {
        ...state,
        messages: [...state.messages, {
          id: `system-${action.timestampMs ?? Date.now()}-${state.messages.length}`,
          role: "system",
          content: action.content,
          timestampMs: action.timestampMs ?? Date.now(),
        }],
      };
    case "assistant_start":
      if (state.messages.some((message) => message.id === action.id)) return state;
      return {
        ...state,
        pendingTurn: state.pendingTurn ? { ...state.pendingTurn, spinnerVisible: false } : state.pendingTurn,
        messages: [...state.messages, {
          id: action.id,
          role: "assistant",
          content: "",
          timestampMs: action.timestampMs,
          elapsedMs: action.elapsedMs,
        }],
        assistantMessageIndexes: {
          ...state.assistantMessageIndexes,
          [action.id]: state.messages.length,
        },
        liveAssistantId: action.id,
      };
    case "assistant_delta": {
      const cachedIndex = state.assistantMessageIndexes[action.id];
      const index = cachedIndex !== undefined && state.messages[cachedIndex]?.id === action.id
        ? cachedIndex
        : state.messages.findIndex((message) => message.id === action.id);
      if (index < 0) return state;
      const messages = state.messages.slice();
      const message = messages[index]!;
      messages[index] = { ...message, content: `${message.content}${action.text}` };
      return {
        ...state,
        messages,
        ...(cachedIndex === index ? {} : {
          assistantMessageIndexes: {
            ...state.assistantMessageIndexes,
            [action.id]: index,
          },
        }),
      };
    }
    case "turn_start":
      return { ...state, pendingTurn: { startedAt: action.startedAt, spinnerVisible: true }, activityItems: [], inflight: { ...EMPTY_INFLIGHT } };
    case "turn_progress":
      return { ...state, inflight: computeInflight(state, action, state.inflight) };
    case "turn_complete": {
      const turnTokens = (action.promptTokens ?? 0) + (action.completionTokens ?? 0) + (action.reasoningTokens ?? 0);
      const currentCost = state.stats.costUsd ?? 0;
      const currentTokens = state.stats.totalTokens ?? 0;
      return {
        ...state,
        liveAssistantId: null,
        pendingTurn: null,
        activityItems: [],
        sessionGenerateMs: state.sessionGenerateMs + action.elapsedMs,
        turnCount: state.turnCount + 1,
        stats: {
          costUsd: action.costUsd === null || action.costUsd === undefined ? state.stats.costUsd : currentCost + action.costUsd,
          totalTokens: turnTokens > 0 ? currentTokens + turnTokens : state.stats.totalTokens,
        },
        inflight: { ...EMPTY_INFLIGHT },
      };
    }
    case "turn_error":
      return {
        ...state,
        liveAssistantId: null,
        pendingTurn: null,
        activityItems: [],
        inflight: { ...EMPTY_INFLIGHT },
        messages: [...state.messages, {
          id: `error-${Date.now()}-${state.messages.length}`,
          role: "system",
          content: `Error: ${action.message}`,
          timestampMs: Date.now(),
        }],
      };
    case "activity_start":
      return {
        ...state,
        activityItems: [...state.activityItems, action.item],
      };
    case "activity_progress":
      return {
        ...state,
        activityItems: state.activityItems.map((item) => item.id === action.id
          ? { ...item, content: `${item.content ?? ""}${action.text}` }
          : item),
      };
    case "activity_end":
      return {
        ...state,
        activityItems: state.activityItems.map((item) => item.id === action.id
          ? { ...item, status: action.status, summary: action.summary, endedAt: action.endedAt }
          : item),
      };
    case "permission_request":
      return { ...state, pendingPermission: action.request };
    case "permission_clear":
      return { ...state, pendingPermission: null };
    case "boot_progress":
      return { ...state, bootMessage: action.message };
    case "boot_complete":
      return { ...state, bootStage: "ready" };
    case "replace_session":
      return {
        ...state,
        messages: action.messages,
        assistantMessageIndexes: {},
        liveAssistantId: null,
        pendingTurn: null,
        activityItems: [],
        sessionGenerateMs: action.generateMs,
        turnCount: action.turnCount,
        stats: action.stats,
        inflight: { ...EMPTY_INFLIGHT },
      };
    case "clear":
      return { ...state, messages: [], assistantMessageIndexes: {}, liveAssistantId: null, activityItems: [] };
    default:
      return state;
  }
}
