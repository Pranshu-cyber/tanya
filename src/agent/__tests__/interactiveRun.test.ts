import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { ChatProvider, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// A coding-context run that, in interactive mode, finishes with a plain
// conversational reply (writes a file, then says it's done). We assert the
// user-facing message is NOT wrapped in the CLI machine coding-report format.
function makeProvider(): ChatProvider {
  let calls = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat() {
      calls += 1;
      if (calls === 1) {
        yield { toolCalls: [toolCall("c1", "write_file", { path: "Main.swift", content: 'print("hi")\n' })] };
        return;
      }
      yield { content: "All done — the app builds and runs." };
    },
  };
}

describe("interactive run mode", () => {
  it("returns a conversational reply, not the machine coding-report format", async () => {
    const result = await runAgent({
      provider: makeProvider(),
      prompt: "build a calculator app",
      cwd: mkdtempSync(join(tmpdir(), "tanya-interactive-")),
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
      interactive: true,
      maxTurns: 6,
    });
    expect(result.message).toContain("All done");
    // ensureCodingReport would have injected a `Verification: ... ->` / `Modified:` block.
    expect(result.message).not.toMatch(/Verification:\s*.+->/);
    expect(result.message).not.toMatch(/^Modified:/m);
  });
});
