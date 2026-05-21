import { appendProjectSpendRule } from "../../safety/permissions/config";
import { estimateRunCost, formatUsdWithCacheNote, readRunLogs, type RunLog } from "../../memory/runLogs";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

type BudgetSection = {
  name: "system prompt" | "repo map" | "history" | "tool results" | "model output" | "reasoning";
  tokens: number;
  usd: number | null;
  cacheModelKnown: boolean;
};

type ExpensiveTurn = {
  ts: string;
  provider: string;
  model: string;
  prompt: string;
  totalTokens: number;
  usd: number | null;
  cacheModelKnown: boolean;
  sections: BudgetSection[];
};

type BudgetSummary = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  knownUsd: number;
  cacheModelKnown: boolean;
  unknownPricingRuns: number;
  projectedUsdPerHour: number | null;
  byProvider: Array<{ provider: string; inputTokens: number; outputTokens: number; usd: number | null; cacheModelKnown: boolean; unknownRuns: number }>;
  expensiveTurns: ExpensiveTurn[];
  suggestion: string;
};

const numberFormat = new Intl.NumberFormat("en-US");

const budgetCommand: CommandDefinition = {
  name: "budget",
  description: "Show session token spend, expensive turns, and optimization suggestions.",
  category: "built-in",
  handler(args, ctx) {
    if (args.includes("--enforce")) {
      const maxUsd = parsePositiveNumber(flagValue(args, "--max-usd"));
      const maxTokens = parsePositiveNumber(flagValue(args, "--max-tokens"));
      if (maxUsd === undefined && maxTokens === undefined) {
        ctx.output.write("Usage: /budget --enforce --max-usd <amount> [--max-tokens <count>]\n");
        return;
      }
      const path = appendProjectSpendRule(ctx.cwd, {
        type: "spend",
        scope: "session",
        ...(maxUsd !== undefined ? { max_usd: maxUsd } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        action: "ask",
      });
      ctx.output.write(`Session budget rule written to ${path}\n`);
      return;
    }

    const logs = readRunLogs(ctx.cwd, 100);
    if (logs.length === 0) {
      ctx.output.write("No run logs found. Run tanya run first.\n");
      return;
    }
    const summary = buildBudgetSummary(logs);
    if (args.includes("--json")) {
      ctx.output.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    ctx.output.write(formatBudgetSummary(summary));
  },
};

export function buildBudgetSummary(logs: RunLog[], now = Date.now()): BudgetSummary {
  const inputTokens = logs.reduce((sum, log) => sum + log.promptTokens, 0);
  const outputTokens = logs.reduce((sum, log) => sum + log.completionTokens, 0);
  const reasoningTokens = logs.reduce((sum, log) => sum + (log.reasoningTokens ?? 0), 0);
  let knownUsd = 0;
  let cacheModelKnown = true;
  let unknownPricingRuns = 0;
  const byProvider = new Map<string, { provider: string; inputTokens: number; outputTokens: number; usd: number | null; cacheModelKnown: boolean; unknownRuns: number }>();

  for (const log of logs) {
    const estimate = estimateRunCost(log);
    if (estimate.usd === null) unknownPricingRuns += 1;
    else {
      knownUsd += estimate.usd;
      cacheModelKnown &&= estimate.cacheModelKnown;
    }
    const provider = estimate.provider;
    const current = byProvider.get(provider) ?? { provider, inputTokens: 0, outputTokens: 0, usd: 0, cacheModelKnown: true, unknownRuns: 0 };
    current.inputTokens += log.promptTokens;
    current.outputTokens += log.completionTokens;
    if (estimate.usd === null) {
      current.unknownRuns += 1;
      current.usd = current.usd === null ? null : current.usd;
    } else if (current.usd !== null) {
      current.usd += estimate.usd;
      current.cacheModelKnown &&= estimate.cacheModelKnown;
    }
    byProvider.set(provider, current);
  }

  const recentUsd = logs
    .filter((log) => now - Date.parse(log.ts) <= 30 * 60 * 1000)
    .reduce((sum, log) => sum + (estimateRunCost(log).usd ?? 0), 0);
  const projectedUsdPerHour = recentUsd > 0 ? recentUsd * 2 : null;
  const expensiveTurns = [...logs]
    .map(toExpensiveTurn)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.totalTokens - a.totalTokens)
    .slice(0, 3);

  return {
    runs: logs.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    knownUsd,
    cacheModelKnown,
    unknownPricingRuns,
    projectedUsdPerHour,
    byProvider: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    expensiveTurns,
    suggestion: budgetSuggestion(logs, expensiveTurns),
  };
}

function toExpensiveTurn(log: RunLog): ExpensiveTurn {
  const estimate = estimateRunCost(log);
  const provider = estimate.provider;
  const sections = budgetSections(log);
  return {
    ts: log.ts,
    provider,
    model: log.model,
    prompt: log.prompt,
    totalTokens: log.promptTokens + log.completionTokens + (log.reasoningTokens ?? 0),
    usd: estimate.usd,
    cacheModelKnown: estimate.cacheModelKnown,
    sections,
  };
}

function budgetSections(log: RunLog): BudgetSection[] {
  const systemPrompt = log.systemPromptTokens ?? 0;
  const repoMap = log.repoMapTokens ?? 0;
  const history = log.historyTokens ?? 0;
  const toolResults = log.toolResultTokens ?? 0;
  return [
    estimateSection("system prompt", systemPrompt, estimateInputCost(log, systemPrompt)),
    estimateSection("repo map", repoMap, estimateInputCost(log, repoMap)),
    estimateSection("history", history, estimateInputCost(log, history)),
    estimateSection("tool results", toolResults, estimateInputCost(log, toolResults)),
    estimateSection("model output", log.completionTokens, estimateOutputCost(log, log.completionTokens)),
    estimateSection("reasoning", log.reasoningTokens ?? 0, estimateOutputCost(log, log.reasoningTokens ?? 0)),
  ];
}

function estimateSection(name: BudgetSection["name"], tokens: number, estimate: ReturnType<typeof estimateRunCost>): BudgetSection {
  return { name, tokens, usd: estimate.usd, cacheModelKnown: estimate.cacheModelKnown };
}

function estimateInputCost(log: RunLog, tokens: number): ReturnType<typeof estimateRunCost> {
  if (tokens <= 0) return zeroCostEstimate(log);
  return estimateRunCost({ ...log, promptTokens: tokens, completionTokens: 0 });
}

function estimateOutputCost(log: RunLog, tokens: number): ReturnType<typeof estimateRunCost> {
  if (tokens <= 0) return zeroCostEstimate(log);
  return estimateRunCost({ ...log, promptTokens: 0, completionTokens: tokens });
}

function zeroCostEstimate(log: RunLog): ReturnType<typeof estimateRunCost> {
  const estimate = estimateRunCost({ ...log, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });
  return { ...estimate, usd: estimate.usd === null ? null : 0 };
}

function budgetSuggestion(logs: RunLog[], expensiveTurns: ExpensiveTurn[]): string {
  const top = expensiveTurns[0];
  if (!top) return "No suggestion yet; run a Tanya session first.";
  const systemPromptTokens = logs.reduce((sum, log) => sum + (log.systemPromptTokens ?? 0), 0);
  const toolResultTokens = logs.reduce((sum, log) => sum + (log.toolResultTokens ?? 0), 0);
  if (toolResultTokens > systemPromptTokens && toolResultTokens > 1_000) {
    return "Tool results dominate recent input tokens; rely on visible truncation markers and call expand_result only when the missing range is needed.";
  }
  if (systemPromptTokens > 0 && systemPromptTokens >= logs.reduce((sum, log) => sum + log.promptTokens, 0) * 0.25) {
    return "System prompts are a large share of input tokens; try TANYA_LITE_PROMPT=1 for cheap-provider exploration turns.";
  }
  return "Budget looks balanced; keep /budget in the loop when long sessions start repeating file reads or tool output.";
}

function formatBudgetSummary(summary: BudgetSummary): string {
  const lines = [
    "Session budget:",
    `- Runs: ${summary.runs}`,
    `- Input tokens: ${numberFormat.format(summary.inputTokens)}`,
    `- Output tokens: ${numberFormat.format(summary.outputTokens)}`,
    `- Reasoning tokens: ${numberFormat.format(summary.reasoningTokens)}`,
    `- Known spend: ${formatUsdWithCacheNote(summary.knownUsd, summary.cacheModelKnown)}${summary.unknownPricingRuns > 0 ? ` (${summary.unknownPricingRuns} run${summary.unknownPricingRuns === 1 ? "" : "s"} pricing unknown)` : ""}`,
    `- Projected cost/hour: ${summary.projectedUsdPerHour === null ? "pricing unknown" : formatUsdWithCacheNote(summary.projectedUsdPerHour, summary.cacheModelKnown)}`,
    "",
    "Providers:",
  ];
  for (const provider of summary.byProvider) {
    lines.push(`- ${provider.provider}: ${numberFormat.format(provider.inputTokens)} in / ${numberFormat.format(provider.outputTokens)} out, ${provider.usd === null ? "pricing unknown" : formatUsdWithCacheNote(provider.usd, provider.cacheModelKnown)}`);
  }
  lines.push("", "Top expensive turns:");
  for (const turn of summary.expensiveTurns) {
    lines.push(`- ${turn.ts.slice(0, 16)} ${turn.provider}:${turn.model} ${numberFormat.format(turn.totalTokens)} tokens ${turn.usd === null ? "pricing unknown" : formatUsdWithCacheNote(turn.usd, turn.cacheModelKnown)}`);
    for (const section of turn.sections) {
      lines.push(`  ${section.name}: ${numberFormat.format(section.tokens)} tokens, ${section.usd === null ? "pricing unknown" : formatUsdWithCacheNote(section.usd, section.cacheModelKnown)}`);
    }
  }
  lines.push("", `Suggestion: ${summary.suggestion}`, "");
  return lines.join("\n");
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

registerCommand(budgetCommand);
