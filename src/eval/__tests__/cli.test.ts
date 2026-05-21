import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("eval CLI", () => {
  it("registers tanya eval and dry-runs eco-30 without provider credentials", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "eval",
        "--suite",
        "eco-30",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-chat",
        "--dry-run",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("Eval dry-run: eco-30@2026-05");
    expect(output).toContain("Tasks: 30");
    expect(output).toContain("Model: deepseek/deepseek-chat");
  });
});
