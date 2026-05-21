import { describe, expect, it } from "vitest";
import { autoCompact, estimateCompactTokens, microcompact, snipLowSignal } from "../compact";
import type { ChatMessage, ToolCall } from "../../providers/types";

function readFileCall(id: string, path: string, payload: string): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path, payload }),
    },
  };
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

describe("microcompact", () => {
  it("folds oldest noop tool-call pairs without dropping user or assistant prose", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt with skill packs" },
      { role: "user", content: "important user prose before tools" },
      { role: "assistant", content: "important assistant prose before tools" },
    ];
    for (let i = 0; i < 30; i += 1) {
      const id = `call-${i}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [readFileCall(id, `src/file-${i}.ts`, "x".repeat(7_000))],
      });
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: i % 2 === 0 ? "" : "{\"ok\":true}",
      });
    }
    messages.push({ role: "user", content: "important user prose after tools" });

    const beforeTokens = estimateCompactTokens(messages);
    expect(beforeTokens).toBeGreaterThan(50_000);

    const result = microcompact(messages, {
      tokenBudget: Math.floor(beforeTokens * 0.7),
      foldRatio: 1,
    });

    expect(result.foldedPairs).toBeGreaterThan(0);
    expect(result.removedTokens).toBeGreaterThanOrEqual(Math.floor(beforeTokens * 0.2));
    expect(result.messages[0]).toEqual(messages[0]);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain("important user prose before tools");
    expect(serialized).toContain("important assistant prose before tools");
    expect(serialized).toContain("important user prose after tools");
    expect(serialized).toContain("<1 tool-call(s) folded; outputs were empty or noop>");

    const beforeIndex = result.messages.findIndex((message) => message.content === "important user prose before tools");
    const markerIndex = result.messages.findIndex((message) => message.content?.startsWith("<1 tool-call"));
    const afterIndex = result.messages.findIndex((message) => message.content === "important user prose after tools");
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(beforeIndex);
    expect(afterIndex).toBeGreaterThan(markerIndex);
  });
});

describe("snipLowSignal", () => {
  it("drops noop read-only tool outputs and their pure assistant wrappers", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: null, tool_calls: [toolCall("list-1", "list_files", { path: "src" })] },
      { role: "tool", tool_call_id: "list-1", content: "{\"ok\":true,\"summary\":\"\"}" },
      { role: "user", content: "keep this request" },
    ];

    const result = snipLowSignal(messages);

    expect(result.snippedCount).toBe(2);
    expect(result.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "keep this request" },
    ]);
  });

  it("does not snip noop-looking side-effect tool outputs", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: null, tool_calls: [toolCall("write-1", "write_file", { path: "src/app.ts", content: "" })] },
      { role: "tool", tool_call_id: "write-1", content: "{\"ok\":true}" },
    ];

    const result = snipLowSignal(messages);

    expect(result.snippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("keeps only the latest repeated read_file call for the same path", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
    for (let i = 0; i < 10; i += 1) {
      const id = `read-${i}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [toolCall(id, "read_file", { path: "package.json" })],
      });
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: `{"ok":true,"content":"version ${i}"}`,
      });
    }

    const result = snipLowSignal(messages);
    const serialized = JSON.stringify(result.messages);

    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(serialized).toContain("read-9");
    expect(serialized).toContain("version 9");
    expect(serialized).not.toContain("read-0");
    expect(serialized).not.toContain("version 0");
  });
});

describe("compaction skill-pack preservation", () => {
  it("preserves active skill-pack system blocks through microcompact, snip, and autoCompact", async () => {
    const skillPack = "[skill-pack: framework/nextjs-app-router]\nUse app router conventions.";
    const messages: ChatMessage[] = [
      { role: "system", content: "base system prompt" },
      { role: "system", content: skillPack },
      { role: "user", content: "latest task" },
      { role: "assistant", content: null, tool_calls: [toolCall("list-1", "list_files", { path: "src" })] },
      { role: "tool", tool_call_id: "list-1", content: "{\"ok\":true}" },
      { role: "assistant", content: "durable implementation note" },
    ];

    const micro = microcompact(messages, { tokenBudget: 10, foldRatio: 1 });
    expect(micro.messages.some((message) => message.content === skillPack)).toBe(true);

    const snipped = snipLowSignal(micro.messages);
    expect(snipped.messages.some((message) => message.content === skillPack)).toBe(true);

    const compacted = await autoCompact(snipped.messages, {
      provider: {
        id: "test",
        model: "summary",
        async *streamChat() {
          yield { content: "implementation note summarized" };
        },
      },
      aggression: "normal",
    });

    expect(compacted.messages.filter((message) => message.role === "system").map((message) => message.content)).toContain(skillPack);
  });
});
