import type { EvalResult } from "./schemas";

export type EvalComparison = {
  baselineSuite: string;
  newSuite: string;
  costRegressionThreshold: number;
  regressions: Array<{ taskId: string; reason: string }>;
  improvements: Array<{ taskId: string; reason: string }>;
};

export function compareEvalResults(baseline: EvalResult, next: EvalResult, costRegressionThreshold = 0.20): EvalComparison {
  const baselineByTask = new Map(baseline.runs.map((run) => [run.taskId, run]));
  const regressions: EvalComparison["regressions"] = [];
  const improvements: EvalComparison["improvements"] = [];
  for (const run of next.runs) {
    const previous = baselineByTask.get(run.taskId);
    if (!previous) continue;
    if (previous.verifierVerdict === "passed" && run.verifierVerdict === "failed") {
      regressions.push({ taskId: run.taskId, reason: "verdict drift: passed -> failed" });
    }
    if (previous.status !== "errored" && run.status === "errored") {
      regressions.push({ taskId: run.taskId, reason: "new error" });
    }
    if (previous.status !== "timeout" && run.status === "timeout") {
      regressions.push({ taskId: run.taskId, reason: "new timeout" });
    }
    if (previous.costUsd > 0 && run.costUsd >= previous.costUsd * (1 + costRegressionThreshold)) {
      regressions.push({
        taskId: run.taskId,
        reason: `cost regression: ${usd(previous.costUsd)} -> ${usd(run.costUsd)} (+${(((run.costUsd / previous.costUsd) - 1) * 100).toFixed(1)}%)`,
      });
    }
    if (previous.verifierVerdict === "failed" && run.verifierVerdict === "passed") {
      improvements.push({ taskId: run.taskId, reason: "verdict improved: failed -> passed" });
    }
  }
  if (baseline.totalCostUsd > 0 && next.totalCostUsd >= baseline.totalCostUsd * (1 + costRegressionThreshold)) {
    regressions.push({
      taskId: "__suite__",
      reason: `suite cost regression: ${usd(baseline.totalCostUsd)} -> ${usd(next.totalCostUsd)}`,
    });
  }
  return {
    baselineSuite: `${baseline.suite}@${baseline.suiteVersion}`,
    newSuite: `${next.suite}@${next.suiteVersion}`,
    costRegressionThreshold,
    regressions,
    improvements,
  };
}

export function formatEvalComparison(comparison: EvalComparison, format: "text" | "markdown" = "text"): string {
  if (format === "markdown") {
    return [
      `## Eval Compare`,
      "",
      `- Baseline: ${comparison.baselineSuite}`,
      `- New: ${comparison.newSuite}`,
      `- Cost threshold: ${(comparison.costRegressionThreshold * 100).toFixed(0)}%`,
      `- Regressions: ${comparison.regressions.length}`,
      `- Improvements: ${comparison.improvements.length}`,
      "",
      markdownList("Regressions", comparison.regressions),
      "",
      markdownList("Improvements", comparison.improvements),
      "",
    ].join("\n");
  }
  return [
    `Eval compare: ${comparison.baselineSuite} -> ${comparison.newSuite}`,
    `Cost threshold: ${(comparison.costRegressionThreshold * 100).toFixed(0)}%`,
    `Regressions: ${comparison.regressions.length}`,
    ...comparison.regressions.map((item) => `- ${item.taskId}: ${item.reason}`),
    `Improvements: ${comparison.improvements.length}`,
    ...comparison.improvements.map((item) => `- ${item.taskId}: ${item.reason}`),
    "",
  ].join("\n");
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function markdownList(title: string, items: Array<{ taskId: string; reason: string }>): string {
  const lines = [`### ${title}`];
  if (items.length === 0) return [...lines, "", "None."].join("\n");
  return [...lines, "", ...items.map((item) => `- \`${item.taskId}\`: ${item.reason}`)].join("\n");
}
