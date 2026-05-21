import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("/verify command", () => {
  it("prints the deterministic final-state report shape", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verify-command-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const ok = true;\n");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const output = new MemoryStream();

    await expect(runCommand("/verify", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("## Tanya deterministic report");
    expect(text).toContain("Tanya manifest:");
  });
});
