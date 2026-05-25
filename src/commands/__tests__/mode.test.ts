import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/mode command", () => {
  it("writes the selected project permission mode", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-mode-command-"));
    const output = new MemoryStream();

    await expect(runCommand("/mode ask", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const parsed = JSON.parse(readFileSync(join(workspace, ".tanya", "permissions.json"), "utf8")) as { mode?: string };
    expect(parsed.mode).toBe("ask");
    expect(output.chunks.join("")).toContain("Permission mode set to ask");
  });

  it("prints usage for invalid modes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-mode-invalid-"));
    const output = new MemoryStream();

    await runCommand("/mode stricter", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    });

    expect(output.chunks.join("")).toContain("Usage: /mode");
  });
});
