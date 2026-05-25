import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runs CLI", () => {
  it("prints recent run logs with status, cost, and prompt", () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-cli-runs-"));
    const runsDir = join(root, ".tanya", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "2026-04-30T10-00-00.json"),
      JSON.stringify({
        ts: "2026-04-30T10:00:00.000Z",
        prompt: "add a hello function",
        model: "deepseek-chat",
        durationMs: 1500,
        promptTokens: 1200,
        completionTokens: 450,
        changedFiles: ["src/greet.ts"],
        blockers: [],
      }),
    );
    writeFileSync(
      join(runsDir, "2026-04-30T10-01-00.json"),
      JSON.stringify({
        ts: "2026-04-30T10:01:00.000Z",
        prompt: "fix the failing test",
        model: "deepseek-reasoner",
        durationMs: 3200,
        promptTokens: 4000,
        completionTokens: 1000,
        changedFiles: [],
        blockers: ["Tests failed after run"],
      }),
    );

    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "runs", "--cwd", root],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("BLOCKED");
    expect(output).toContain("OK");
    expect(output).toContain("fix the failing test");
    expect(output).toContain("add a hello function");
    expect(output).toContain("file(s)");
  });
});
