import { readAuditDecisions } from "../../memory/auditLog";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const DEFAULT_LIMIT = 20;

const auditCommand: CommandDefinition = {
  name: "audit",
  description: "Show recent permission decisions.",
  category: "built-in",
  handler(args, ctx) {
    const limit = parseLimit(flagValue(args, "--limit"));
    const tool = flagValue(args, "--tool");
    const since = parseDuration(flagValue(args, "--since"));
    const entries = readAuditDecisions(ctx.cwd, {
      limit,
      denyOnly: args.includes("--deny-only"),
      ...(tool ? { tool } : {}),
      ...(since !== undefined ? { sinceMs: since } : {}),
    });
    if (entries.length === 0) {
      ctx.output.write("No permission audit entries found.\n");
      return;
    }

    ctx.output.write("Recent permission decisions:\n");
    for (const entry of entries) {
      const rule = entry.matchedRule ? ` ${entry.matchedRule}` : "";
      ctx.output.write(`${entry.ts.slice(0, 19)}  ${entry.decision.padEnd(5)}  ${entry.mode.padEnd(7)}  ${entry.tool}${rule}\n`);
    }
  },
};

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parseLimit(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : DEFAULT_LIMIT;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

registerCommand(auditCommand);
