import { estimateRunCost, formatUsdWithCacheNote, readRunLogs } from "../../memory/runLogs";
import { appendProjectSpendRule } from "../../safety/permissions/config";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const costCommand: CommandDefinition = {
  name: "cost",
  description: "Show token usage and estimated run costs.",
  category: "built-in",
  handler(args, ctx) {
    if (args.includes("--enforce")) {
      const maxUsd = parsePositiveNumber(flagValue(args, "--max-usd"));
      const maxTokens = parsePositiveNumber(flagValue(args, "--max-tokens"));
      if (maxUsd === undefined && maxTokens === undefined) {
        ctx.output.write("Usage: /cost --enforce --max-usd <amount> [--max-tokens <count>]\n");
        return;
      }
      const path = appendProjectSpendRule(ctx.cwd, {
        type: "spend",
        scope: "session",
        ...(maxUsd !== undefined ? { max_usd: maxUsd } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        action: "deny",
      });
      ctx.output.write(`Session spend rule written to ${path}\n`);
      return;
    }

    const logs = readRunLogs(ctx.cwd);
    if (logs.length === 0) {
      ctx.output.write("No run logs found. Run tanya run first.\n");
      return;
    }

    let knownTotal = 0;
    let unknownCount = 0;
    let hasCacheMissEstimate = false;
    ctx.output.write("Recent run costs:\n");
    for (const log of logs) {
      const estimate = estimateRunCost(log);
      if (estimate.usd === null) {
        unknownCount += 1;
      } else {
        knownTotal += estimate.usd;
        hasCacheMissEstimate ||= !estimate.cacheModelKnown;
      }
      const reasoning = log.reasoningTokens ?? 0;
      ctx.output.write(
        `${log.ts.slice(0, 16)}  ${estimate.provider}:${log.model}  ${log.promptTokens.toLocaleString("en-US")} in / ${log.completionTokens.toLocaleString("en-US")} out / ${reasoning.toLocaleString("en-US")} reasoning  ${estimate.display}\n`,
      );
    }
    ctx.output.write(`Session total: ${formatUsdWithCacheNote(knownTotal, !hasCacheMissEstimate)}${unknownCount > 0 ? ` (${unknownCount} run${unknownCount === 1 ? "" : "s"} pricing unknown)` : ""}\n`);
  },
};

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

registerCommand(costCommand);
