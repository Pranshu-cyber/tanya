import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ToolCall } from "../providers/types";
import type { TanyaRunContext } from "../context/runContext";
import type { StepType } from "./types";

export interface RunnerStepState {
  messages?: ChatMessage[];
  lastAssistantMessage?: ChatMessage;
  lastToolResults?: ChatMessage[];
  pendingToolCalls?: Array<ToolCall | PendingTool>;
  depth?: number;
  turnIndex?: number;
  providerReasoningActive?: boolean;
  prompt?: string;
  cwd?: string;
  runContext?: TanyaRunContext;
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

  if (looksLikeCodeEditingTask(state)) return "tool_call";

  return "unknown";
}

export function looksLikeCodeEditingTask(state: Pick<RunnerStepState, "messages" | "prompt" | "cwd" | "runContext">): boolean {
  const runContext = state.runContext;
  if (runContext?.task?.kind === "coding") return true;
  if (runContext?.expected_report && Object.keys(runContext.expected_report).length > 0) return true;
  if (runContext?.verification?.commands?.length) return true;

  const taskText = [
    runContext?.task?.title,
    runContext?.task?.summary,
    runContext?.stack,
    ...(runContext?.languages ?? []),
    ...(runContext?.frameworks ?? []),
    state.prompt,
    ...userMessageContent(state.messages ?? []),
  ].filter(Boolean).join("\n");

  if (/\bgo-backend-[a-z0-9_-]+\b/i.test(taskText)) return true;
  if (/template\s*(?:id|ID)?\s*[:=]?\s*["'`]?go-backend-[a-z0-9_-]+/i.test(taskText)) return true;
  if (/EXISTING CODE DETECTED/i.test(taskText) && /\bEXECUTE\s+mode\b/i.test(taskText)) return true;

  return Boolean(state.cwd && isCodeWorkspace(state.cwd) && taskText.length > 1_200);
}

function isCodeWorkspace(cwd: string): boolean {
  return [
    "go.mod",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "Package.swift",
  ].some((marker) => existsSync(join(cwd, marker)));
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

function userMessageContent(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content ?? "");
}
