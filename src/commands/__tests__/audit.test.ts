import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAuditDecision } from "../../memory/auditLog";
import { runCommand } from "../index";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/audit command", () => {
  it("prints recent decisions and filters denials", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-audit-command-"));
    appendAuditDecision(workspace, {
      ts: "2026-05-16T12:00:00.000Z",
      runId: "run-1",
      tool: "write_file",
      input: { path: "README.md" },
      decision: "allow",
      source: "engine",
      mode: "default",
    });
    appendAuditDecision(workspace, {
      ts: "2026-05-16T12:01:00.000Z",
      runId: "run-1",
      tool: "run_shell",
      input: { script: "rm -rf build" },
      decision: "deny",
      matchedRule: "run_shell:.*rm -rf.*",
      source: "rule",
      mode: "default",
    });
    const output = new MemoryStream();

    await expect(runCommand("/audit --deny-only", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("Recent permission decisions:");
    expect(text).toContain("deny");
    expect(text).toContain("run_shell:.*rm -rf.*");
    expect(text).not.toContain("write_file");
  });
});
