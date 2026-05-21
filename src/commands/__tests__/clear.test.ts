import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";
import type { ChatMessage } from "../../providers/types";
import type { TanyaEvent } from "../../events/types";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/clear command", () => {
  it("clears only the active conversation history", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const output = new MemoryStream();
    const events: TanyaEvent[] = [];

    await expect(runCommand("/clear", {
      cwd: mkdtempSync(join(tmpdir(), "tanya-clear-command-")),
      output: output as unknown as NodeJS.WritableStream,
      sink: (event) => {
        events.push(event);
      },
      history,
    })).resolves.toBe(true);

    expect(history).toEqual([]);
    expect(output.chunks.join("")).toContain("Conversation history cleared.");
    expect(events).toContainEqual({ type: "command_invoked", name: "clear", args: [] });
  });
});
