import type { ChatMessage, ToolCall } from "./types";

export type NormalizationResult = {
  messages: ChatMessage[];
  warnings: string[];
  droppedOrphans: number;
  droppedDuplicates: number;
  filteredToolCalls: number;
  coercedNullContent: number;
};

type ToolResultCandidate = {
  id: string;
  messageIndex: number;
  assistantIndex: number;
};

function toolCallId(call: ToolCall): string | null {
  return call.id.trim() ? call.id : null;
}

export function normalizeMessages(messages: ChatMessage[]): NormalizationResult {
  const lastAssistantByToolCallId = new Map<string, number>();
  const toolResultCandidates: ToolResultCandidate[] = [];
  let droppedOrphans = 0;

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        const id = toolCallId(call);
        if (id) lastAssistantByToolCallId.set(id, index);
      }
      continue;
    }

    if (message.role !== "tool") continue;

    const id = message.tool_call_id?.trim();
    const assistantIndex = id ? lastAssistantByToolCallId.get(id) : undefined;
    if (!id || assistantIndex === undefined) {
      droppedOrphans += 1;
      continue;
    }

    toolResultCandidates.push({ id, messageIndex: index, assistantIndex });
  }

  const latestToolResultById = new Map<string, ToolResultCandidate>();
  for (const candidate of toolResultCandidates) {
    const existing = latestToolResultById.get(candidate.id);
    if (!existing || candidate.messageIndex > existing.messageIndex) {
      latestToolResultById.set(candidate.id, candidate);
    }
  }

  const keptToolMessageIndexes = new Set<number>();
  const answeredToolCalls = new Set<string>();
  for (const candidate of latestToolResultById.values()) {
    keptToolMessageIndexes.add(candidate.messageIndex);
    answeredToolCalls.add(`${candidate.assistantIndex}:${candidate.id}`);
  }

  const droppedDuplicates = toolResultCandidates.length - keptToolMessageIndexes.size;
  let filteredToolCalls = 0;
  let coercedNullContent = 0;
  const normalized: ChatMessage[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      if (keptToolMessageIndexes.has(index)) normalized.push(message);
      continue;
    }

    if (message.role !== "assistant" || !message.tool_calls?.length) {
      normalized.push(message);
      continue;
    }

    const toolCalls = message.tool_calls.filter((call) => {
      const id = toolCallId(call);
      return Boolean(id && answeredToolCalls.has(`${index}:${id}`));
    });
    filteredToolCalls += message.tool_calls.length - toolCalls.length;

    const content = message.content === null ? "" : message.content;
    if (message.content === null) coercedNullContent += 1;

    const normalizedMessage: ChatMessage = { ...message, content };
    if (toolCalls.length > 0) {
      normalizedMessage.tool_calls = toolCalls;
    } else {
      delete normalizedMessage.tool_calls;
    }
    normalized.push(normalizedMessage);
  }

  const warnings = [
    droppedOrphans > 0 ? `dropped orphan tool messages: ${droppedOrphans}` : null,
    droppedDuplicates > 0 ? `dropped duplicate tool results: ${droppedDuplicates}` : null,
    filteredToolCalls > 0 ? `filtered unanswered tool calls: ${filteredToolCalls}` : null,
    coercedNullContent > 0 ? `coerced null assistant content: ${coercedNullContent}` : null,
  ].filter((message): message is string => Boolean(message));

  return {
    messages: normalized,
    warnings,
    droppedOrphans,
    droppedDuplicates,
    filteredToolCalls,
    coercedNullContent,
  };
}
