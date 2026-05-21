import { describe, expect, it } from "vitest";
import {
  TOOL_CALL_CORRECTION_LIMIT,
  malformedToolCallCorrectionMessage,
  parseProviderToolCalls,
  parseToolArguments,
} from "../parser";

describe("provider tool-call parser", () => {
  it("accepts stringified JSON arguments", () => {
    const parsed = parseProviderToolCalls([{
      id: "call_1",
      type: "function",
      function: {
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    }]);

    expect(parsed.failures).toEqual([]);
    expect(parsed.toolCalls[0]?.function.arguments).toBe("{\"path\":\"README.md\"}");
    expect(parseToolArguments(parsed.toolCalls[0]?.function.arguments)).toEqual({
      ok: true,
      input: { path: "README.md" },
    });
  });

  it("accepts object arguments by stringifying them", () => {
    const parsed = parseProviderToolCalls([{
      id: "call_1",
      function: {
        name: "read_file",
        arguments: { path: "README.md" },
      },
    }]);

    expect(parsed.failures).toEqual([]);
    expect(parsed.warnings.map((warning) => warning.reason)).toContain(
      "arguments arrived as object; stringified for OpenAI-compatible history",
    );
    expect(parsed.toolCalls[0]?.function.arguments).toBe("{\"path\":\"README.md\"}");
  });

  it("synthesizes missing ids", () => {
    const parsed = parseProviderToolCalls([{
      function: {
        name: "read_file",
        arguments: "{}",
      },
    }], { turn: 4 });

    expect(parsed.failures).toEqual([]);
    expect(parsed.toolCalls[0]?.id).toBe("call_4_0");
    expect(parsed.warnings[0]?.reason).toContain("missing tool call id");
  });

  it("accepts missing function wrappers", () => {
    const parsed = parseProviderToolCalls([{
      id: "call_1",
      name: "read_file",
      arguments: { path: "README.md" },
    }]);

    expect(parsed.failures).toEqual([]);
    expect(parsed.toolCalls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: {
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    });
    expect(parsed.warnings.some((warning) => warning.reason.includes("missing function wrapper"))).toBe(true);
  });

  it("reports malformed JSON arguments and builds the correction text", () => {
    const parsed = parseProviderToolCalls([{
      id: "call_1",
      function: {
        name: "read_file",
        arguments: "{\"path\":",
      },
    }]);

    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.failures[0]?.reason).toContain("malformed JSON arguments");
    expect(malformedToolCallCorrectionMessage(parsed.failures[0]!.reason)).toContain("Try again with valid JSON");
    expect(TOOL_CALL_CORRECTION_LIMIT).toBe(3);
  });
});
