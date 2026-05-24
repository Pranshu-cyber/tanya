import type { ChatMessage, ChatProvider, ToolCall } from "../providers/types";
import { safeAppendArchive, toArchivedMessages } from "../memory/runArchive";

export type MicrocompactOptions = {
  tokenBudget: number;
  foldRatio?: number;
};

export type MicrocompactResult = {
  messages: ChatMessage[];
  removedTokens: number;
  foldedPairs: number;
  archivedMessages: ChatMessage[];
};

export type SnipLowSignalResult = {
  messages: ChatMessage[];
  snippedCount: number;
  archivedMessages: ChatMessage[];
};

export type CompactionAggression = "normal" | "heavy";

export type AutoCompactOptions = {
  provider: ChatProvider;
  model?: string;
  aggression: CompactionAggression;
  archive?: {
    workspace: string;
    runId: string;
    onError?: (err: Error) => void | Promise<void>;
  };
};

export type AutoCompactResult = {
  messages: ChatMessage[];
  removedTokens: number;
  summaryTokens: number;
  summary: string;
};

type FoldableGroup = {
  start: number;
  end: number;
  toolCalls: ToolCall[];
};

const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search", "glob"]);

export function estimateCompactTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function microcompact(messages: ChatMessage[], options: MicrocompactOptions): MicrocompactResult {
  const beforeTokens = estimateCompactTokens(messages);
  const groups = findFoldableGroups(messages);
  if (groups.length === 0) {
    return { messages: [...messages], removedTokens: 0, foldedPairs: 0, archivedMessages: [] };
  }

  const foldRatio = Math.max(0, Math.min(1, options.foldRatio ?? 0.2));
  const maxFoldedGroups = Math.max(1, Math.ceil(groups.length * foldRatio));
  const foldedStarts = new Map<number, FoldableGroup>();
  for (const group of groups.slice(0, maxFoldedGroups)) {
    foldedStarts.set(group.start, group);
  }

  const compacted: ChatMessage[] = [];
  const archivedMessages: ChatMessage[] = [];
  let foldedPairs = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const group = foldedStarts.get(i);
    if (!group) {
      const message = messages[i];
      if (message) compacted.push(message);
      continue;
    }

    foldedPairs += group.toolCalls.length;
    archivedMessages.push(...messages.slice(group.start, group.end + 1).filter((message): message is ChatMessage => Boolean(message)));
    compacted.push({
      role: "assistant",
      content: `<${group.toolCalls.length} tool-call(s) folded; outputs were empty or noop>`,
    });
    i = group.end;
    if (estimateCompactTokens(compacted.concat(messages.slice(i + 1))) <= options.tokenBudget) {
      for (let next = i + 1; next < messages.length; next += 1) {
        const message = messages[next];
        if (message) compacted.push(message);
      }
      const afterTokens = estimateCompactTokens(compacted);
      return {
        messages: compacted,
        removedTokens: Math.max(0, beforeTokens - afterTokens),
        foldedPairs,
        archivedMessages,
      };
    }
  }

  const afterTokens = estimateCompactTokens(compacted);
  return {
    messages: compacted,
    removedTokens: Math.max(0, beforeTokens - afterTokens),
    foldedPairs,
    archivedMessages,
  };
}

export function snipLowSignal(messages: ChatMessage[]): SnipLowSignalResult {
  const toolCallsById = new Map<string, { call: ToolCall; assistantIndex: number }>();
  const assistantCallIds = new Map<number, string[]>();
  const toolMessageIds = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isPureToolCallAssistant(message)) {
      const ids = message.tool_calls.map((call) => call.id);
      assistantCallIds.set(index, ids);
      for (const call of message.tool_calls) {
        toolCallsById.set(call.id, { call, assistantIndex: index });
      }
    }
    if (message?.role === "tool" && message.tool_call_id) {
      toolMessageIds.add(message.tool_call_id);
    }
  }

  const candidateSnippedToolIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const toolCall = toolCallsById.get(message.tool_call_id)?.call;
    if (!toolCall) continue;
    if (READ_ONLY_TOOL_NAMES.has(toolCall.function.name) && isNoopToolContent(message.content)) {
      candidateSnippedToolIds.add(message.tool_call_id);
    }
  }

  for (const duplicateId of duplicateReadFileCallIds(messages, toolCallsById)) {
    candidateSnippedToolIds.add(duplicateId);
  }

  const assistantIndicesToRemove = new Set<number>();
  const actualSnippedToolIds = new Set<string>();
  for (const [assistantIndex, callIds] of assistantCallIds) {
    const allCallsCanBeSnipped = callIds.length > 0 &&
      callIds.every((id) => candidateSnippedToolIds.has(id) && toolMessageIds.has(id));
    if (!allCallsCanBeSnipped) continue;
    assistantIndicesToRemove.add(assistantIndex);
    for (const id of callIds) actualSnippedToolIds.add(id);
  }

  if (assistantIndicesToRemove.size === 0 && actualSnippedToolIds.size === 0) {
    return { messages: [...messages], snippedCount: 0, archivedMessages: [] };
  }

  const snipped: ChatMessage[] = [];
  const archivedMessages: ChatMessage[] = [];
  let snippedCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const removeAssistant = assistantIndicesToRemove.has(index);
    const removeTool = message?.role === "tool" &&
      Boolean(message.tool_call_id && actualSnippedToolIds.has(message.tool_call_id));
    if (removeAssistant || removeTool) {
      snippedCount += 1;
      if (message) archivedMessages.push(message);
      continue;
    }
    if (message) snipped.push(message);
  }
  return { messages: snipped, snippedCount, archivedMessages };
}

