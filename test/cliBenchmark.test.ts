import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("benchmark CLI", () => {
  it("exposes golden profiles through the benchmark alias", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "benchmark", "profiles"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("Built-in golden task profiles:");
    expect(output).toContain("cosmohq.android.splash");
  });
});
