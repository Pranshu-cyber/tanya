import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateRunSummaryFiles, RUN_SUMMARY_MAX_FILES } from "../src/agent/runner";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "tanya-runs-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function seedFiles(count: number): void {
  for (let i = 0; i < count; i += 1) {
    // Lexicographically sortable timestamp-like name
    const name = `2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z.json`;
    writeFileSync(join(runsDir, name), JSON.stringify({ ts: name, idx: i }), "utf8");
  }
}

describe("rotateRunSummaryFiles", () => {
  it("does nothing when count <= max", () => {
    seedFiles(10);
    rotateRunSummaryFiles(runsDir);
    expect(readdirSync(runsDir).length).toBe(10);
  });

  it("trims to RUN_SUMMARY_MAX_FILES, keeping the newest (lexicographically largest) names", () => {
    const total = RUN_SUMMARY_MAX_FILES + 7;
    seedFiles(total);
    rotateRunSummaryFiles(runsDir);
    const remaining = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
    expect(remaining.length).toBe(RUN_SUMMARY_MAX_FILES);
    // Verify the kept files are the newest 50 — the last seeded file (highest idx) survives.
    expect(remaining.at(-1)).toBe(`2026-01-01T00-00-${String(total - 1).padStart(2, "0")}-000Z.json`);
    // And the oldest 7 were deleted.
    expect(remaining[0]).toBe(`2026-01-01T00-00-${String(7).padStart(2, "0")}-000Z.json`);
  });

  it("ignores non-json files", () => {
    seedFiles(3);
    writeFileSync(join(runsDir, "README.md"), "not a run", "utf8");
    rotateRunSummaryFiles(runsDir);
    expect(readdirSync(runsDir).length).toBe(4);
  });

  it("does not throw when directory does not exist", () => {
    expect(() => rotateRunSummaryFiles(join(runsDir, "does-not-exist"))).not.toThrow();
  });
});
