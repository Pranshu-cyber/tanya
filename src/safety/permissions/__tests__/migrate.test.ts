import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ALWAYS_ALLOW_SEED, suggestPermissionsFromRuns } from "../migrate";

describe("permissions migration helper", () => {
  it("builds a starter allow list from recent run logs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-permission-migrate-"));
    const runsDir = join(workspace, ".tanya", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "2026-05-16T12-00-00.json"), JSON.stringify({
      ts: "2026-05-16T12:00:00.000Z",
      model: "test",
      prompt: "edit",
      durationMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      changedFiles: ["src/app.ts", ".tanya/audit.jsonl"],
      blockers: [],
    }));

    const suggested = suggestPermissionsFromRuns(workspace);

    expect(suggested.mode).toBe("ask");
    expect(suggested.alwaysAllow).toEqual(expect.arrayContaining(BUILT_IN_ALWAYS_ALLOW_SEED));
    expect(suggested.alwaysAllow.some((pattern) => pattern.includes("src/app\\.ts"))).toBe(true);
    expect(suggested.alwaysAllow.some((pattern) => pattern.includes(".tanya"))).toBe(false);
    expect(suggested.alwaysAllow).toContain("run_command:.*node.*");
  });
});
