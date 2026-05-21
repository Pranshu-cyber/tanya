import type { EvalResult, EvalRunResult } from "./schemas";

export type EvalReportFormat = "text" | "markdown";

export function formatEvalReport(result: EvalResult, format: EvalReportFormat = "text"): string {
  const total = result.runs.length;
  const passed = result.runs.filter((run) => run.status === "passed").length;
  const failed = result.runs.filter((run) => run.status === "failed").length;
  const errored = result.runs.filter((run) => run.status === "errored").length;
  const timeout = result.runs.filter((run) => run.status === "timeout").length;
  const totalCost = result.runs.reduce((sum, run) => sum + run.costUsd, 0);
  const costPerTask = total > 0 ? totalCost / total : 0;
  const slowest = [...result.runs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  const costliest = [...result.runs].sort((a, b) => b.costUsd - a.costUsd).slice(0, 3);

  if (format === "markdown") {
    return [
      `## Eval Report: ${result.suite}`,
      "",
      `- Version: ${result.suiteVersion}`,
      `- Model: ${result.provider ? `${result.provider}/` : ""}${result.model}`,
      `- Pass rate: ${percent(passed, total)} (${passed}/${total})`,
      `- Status: ${passed} passed, ${failed} failed, ${errored} errored, ${timeout} timeout`,
      `- Total cost: ${usd(totalCost)}`,
      `- Cost/task: ${usd(costPerTask)}`,
      `- Reasoning share: ${((result.reasoningShare ?? 0) * 100).toFixed(1)}%`,
      "",
      markdownRunTable("Slowest tasks", slowest, "duration"),
      "",
      markdownRunTable("Costliest tasks", costliest, "cost"),
      "",
    ].join("\n");
  }

  return [
    `Eval report: ${result.suite}@${result.suiteVersion}`,
    `Model: ${result.provider ? `${result.provider}/` : ""}${result.model}`,
    `Pass rate: ${percent(passed, total)} (${passed}/${total})`,
    `Status: ${passed} passed, ${failed} failed, ${errored} errored, ${timeout} timeout`,
    `Total cost: ${usd(totalCost)}`,
    `Cost/task: ${usd(costPerTask)}`,
    `Reasoning share: ${((result.reasoningShare ?? 0) * 100).toFixed(1)}%`,
    "",
    "Slowest tasks:",
    ...slowest.map((run) => `- ${run.taskId}: ${seconds(run.durationMs)} (${run.status})`),
    "",
    "Costliest tasks:",
    ...costliest.map((run) => `- ${run.taskId}: ${usd(run.costUsd)} (${run.status})`),
    "",
  ].join("\n");
}

function markdownRunTable(title: string, runs: EvalRunResult[], metric: "duration" | "cost"): string {
  const rows = [
    `### ${title}`,
    "",
    "| Task | Status | Metric |",
    "| --- | --- | ---: |",
  ];
  for (const run of runs) {
    rows.push(`| \`${run.taskId}\` | ${run.status} | ${metric === "duration" ? seconds(run.durationMs) : usd(run.costUsd)} |`);
  }
  return rows.join("\n");
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}
