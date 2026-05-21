import type { ToolCall } from "./types";

export type ToolCallParseWarning = {
  reason: string;
  toolCallId?: string;
  tool?: string;
  raw?: unknown;
};

export type ToolCallParseFailure = {
  reason: string;
  toolCall: ToolCall;
  raw?: unknown;
};

export type ToolCallParseResult = {
  toolCalls: ToolCall[];
  warnings: ToolCallParseWarning[];
  failures: ToolCallParseFailure[];
};

export type ToolArgumentsParseResult =
  | { ok: true; input: unknown }
  | { ok: false; reason: string; rawArguments: string };

type RawToolCallRecord = Record<string, unknown>;

export const TOOL_CALL_CORRECTION_LIMIT = 3;

export function malformedToolCallCorrectionMessage(reason: string): string {
  return `[your last tool call was malformed: ${reason}. Try again with valid JSON.]`;
}

export function parseProviderToolCalls(rawToolCalls: unknown[], options: { turn?: number } = {}): ToolCallParseResult {
  const warnings: ToolCallParseWarning[] = [];
  const failures: ToolCallParseFailure[] = [];
  const toolCalls: ToolCall[] = [];

  rawToolCalls.forEach((raw, index) => {
    const parsed = parseOneToolCall(raw, index, options.turn ?? 0);
    warnings.push(...parsed.warnings);
    if (parsed.failure) {
      failures.push(parsed.failure);
      return;
    }
    toolCalls.push(parsed.toolCall);
  });

  return { toolCalls, warnings, failures };
}

export function parseToolArguments(rawArguments: unknown): ToolArgumentsParseResult {
  if (rawArguments === undefined || rawArguments === null || rawArguments === "") {
    return { ok: true, input: {} };
  }
  if (typeof rawArguments === "object") {
    return { ok: true, input: rawArguments };
  }
  if (typeof rawArguments !== "string") {
    return {
      ok: false,
      reason: `tool arguments must be JSON object or string, got ${typeof rawArguments}`,
      rawArguments: String(rawArguments),
    };
  }
  if (!rawArguments.trim()) return { ok: true, input: {} };
  try {
    return { ok: true, input: JSON.parse(rawArguments) };
  } catch {
    const preview = previewRawToolArguments(rawArguments);
    return {
      ok: false,
      reason: `malformed JSON arguments: ${preview}`,
      rawArguments: preview,
    };
  }
}

function parseOneToolCall(raw: unknown, index: number, turn: number): {
  toolCall: ToolCall;
  warnings: ToolCallParseWarning[];
  failure?: ToolCallParseFailure;
} {
  const warnings: ToolCallParseWarning[] = [];
  if (!isRecord(raw)) {
    const toolCall = fallbackToolCall(turn, index, "__malformed_tool_call__", "");
    return {
      toolCall,
      warnings,
      failure: { reason: `tool call must be an object, got ${typeof raw}`, toolCall, raw },
    };
  }

  const idValue = typeof raw.id === "string" && raw.id.trim() ? raw.id : undefined;
  const id = idValue ?? `call_${turn}_${index}`;
  if (!idValue) {
    warnings.push({
      reason: `missing tool call id; synthesized ${id}`,
      toolCallId: id,
      raw,
    });
  }

  const functionRecord = isRecord(raw.function) ? raw.function : raw;
  if (!isRecord(raw.function)) {
    warnings.push({
      reason: "missing function wrapper; accepted top-level name/arguments",
      toolCallId: id,
      raw,
    });
  }

  const name = typeof functionRecord.name === "string" ? functionRecord.name.trim() : "";
  if (!name) {
    const toolCall = fallbackToolCall(turn, index, "__malformed_tool_call__", stringifyArguments(functionRecord.arguments));
    return {
      toolCall,
      warnings,
      failure: { reason: "missing function name", toolCall, raw },
    };
  }

  const normalizedArguments = normalizeArguments(functionRecord.arguments, warnings, id, name, raw);
  const toolCall: ToolCall = {
    id,
    type: "function",
    function: {
      name,
      arguments: normalizedArguments,
    },
  };

  const parsedArguments = parseToolArguments(normalizedArguments);
  if (!parsedArguments.ok) {
    return {
      toolCall,
      warnings,
      failure: { reason: parsedArguments.reason, toolCall, raw },
    };
  }

  return { toolCall, warnings };
}

function normalizeArguments(
  value: unknown,
  warnings: ToolCallParseWarning[],
  toolCallId: string,
  tool: string,
  raw: unknown,
): string {
  if (value === undefined || value === null) {
    warnings.push({
      reason: "missing arguments; using empty object",
      toolCallId,
      tool,
      raw,
    });
    return "{}";
  }
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    warnings.push({
      reason: "arguments arrived as object; stringified for OpenAI-compatible history",
      toolCallId,
      tool,
      raw,
    });
    return JSON.stringify(value);
  }
  warnings.push({
    reason: `arguments arrived as ${typeof value}; stringified for correction`,
    toolCallId,
    tool,
    raw,
  });
  return String(value);
}

function stringifyArguments(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fallbackToolCall(turn: number, index: number, name: string, args: string): ToolCall {
  return {
    id: `call_${turn}_${index}`,
    type: "function",
    function: {
      name,
      arguments: args,
    },
  };
}

function previewRawToolArguments(raw: string): string {
  return raw.length > 500 ? `${raw.slice(0, 500)}...[truncated ${raw.length - 500} chars]` : raw;
}

function isRecord(value: unknown): value is RawToolCallRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
