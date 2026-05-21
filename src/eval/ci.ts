import type { EvalComparison } from "./compare";

export function evalCiShouldFail(comparison: EvalComparison): boolean {
  return comparison.regressions.length > 0;
}

export function evalCiSummary(comparison: EvalComparison): string {
  const lines = [
    "## Tanya eval comparison",
    "",
    `Baseline: ${comparison.baselineSuite}`,
    `New: ${comparison.newSuite}`,
    `Regressions: ${comparison.regressions.length}`,
    `Improvements: ${comparison.improvements.length}`,
  ];
  if (comparison.regressions.length > 0) {
    lines.push("", "### Regressions");
    for (const regression of comparison.regressions) {
      lines.push(`- ${regression.taskId}: ${regression.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
