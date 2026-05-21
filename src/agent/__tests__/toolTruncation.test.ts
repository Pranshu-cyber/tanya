import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

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

describe("runner tool-result truncation", () => {
  it("truncates large run_shell output for model history while preserving verifier view", async () => {
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("large-shell", "run_shell", {
                script: "node -e \"process.stdout.write('a'.repeat(50000))\"",
                timeoutMs: 5_000,
              }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Run a large shell command.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-tool-truncate-")),
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    const secondRequestToolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    expect(secondRequestToolMessage?.content?.length).toBeLessThan(3_000);
    expect(secondRequestToolMessage?.content).toContain("<truncated");
    expect(secondRequestToolMessage?.content).toContain("tool_call_id=large-shell");
    expect(secondRequestToolMessage?.content).not.toContain("a".repeat(10_000));

    const resultEvent = events.find((event) => event.type === "tool_result" && event.id === "large-shell");
    expect(resultEvent).toMatchObject({
      type: "tool_result",
      id: "large-shell",
      tool: "run_shell",
      ok: true,
    });
    if (resultEvent?.type !== "tool_result") throw new Error("missing tool_result event");
    expect(JSON.stringify(resultEvent.modelView).length).toBeLessThan(3_000);
    expect(JSON.stringify(resultEvent.verifierView)).toContain("a".repeat(10_000));
  });

  it("lets expand_result fetch a cached full output after truncation", async () => {
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("large-shell", "run_shell", {
                script: "node -e \"process.stdout.write('b'.repeat(50000))\"",
                timeoutMs: 5_000,
              }),
            ],
          };
          return;
        }
        if (requests.length === 2) {
          yield { toolCalls: [toolCall("expand-1", "expand_result", { tool_call_id: "large-shell" })] };
          return;
        }
        yield { content: "Done." };
      },
    };

    await runAgent({
      provider,
      prompt: "Run and expand a large shell command.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-tool-expand-")),
      sink: async () => {},
      maxTurns: 3,
    });

    const expandToolMessage = requests[2]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "expand-1");
    expect(expandToolMessage?.content).toContain("b".repeat(10_000));
  });
});
