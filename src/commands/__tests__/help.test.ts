import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCommand, runCommand } from "../index";
import { resetProjectCommandsForTests } from "../project";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

afterEach(() => {
  resetProjectCommandsForTests();
});

describe("/help command", () => {
  it("groups built-ins and hides unavailable commands", async () => {
    registerCommand({
      name: "hidden-test",
      description: "Should not appear.",
      category: "built-in",
      availability: () => false,
      handler: () => {},
    });
    const output = new MemoryStream();

    await runCommand("/help", ctx(mkdtempSync(join(tmpdir(), "tanya-help-command-")), output));

    const text = output.chunks.join("");
    expect(text).toContain("Built-in commands:");
    expect(text).toContain("/help — List available slash commands.");
    expect(text).not.toContain("hidden-test");
    expect(text).not.toContain("Project commands:");
  });
});

function ctx(cwd: string, output: MemoryStream) {
  return {
    cwd,
    output: output as unknown as NodeJS.WritableStream,
    sink: () => {},
  };
}
