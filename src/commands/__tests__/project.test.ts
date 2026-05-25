import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../index";
import { resetProjectCommandsForTests } from "../project";
import type { TanyaEvent } from "../../events/types";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const originalTanyaMode = process.env.TANYA_MODE;

afterEach(() => {
  resetProjectCommandsForTests();
  vi.restoreAllMocks();
  if (originalTanyaMode === undefined) delete process.env.TANYA_MODE;
  else process.env.TANYA_MODE = originalTanyaMode;
});

describe("project commands", () => {
  it("discovers shell commands, lists them in /help, and runs them", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, ".tanya", "commands", "say-hi.sh"), "printf 'hello %s' \"$1\"\n");
    const helpOutput = new MemoryStream();

    await runCommand("/help", ctx(workspace, helpOutput));

    expect(helpOutput.chunks.join("")).toContain("Project commands:");
    expect(helpOutput.chunks.join("")).toContain("/project:say-hi — Run .tanya/commands/say-hi.sh.");

    const runOutput = new MemoryStream();
    await expect(runCommand("/project:say-hi Ada", ctx(workspace, runOutput))).resolves.toBe(true);
    expect(runOutput.chunks.join("")).toContain("hello Ada");
  });

  it("skips malformed module commands without breaking command loading", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, ".tanya", "commands", "bad.js"), "export default { nope: true };\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = new MemoryStream();

    await expect(runCommand("/help", ctx(workspace, output))).resolves.toBe(true);

    expect(output.chunks.join("")).toContain("Built-in commands:");
    expect(warn).toHaveBeenCalled();
  });

  it("loads TypeScript module commands with a default CommandDefinition export", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, ".tanya", "commands", "wave.ts"), [
      "export default {",
      "  name: 'wave',",
      "  description: 'Wave from TypeScript.',",
      "  handler(_args: string[], ctx: { output: { write(chunk: string): void } }) {",
      "    ctx.output.write('wave from ts\\n');",
      "  },",
      "};",
      "",
    ].join("\n"));
    const output = new MemoryStream();

    await expect(runCommand("/project:wave", ctx(workspace, output))).resolves.toBe(true);

    expect(output.chunks.join("")).toContain("wave from ts");
  });

  it("gates project commands through the permission engine", async () => {
    process.env.TANYA_MODE = "ask";
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, ".tanya", "commands", "say-hi.sh"), "printf 'hello'\n");
    const output = new MemoryStream();
    const events: TanyaEvent[] = [];

    await expect(runCommand("/project:say-hi", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: (event) => { events.push(event); },
    })).resolves.toBe(true);

    expect(output.chunks.join("")).toContain("permission denied");
    expect(output.chunks.join("")).not.toContain("hello");
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_request",
      tool: "project_command",
    }));
  });
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "tanya-project-command-"));
  mkdirSync(join(workspace, ".tanya", "commands"), { recursive: true });
  return workspace;
}

function ctx(cwd: string, output: MemoryStream) {
  return {
    cwd,
    output: output as unknown as NodeJS.WritableStream,
    sink: () => {},
  };
}
