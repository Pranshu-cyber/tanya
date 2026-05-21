import { describe, expect, it } from "vitest";
import { validateEvalSuite } from "../schemas";
import { dryRunEvalSuite, loadEvalSuite, listEvalSuites } from "../suites";

describe("eval suite ingestion", () => {
  it("loads the three M8 suites with valid shapes", () => {
    expect(listEvalSuites()).toEqual(["swe-bench-lite", "tanya-native", "cosmohq", "eco-30", "mvp", "verifier-self-test"]);
    for (const name of listEvalSuites()) {
      const suite = loadEvalSuite(name);
      expect(validateEvalSuite(suite).ok).toBe(true);
      const minimumTaskCount = name === "cosmohq" || name === "mvp" ? 10 : name === "verifier-self-test" ? 4 : 20;
      expect(suite.tasks.length).toBeGreaterThanOrEqual(minimumTaskCount);
    }
  });

  it("loads eco-30 as the token-economy benchmark", () => {
    const suite = loadEvalSuite("eco-30");
    expect(suite.tasks).toHaveLength(30);
    expect(suite.tasks.map((task) => task.id)).toContain("eco-01-long-file-read-dedup");
  });

  it("loads verifier-self-test with known pass/fail classifications", () => {
    const suite = loadEvalSuite("verifier-self-test");
    expect(suite.tasks.map((task) => task.metadata?.expectedVerifierVerdict)).toEqual(["passed", "failed", "failed", "passed"]);
  });

  it("loads mvp as the first-time user validation suite", () => {
    const suite = loadEvalSuite("mvp");
    expect(suite.tasks).toHaveLength(10);
    expect(suite.tasks.map((task) => task.id)).toEqual([
      "mvp-01",
      "mvp-02",
      "mvp-03",
      "mvp-04",
      "mvp-05",
      "mvp-06",
      "mvp-07",
      "mvp-08",
      "mvp-09",
      "mvp-10",
    ]);
    expect(suite.tasks.find((task) => task.id === "mvp-06")?.expected_files).toContain("output.csv");
  });

  it("produces deterministic dry-run estimates for known pricing", () => {
    const suite = loadEvalSuite("tanya-native");
    const dryRun = dryRunEvalSuite(suite, "deepseek", "deepseek-chat");
    expect(dryRun).toMatchObject({
      suite: "tanya-native",
      suiteVersion: "2026-05",
      taskCount: 25,
      model: "deepseek-chat",
    });
    expect(dryRun.estimatedCostUsd).toBeGreaterThan(0);
  });
});
