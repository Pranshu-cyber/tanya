import { Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchInteractiveCommand } from "../../agent/chat";
import { parseCommandLine, runCommand } from "../index";
import type { TanyaEvent } from "../../events/types";

class MemoryStream extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

function commandContext(output = new MemoryStream()) {
  const events: TanyaEvent[] = [];
  return {
    ctx: {
      cwd: mkdtempSync(join(tmpdir(), "tanya-command-parser-")),
      output,
      sink: (event: TanyaEvent) => {
        events.push(event);
      },
    },
    events,
    output,
  };
}

describe("slash command parser", () => {
  it("parses command names and quoted args", () => {
    expect(parseCommandLine("/help")).toEqual({ name: "help", args: [] });
    expect(parseCommandLine('/project:say-hi "Ada Lovelace" --loud')).toEqual({
      name: "project:say-hi",
      args: ["Ada Lovelace", "--loud"],
    });
    expect(parseCommandLine("ask /help")).toBeNull();
  });

  it("returns false for unknown slash commands", async () => {
    const { ctx, events } = commandContext();

    await expect(runCommand("/foo", ctx)).resolves.toBe(false);

    expect(events).toEqual([]);
  });

  it("handles /help and emits command_invoked", async () => {
    const { ctx, events, output } = commandContext();

    await expect(runCommand("/help", ctx)).resolves.toBe(true);

    expect(events).toContainEqual({ type: "command_invoked", name: "help", args: [] });
    expect(output.chunks.join("")).toContain("/help");
  });

  it("prints unknown command from the interactive REPL without hitting the model", async () => {
    const output = new MemoryStream();
    const { ctx } = commandContext(output);

    await expect(dispatchInteractiveCommand("/foo", ctx)).resolves.toBe(true);

    expect(output.chunks.join("")).toContain("unknown command: /foo; try /help");
  });
});
