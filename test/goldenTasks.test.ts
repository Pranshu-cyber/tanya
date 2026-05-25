import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_GOLDEN_TASK_PROFILES } from "../src/golden/profiles";
import { goldenRunnableProfiles, runEditBlockFuzzyGoldenComparison, runGoldenTask } from "../src/golden/run";
import { buildGoldenTaskSummary, readGoldenTaskMemory, recordGoldenTaskMemory, validateGoldenTaskSummary } from "../src/memory/goldenTasks";

describe("golden task memory", () => {
  it("summarizes latest outcomes by task signature", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-golden-"));
    const context = {
      task: { kind: "coding", title: "Setup Environment - iOS" },
      metadata: { goldenTaskCandidate: true, caller: "test" },
    };

    await recordGoldenTaskMemory(root, {
      changedFiles: ["fastlane/Fastfile"],
      artifactsRead: [],
      artifactsCreated: [],
      verification: ["Verification: fastlane ios build -> passed"],
      blockers: ["old failure"],
      toolErrors: 1,
      validation: { passed: false, issues: [{ id: "old", severity: "error", message: "old" }] },
    }, context);
    await recordGoldenTaskMemory(root, {
      changedFiles: ["fastlane/Fastfile"],
      artifactsRead: [],
      artifactsCreated: [],
      verification: ["Verification: fastlane ios build -> passed"],
      blockers: [],
      toolErrors: 0,
      validation: { passed: true, issues: [] },
    }, context);

    expect(readFileSync(join(root, ".tanya/memory/golden-tasks.jsonl"), "utf8")).toContain("Setup Environment - iOS");
    const records = await readGoldenTaskMemory(root);
    const summary = buildGoldenTaskSummary(records);
    expect(summary.total).toBe(2);
    expect(summary.signatures).toBe(1);
    expect(validateGoldenTaskSummary(summary)).toEqual([]);
  });

  it("defines built-in reference-app regression profiles without making Tanya app-specific", () => {
    expect(BUILT_IN_GOLDEN_TASK_PROFILES.map((profile) => profile.id)).toEqual(expect.arrayContaining([
      "tanya.low.search-replace",
      "tanya.medium.artifact-component",
      "tanya.medium.streaming-long-tool",
    ]));
    expect(BUILT_IN_GOLDEN_TASK_PROFILES.every((profile) => profile.requiredCapabilities.length > 0)).toBe(true);
  });

  it("runs executable golden task fixtures through the Tanya tool loop", async () => {
    const executableProfileIds = goldenRunnableProfiles().map((profile) => profile.id);
    expect(executableProfileIds.length).toBeGreaterThanOrEqual(20);
    expect(executableProfileIds).toEqual(expect.arrayContaining([
      "tanya.low.search-replace",
      "tanya.medium.artifact-component",
      "tanya.medium.report-repair",
      "tanya.medium.dependency-install",
      "tanya.medium.framework-migration",
      "tanya.medium.failing-test-repair",
      "tanya.medium.frontend-smoke",
      "tanya.medium.run-log-history",
      "tanya.medium.streaming-long-tool",
      "tanya.medium.compaction-boundary",
      "tanya.medium.edit-block-fuzzy",
    ]));

    const result = await runGoldenTask("tanya.low.new-helper");
    expect(result.passed).toBe(true);
    expect(result.finalText).toContain("Tanya structured report:");
    expect(result.finalText).toContain("Modified: src/newHelper.ts");
  });

  it("runs generic low-to-medium benchmark fixtures", async () => {
    const low = await runGoldenTask("tanya.low.search-replace");
    expect(low.passed).toBe(true);
    expect(low.finalText).toContain("Modified: src/searchReplaceTarget.ts");

    const artifact = await runGoldenTask("tanya.medium.artifact-component");
    expect(artifact.passed).toBe(true);
    expect(artifact.finalText).toContain("Artifact reused: artifacts/generic/Pattern.md");

    const repair = await runGoldenTask("tanya.medium.report-repair");
    expect(repair.passed).toBe(true);
    expect(repair.finalText).toContain("Modified: src/reportRepair.ts");
  });

  it("runs extended real-world benchmark fixtures and records run history", async () => {
    const dependency = await runGoldenTask("tanya.medium.dependency-install");
    expect(dependency.passed).toBe(true);
    expect(dependency.finalText).toContain("Modified: package-lock.json");

    const migration = await runGoldenTask("tanya.medium.framework-migration");
    expect(migration.passed).toBe(true);
    expect(migration.finalText).toContain("Modified: src/app/page.tsx");

    const repair = await runGoldenTask("tanya.medium.failing-test-repair");
    expect(repair.passed).toBe(true);
    expect(repair.finalText).toContain("Modified: src/math.js");

    const frontend = await runGoldenTask("tanya.medium.frontend-smoke");
    expect(frontend.passed).toBe(true);
    expect(frontend.finalText).toContain("Modified: src/App.tsx");

    const runLog = await runGoldenTask("tanya.medium.run-log-history");
    expect(runLog.passed).toBe(true);
    const logFiles = readdirSync(join(runLog.workspace, ".tanya", "runs")).filter((file) => file.endsWith(".json"));
    expect(logFiles.length).toBe(1);
    const log = JSON.parse(readFileSync(join(runLog.workspace, ".tanya", "runs", logFiles[0] ?? ""), "utf8")) as {
      promptTokens: number;
      completionTokens: number;
      model: string;
    };
    expect(log.promptTokens).toBe(2_400);
    expect(log.completionTokens).toBe(620);
    expect(log.model).toBe("scripted");

    const compaction = await runGoldenTask("tanya.medium.compaction-boundary");
    expect(compaction.passed).toBe(true);
    expect(compaction.finalText).toContain("Modified: src/compactionBoundary.ts");
  }, 10_000);

  it("recovers a near-match golden task with fewer turns via fuzzy edit blocks", async () => {
    const { enabled, disabled } = await runEditBlockFuzzyGoldenComparison();
    expect(enabled.passed).toBe(true);
    expect(disabled.passed).toBe(true);
    expect(enabled.finalText).toContain("Modified: src/status.ts");
    expect(disabled.finalText).toContain("Modified: src/status.ts");
    expect(enabled.turns).toBeLessThan(disabled.turns);
  }, 10_000);
});
