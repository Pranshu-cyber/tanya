import type { ChatMessage, ToolCall } from "../providers/types";
import type { StepType } from "./types";

export interface RunnerStepState {
  messages?: ChatMessage[];
  lastAssistantMessage?: ChatMessage;
  lastToolResults?: ChatMessage[];
  pendingToolCalls?: Array<ToolCall | PendingTool>;
  depth?: number;
  turnIndex?: number;
  providerReasoningActive?: boolean;
}

interface PendingTool {
  name?: string;
  preferredModel?: { match?: "tool_call" | "verification" };
  function?: { name?: string };
}

export function classifyStep(state: RunnerStepState): StepType {
  const lastAssistant = state.lastAssistantMessage ?? lastMessageWithRole(state.messages ?? [], "assistant");
  const pendingToolCalls = state.pendingToolCalls ?? lastAssistant?.tool_calls ?? [];

  if (hasVerificationTool(pendingToolCalls)) return "verification";
  if (hasActiveReasoning(state, lastAssistant)) return "reasoning";
  if (!lastAssistant || state.turnIndex === 0) return "planning";

  const content = textContent(lastAssistant);
  if (pendingToolCalls.length > 0 && content.trim() === "") return "tool_call";

  const toolResultsSinceUser = state.lastToolResults ?? messagesSinceLastUser(state.messages ?? []).filter((message) => message.role === "tool");
  if (content.trim() !== "" && pendingToolCalls.length === 0 && toolResultsSinceUser.length >= 2) {
    return "synthesis";
  }

  return "unknown";
}

function hasVerificationTool(toolCalls: Array<ToolCall | PendingTool>): boolean {
  return toolCalls.some((tool) => {
    if (isPreferredVerification(tool)) return true;
    const name = toolName(tool);
    return name === "verify" || name === "finalize" || name.startsWith("validate_");
  });
}

function hasActiveReasoning(state: RunnerStepState, lastAssistant: ChatMessage | undefined): boolean {
  if (state.providerReasoningActive) return true;
  const content = textContent(lastAssistant);
  const openThink = content.lastIndexOf("<think>");
  if (openThink === -1) return false;
  const closeThink = content.lastIndexOf("</think>");
  return closeThink < openThink;
}

function isPreferredVerification(tool: ToolCall | PendingTool): boolean {
  return "preferredModel" in tool && tool.preferredModel?.match === "verification";
}

function toolName(tool: ToolCall | PendingTool): string {
  if ("name" in tool && typeof tool.name === "string") return tool.name;
  if (tool.function?.name) return tool.function.name;
  return "";
}

function textContent(message: ChatMessage | undefined): string {
  return message?.content ?? "";
}

function lastMessageWithRole(messages: ChatMessage[], role: ChatMessage["role"]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return messages[index];
  }
  return undefined;
}

function messagesSinceLastUser(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index + 1);
  }
  return messages;
}
