import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../commands";
import { readGoldenTaskMemory } from "../../memory/goldenTasks";
import type { ChatProvider, ToolCall } from "../../providers/types";
import { runAgent } from "../runner";

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("sub-agent memory rollup", () => {
  it("records golden memory at the parent only and renders nested children", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-subagent-memory-"));
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user" && last.content === "Delegate three child tasks.") {
          yield {
            toolCalls: [
              toolCall("call-task-1", "task", { prompt: "inspect module one" }),
              toolCall("call-task-2", "task", { prompt: "inspect module two" }),
              toolCall("call-task-3", "task", { prompt: "inspect module three" }),
            ],
          };
          return;
        }
        if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("inspect module")) {
          yield { content: `Done ${last.content}.` };
          return;
        }
        yield { content: "Parent done." };
      },
    };

    await runAgent({
      provider,
      prompt: "Delegate three child tasks.",
      cwd,
      sink: async () => {},
      maxTurns: 3,
      runContext: {
        task: { kind: "coding", title: "Parent delegation" },
        metadata: { goldenTask: true },
      },
    });

    const records = await readGoldenTaskMemory(cwd);
    expect(records).toHaveLength(1);
    expect(records[0]?.childRunIds).toHaveLength(3);
    expect(records[0]?.childRunIds.every((runId) => /\.t-[123]$/.test(runId))).toBe(true);

    const output = new MemoryStream();
    await expect(runCommand(`/memory --full ${records[0]?.signature}`, {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("Child runs:");
    expect(text).toContain("  - ");
    expect(text).toContain("inspect module one");
    expect(text).toContain("inspect module two");
    expect(text).toContain("inspect module three");
  });
});
