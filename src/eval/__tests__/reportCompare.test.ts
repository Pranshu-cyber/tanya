import { describe, expect, it } from "vitest";
import { compareEvalResults, formatEvalComparison } from "../compare";
import { formatEvalReport } from "../report";
import type { EvalResult } from "../schemas";

const baseline: EvalResult = {
  suite: "fixture",
  suiteVersion: "1",
  tanyaVersion: "test",
  model: "deepseek-chat",
  totalCostUsd: 0.03,
  costPerPass: 0.03,
  tokensPerPass: 12,
  reasoningShare: 0,
  runs: [
    { taskId: "a", status: "passed", durationMs: 1000, tokensUsed: { input: 10, output: 2 }, costUsd: 0.01, verifierVerdict: "passed" },
    { taskId: "b", status: "failed", durationMs: 2000, tokensUsed: { input: 20, output: 4 }, costUsd: 0.02, verifierVerdict: "failed" },
  ],
};

describe("eval reporting and comparison", () => {
  it("renders deterministic text and markdown reports", () => {
    expect(formatEvalReport(baseline)).toContain("Pass rate: 50.0% (1/2)");
    expect(formatEvalReport(baseline)).toContain("Cost/task: $0.0150");
    expect(formatEvalReport(baseline, "markdown")).toContain("| `b` | failed | $0.0200 |");
  });

  it("identifies verdict regressions and markdown output", () => {
    const next: EvalResult = {
      ...baseline,
      runs: [
        { ...baseline.runs[0]!, status: "failed", verifierVerdict: "failed", costUsd: 0.011 },
        { ...baseline.runs[1]!, status: "passed", verifierVerdict: "passed" },
      ],
    };
    const comparison = compareEvalResults(baseline, next);
    expect(comparison.regressions).toEqual([{ taskId: "a", reason: "verdict drift: passed -> failed" }]);
    expect(comparison.improvements).toEqual([{ taskId: "b", reason: "verdict improved: failed -> passed" }]);
    expect(formatEvalComparison(comparison, "markdown")).toContain("## Eval Compare");
  });

  it("flags cost regressions even when verdicts match", () => {
    const next: EvalResult = {
      ...baseline,
      totalCostUsd: 0.04,
      runs: [
        { ...baseline.runs[0]!, costUsd: 0.013 },
        baseline.runs[1]!,
      ],
    };
    const comparison = compareEvalResults(baseline, next, 0.20);
    expect(comparison.regressions.map((item) => item.reason)).toEqual(expect.arrayContaining([
      "cost regression: $0.0100 -> $0.0130 (+30.0%)",
      "suite cost regression: $0.0300 -> $0.0400",
    ]));
  });
});
