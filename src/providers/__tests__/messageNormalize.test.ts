import { describe, expect, it } from "vitest";
import { normalizeMessages } from "../messageNormalize";
import type { ToolCall } from "../types";

const call = (id: string): ToolCall => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } });

describe("normalizeMessages", () => {
  it("drops orphan tool messages and preserves the rest of the conversation", () => {
    const result = normalizeMessages([
      { role: "user", content: "start" },
      { role: "tool", tool_call_id: "missing", content: "orphaned" },
      { role: "assistant", content: "still here" },
    ]);

    expect(result.messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: "still here" },
    ]);
    expect(result.droppedOrphans).toBe(1);
  });

  it("strips unanswered assistant tool calls without dropping the assistant message", () => {
    const result = normalizeMessages([
      { role: "assistant", content: "checking", tool_calls: [call("answered"), call("missing")] },
      { role: "tool", tool_call_id: "answered", content: "ok" },
    ]);

    expect(result.messages).toEqual([
      { role: "assistant", content: "checking", tool_calls: [call("answered")] },
      { role: "tool", tool_call_id: "answered", content: "ok" },
    ]);
    expect(result.filteredToolCalls).toBe(1);
  });

  it("deduplicates tool results with the same tool_call_id and keeps the most recent result", () => {
    const result = normalizeMessages([
      { role: "assistant", content: "", tool_calls: [call("abc")] },
      { role: "tool", tool_call_id: "abc", content: "old result" },
      { role: "tool", tool_call_id: "abc", content: "latest result" },
    ]);

    expect(result.messages).toEqual([
      { role: "assistant", content: "", tool_calls: [call("abc")] },
      { role: "tool", tool_call_id: "abc", content: "latest result" },
    ]);
    expect(result.droppedDuplicates).toBe(1);
  });

  it("coerces null assistant content to an empty string when tool calls are present", () => {
    const result = normalizeMessages([
      { role: "assistant", content: null, reasoning_content: "hidden chain", tool_calls: [call("abc")] },
      { role: "tool", tool_call_id: "abc", content: "ok" },
    ]);

    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "hidden chain",
      tool_calls: [call("abc")],
    });
    expect(result.coercedNullContent).toBe(1);
  });

  it("preserves reasoning_content on assistant turns without tool calls", () => {
    const result = normalizeMessages([
      { role: "assistant", content: "answer", reasoning_content: "opaque reasoning" },
    ]);

    expect(result.messages).toEqual([
      { role: "assistant", content: "answer", reasoning_content: "opaque reasoning" },
    ]);
  });

  it("reports counters for all normalization behaviors", () => {
    const result = normalizeMessages([
      { role: "user", content: "start" },
      { role: "tool", tool_call_id: "orphan", content: "drop" },
      { role: "assistant", content: null, tool_calls: [call("keep"), call("missing")] },
      { role: "tool", tool_call_id: "keep", content: "old" },
      { role: "tool", tool_call_id: "keep", content: "new" },
    ]);

    expect(result.droppedOrphans).toBe(1);
    expect(result.droppedDuplicates).toBe(1);
    expect(result.filteredToolCalls).toBe(1);
    expect(result.coercedNullContent).toBe(1);
    expect(result.warnings).toHaveLength(4);
  });
});
