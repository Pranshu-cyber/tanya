import { readCachedToolResult, type ResultByteRange } from "../memory/resultCache";
import type { TanyaTool } from "./types";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function asString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing string field: ${key}`);
  return value.trim();
}

function rangeFromInput(input: unknown): ResultByteRange | undefined {
  const range = asRecord(input).range;
  if (!range || typeof range !== "object" || Array.isArray(range)) return undefined;
  const record = range as Record<string, unknown>;
  const startByte = typeof record.startByte === "number" ? record.startByte : undefined;
  const endByte = typeof record.endByte === "number" ? record.endByte : undefined;
  if (startByte === undefined || endByte === undefined) return undefined;
  return { startByte, endByte };
}

export const expandResultTool: TanyaTool = {
  name: "expand_result",
  description: "Expand a previously truncated tool result by tool call id.",
  truncateLargeResults: false,
  definition: {
    type: "function",
    function: {
      name: "expand_result",
      description: "Fetch the full output, or a byte range, for a previously truncated tool result in this run.",
      parameters: {
        type: "object",
        properties: {
          tool_call_id: { type: "string", description: "Tool call id from the truncation marker." },
          range: {
            type: "object",
            description: "Optional byte range to return.",
            properties: {
              startByte: { type: "number" },
              endByte: { type: "number" },
            },
            required: ["startByte", "endByte"],
            additionalProperties: false,
          },
        },
        required: ["tool_call_id"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    if (!context.runId) {
      return {
        ok: false,
        summary: "No run id available for result expansion.",
        error: "expand_result can only be used inside an active Tanya run.",
      };
    }
    const toolCallId = asString(input, "tool_call_id");
    const content = await readCachedToolResult(context.workspace, context.runId, toolCallId, rangeFromInput(input));
    if (content === null) {
      return {
        ok: false,
        summary: `No cached result found for ${toolCallId}.`,
        error: "The result may have expired from the per-run cache or was never truncated.",
      };
    }
    return {
      ok: true,
      summary: `Expanded result ${toolCallId}.`,
      output: content,
    };
  },
};
