import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("benchmark CLI", () => {
  it("exposes golden profiles through the benchmark alias", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "benchmark", "profiles"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TANYA_INTEGRATIONS_DIR: join(tmpdir(), "tanya-no-integrations-for-benchmark-test") },
      },
    );

    expect(output).toContain("Built-in golden task profiles:");
    expect(output).toContain("tanya.low.search-replace");
  });
});
