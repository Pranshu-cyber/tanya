import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";
import { failedVerificationBlockers } from "../report";
import { runAgent } from "../runner";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function scriptedProvider(turns: Array<{ content?: string; toolCalls?: ToolCall[] }>): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "test",
    model: "test-model",
    requests,
    async *streamChat(input) {
      requests.push({ ...input, messages: [...input.messages] });
      yield turns[Math.min(requests.length - 1, turns.length - 1)] ?? { content: "Done." };
    },
  };
}

describe("shell safety repair guidance", () => {
  it("does not turn safety-blocked cleanup into a final verification blocker", () => {
    expect(failedVerificationBlockers([
      "Verification: python3 app.py -> passed (Shell exited 0.)",
      "Verification: rm -rf .venv -> failed (Shell script rejected by safety checks.)",
    ])).toEqual([]);
  });

  it("passes shell-safety-specific repair guidance to the next model turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-shell-safety-repair-"));
    writeFileSync(join(cwd, "README.md"), "# fixture\n");
    const provider = scriptedProvider([
      { toolCalls: [toolCall("cleanup", "run_shell", { script: "rm -rf .mvp10" })] },
      { content: "Done." },
    ]);
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Clean temporary state.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    const event = events.find((item) => item.type === "tool_result" && item.id === "cleanup");
    expect(event).toEqual(expect.objectContaining({
      type: "tool_result",
      ok: false,
      reason: "shell_safety_block",
      error: expect.stringContaining("cleanup command was blocked"),
    }));
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "cleanup");
    expect(toolMessage?.content).toContain("cleanup command was blocked");
    expect(toolMessage?.content).toContain("cleanup isn't required for verification");
  });
});