export class CompactionExhaustedError extends Error {
  constructor(message = "Context compaction exhausted after repeated provider context-window failures.") {
    super(message);
    this.name = "CompactionExhaustedError";
  }
}

export async function autoCompact(messages: ChatMessage[], options: AutoCompactOptions): Promise<AutoCompactResult> {
  const indices = summarizableIndices(messages, options.aggression);
  if (indices.length === 0) {
    return { messages: [...messages], removedTokens: 0, summaryTokens: 0, summary: "" };
  }

  const summarized = indices.map((index) => messages[index]).filter((message): message is ChatMessage => Boolean(message));
  const summary = await summarizeMessages(options.provider, summarized, options);
  if (options.archive) {
    await safeAppendArchive(
      options.archive.runId,
      toArchivedMessages(summarized),
      { workspace: options.archive.workspace },
      options.archive.onError,
    );
  }
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `[compaction summary: ${summary}]`,
  };
  const skipped = new Set(indices);
  const firstSummaryIndex = indices[0] ?? 0;
  const compacted: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index === firstSummaryIndex) {
      compacted.push(summaryMessage);
    }
    if (skipped.has(index)) continue;
    const message = messages[index];
    if (message) compacted.push(message);
  }

  const beforeTokens = estimateCompactTokens(messages);
  const afterTokens = estimateCompactTokens(compacted);
  return {
    messages: compacted,
    removedTokens: Math.max(0, beforeTokens - afterTokens),
    summaryTokens: estimateCompactTokens([summaryMessage]),
    summary,
  };
}

function findFoldableGroups(messages: ChatMessage[]): FoldableGroup[] {
  const groups: FoldableGroup[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isPureToolCallAssistant(message)) continue;

    const expectedIds = new Set(message.tool_calls.map((call) => call.id));
    const toolResults: ChatMessage[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      const toolMessage = messages[j];
      if (!toolMessage?.tool_call_id || !expectedIds.has(toolMessage.tool_call_id)) break;
      toolResults.push(toolMessage);
      j += 1;
    }

    if (toolResults.length !== expectedIds.size) continue;
    if (!toolResults.every((toolMessage) => isNoopToolContent(toolMessage.content))) continue;

    groups.push({ start: i, end: j - 1, toolCalls: message.tool_calls });
    i = j - 1;
  }
  return groups;
}

function summarizableIndices(messages: ChatMessage[], aggression: CompactionAggression): number[] {
  const latestUserIndex = findLatestUserIndex(messages);
  const candidates: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    if (index === latestUserIndex) continue;
    candidates.push(index);
  }

  if (candidates.length === 0) return [];
  const ratio = aggression === "heavy" ? 0.75 : 0.5;
  return candidates.slice(0, Math.max(1, Math.floor(candidates.length * ratio)));
}

function findLatestUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

async function summarizeMessages(
  provider: ChatProvider,
  messages: ChatMessage[],
  options: AutoCompactOptions,
): Promise<string> {
  const rendered = JSON.stringify(messages, null, 2);
  const prompt = [
    "Summarize these older Tanya conversation turns for loss-minimizing context compaction.",
    "Keep durable decisions, file paths, tool effects, blockers, and verification facts.",
    "Do not include generic narration. Return a compact factual summary.",
    "",
    `Provider/model context: ${provider.id}/${options.model ?? provider.model}`,
    `Aggression: ${options.aggression}`,
    "",
    rendered,
  ].join("\n");

  let summary = "";
  for await (const delta of provider.streamChat({
    messages: [{ role: "user", content: prompt }],
    tools: [],
    temperature: 0,
    topP: 0.2,
    maxTokens: 1024,
  })) {
    if (delta.content) summary += delta.content;
  }
  return summary.trim() || "No summary returned.";
}

function duplicateReadFileCallIds(
  messages: ChatMessage[],
  toolCallsById: Map<string, { call: ToolCall; assistantIndex: number }>,
): Set<string> {
  const latestByPath = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const toolCall = toolCallsById.get(message.tool_call_id)?.call;
    if (!toolCall || toolCall.function.name !== "read_file") continue;
    const path = readFilePath(toolCall);
    if (!path) continue;
    const previousId = latestByPath.get(path);
    if (previousId) duplicates.add(previousId);
    latestByPath.set(path, message.tool_call_id);
  }
  return duplicates;
}

function readFilePath(toolCall: ToolCall): string | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const path = (parsed as { path?: unknown }).path;
    return typeof path === "string" && path.trim() ? path.trim() : null;
  } catch {
    return null;
  }
}

function isPureToolCallAssistant(message: ChatMessage | undefined): message is ChatMessage & { tool_calls: ToolCall[] } {
  return Boolean(
    message &&
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0 &&
    (message.content === null || message.content.trim() === ""),
  );
}

function isNoopToolContent(content: string | null): boolean {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) return true;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isNoopObject(parsed);
  } catch {
    return false;
  }
}

function isNoopObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1) return record.ok === true;
  if (keys.length === 2) return record.ok === true && record.summary === "";
  return false;
}
