import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import { FileReadDedupCache } from "../../memory/fileReadDedup";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-file-dedup-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "big.txt"), "important content\n".repeat(400));
  return root;
}

describe("file-read deduplication", () => {
  it("returns an unchanged-file marker on repeated read_file calls in one run", async () => {
    const cwd = makeProject();
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield { toolCalls: [toolCall("read-1", "read_file", { path: "src/big.txt" })] };
          return;
        }
        if (requests.length === 2) {
          yield { toolCalls: [toolCall("read-2", "read_file", { path: "src/big.txt" })] };
          return;
        }
        yield { content: "Done." };
      },
    };

    await runAgent({ provider, prompt: "Read the same file twice.", cwd, sink: async () => {}, maxTurns: 3 });

    const secondReadMessage = requests[2]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "read-2");
    expect(secondReadMessage?.content).toContain("[file unchanged since turn 0, see tool_call read-1 for content]");
    expect((secondReadMessage?.content ?? "").length).toBeLessThan(500);
  });

  it("honors read_file force to bypass the marker and refresh the cache entry", async () => {
    const cwd = makeProject();
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield { toolCalls: [toolCall("read-1", "read_file", { path: "src/big.txt" })] };
          return;
        }
        if (requests.length === 2) {
          yield { toolCalls: [toolCall("read-2", "read_file", { path: "src/big.txt", force: true })] };
          return;
        }
        yield { content: "Done." };
      },
    };

    await runAgent({ provider, prompt: "Force reread.", cwd, sink: async () => {}, maxTurns: 3 });

    const secondReadMessage = requests[2]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "read-2");
    expect(secondReadMessage?.content).toContain("important content");
    expect(secondReadMessage?.content).not.toContain("file unchanged since turn");
  });

  it("clears the cache on compaction boundaries", async () => {
    const cwd = makeProject();
    const cache = new FileReadDedupCache(cwd);

    await cache.remember({ path: "src/big.txt" }, "read-1", 2);
    expect(cache.size()).toBe(1);
    expect(await cache.lookup({ path: "src/big.txt" })).not.toBeNull();

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(await cache.lookup({ path: "src/big.txt" })).toBeNull();
  });
});
