import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";
import { runAgent } from "../runner";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("network fallback repair loop", () => {
  it("pivots to mock fallback guidance after two network/dependency failures", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-network-fallback-"));
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield { toolCalls: [toolCall("pip-fail", "run_command", { command: "node", args: ["-e", "console.error('ENOTFOUND pypi.org'); process.exit(1)"] })] };
          return;
        }
        if (requests.length === 2) {
          yield { toolCalls: [toolCall("curl-fail", "run_command", { command: "node", args: ["-e", "console.error('ETIMEDOUT news.ycombinator.com'); process.exit(1)"] })] };
          return;
        }
        const sawFallback = input.messages.some((message) => typeof message.content === "string" && message.content.includes("Scaffold a local mock fallback"));
        if (!sawFallback) {
          yield { content: "Blocked: no fallback guidance." };
          return;
        }
        yield { toolCalls: [toolCall("write-mock", "write_file", { path: "stories.json", content: JSON.stringify({ stories: [{ title: "Mock HN story", url: "https://example.invalid" }] }, null, 2) })] };
        return;
      },
    };

    await runAgent({
      provider,
      prompt: "Build a network scraper.",
      cwd,
      sink: async () => {},
      maxTurns: 4,
      runContext: { task: { kind: "coding" } },
    });

    expect(requests[2]?.messages.at(-1)?.content).toContain("Network or dependency operations failed twice");
    expect(existsSync(join(cwd, "stories.json"))).toBe(true);
    expect(readFileSync(join(cwd, "stories.json"), "utf8")).toContain("Mock HN story");
  });
});
