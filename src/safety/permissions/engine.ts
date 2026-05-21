import { modeDefaultDecision } from "./modes";
import type { PathRule, PermissionMode, PermissionRulesConfig, SpendRule } from "./schema";
import { pathIsInsideWorkspace } from "../workspace";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface Decision {
  decision: PermissionDecision;
  matchedRule?: string;
  reason?: string;
  projectedCostUsd?: number;
  projectedTokens?: number;
  thresholdUsd?: number;
  thresholdTokens?: number;
}

export interface SpendState {
  turnTokens: number;
  runTokens: number;
  sessionTokens: number;
  projectedTokens?: number;
  turnUsd: number;
  runUsd: number;
  sessionUsd: number;
  projectedUsd?: number;
}

export interface PermissionContext {
  mode: PermissionMode;
  rules: PermissionRulesConfig;
  runId: string;
  cwd: string;
  parentContext?: PermissionContext;
  spendState?: SpendState;
}

export function decide(tool: string, input: unknown, ctx: PermissionContext): Decision {
  const local = decideLocal(tool, input, ctx);
  const parent = ctx.parentContext ? decide(tool, input, withoutParent(ctx.parentContext)) : null;
  if (!parent) return local;
  return stricter(parent, local);
}

export function inputShape(input: unknown): string {
  const stable = stableStringify(input);
  return stable.startsWith("{") && stable.endsWith("}") ? stable.slice(1, -1) : stable;
}

function decideLocal(tool: string, input: unknown, ctx: PermissionContext): Decision {
  if (ctx.mode === "bypass") return { decision: "allow", reason: "bypass-mode" };
  if (ctx.mode === "plan") return { decision: "deny", reason: "plan-mode" };

  const shape = inputShape(input);
  const deny = findMatchingPattern(tool, shape, ctx.rules.alwaysDeny);
  if (deny) return { decision: "deny", matchedRule: deny, reason: "alwaysDeny" };

  const allow = findMatchingPattern(tool, shape, ctx.rules.alwaysAllow);
  if (allow) return { decision: "allow", matchedRule: allow, reason: "alwaysAllow" };

  const ask = findMatchingPattern(tool, shape, ctx.rules.alwaysAsk);
  if (ask) return { decision: "ask", matchedRule: ask, reason: "alwaysAsk" };

  const pathDecision = decidePathRule(input, ctx.rules.pathRules, ctx.cwd);
  if (pathDecision) return pathDecision;

  const spendDecision = decideSpendRule(ctx.rules.spendRules, ctx.spendState);
  if (spendDecision) return spendDecision;

  return modeDefaultDecision(ctx.mode);
}

function findMatchingPattern(tool: string, shape: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const separator = pattern.indexOf(":");
    if (separator <= 0) continue;
    const patternTool = pattern.slice(0, separator);
    const regex = pattern.slice(separator + 1);
    if (patternTool === tool && new RegExp(regex).test(shape)) return pattern;
    if (patternTool === "mcp" && tool.startsWith("mcp:")) {
      const mcpShape = `${tool.slice("mcp:".length)}:${shape}`;
      if (new RegExp(regex).test(mcpShape)) return pattern;
    }
  }
  return null;
}

function decidePathRule(input: unknown, rules: PathRule[], cwd: string): Decision | null {
  const paths = extractPathValues(input);
  for (const path of paths) {
    for (const rule of rules) {
      if (!globMatches(rule.glob, path)) continue;
      return {
        decision: rule.action,
        matchedRule: `path:${rule.glob}`,
        reason: "pathRule",
      };
    }
    if (!pathIsInsideWorkspace(cwd, path)) {
      return {
        decision: "deny",
        matchedRule: "path:<outside-workspace>",
        reason: "outsideWorkspace",
      };
    }
  }
  return null;
}

function decideSpendRule(rules: SpendRule[], spendState: SpendState | undefined): Decision | null {
  if (!spendState || rules.length === 0) return null;
  const projectedTokens = spendState.projectedTokens ?? 0;
  const projectedUsd = spendState.projectedUsd ?? 0;
  for (const rule of rules) {
    const currentTokens = scopeTokens(rule.scope, spendState);
    const currentUsd = scopeUsd(rule.scope, spendState);
    const totalTokens = currentTokens + projectedTokens;
    const totalUsd = currentUsd + projectedUsd;
    if (rule.max_tokens !== undefined && totalTokens > rule.max_tokens) {
      return {
        decision: rule.action,
        matchedRule: `spend:${rule.scope}:max_tokens:${rule.max_tokens}`,
        reason: "spendRule",
        projectedTokens: totalTokens,
        thresholdTokens: rule.max_tokens,
        projectedCostUsd: totalUsd,
        ...(rule.max_usd !== undefined ? { thresholdUsd: rule.max_usd } : {}),
      };
    }
    if (rule.max_usd !== undefined && totalUsd > rule.max_usd) {
      return {
        decision: rule.action,
        matchedRule: `spend:${rule.scope}:max_usd:${rule.max_usd}`,
        reason: "spendRule",
        projectedCostUsd: totalUsd,
        thresholdUsd: rule.max_usd,
        projectedTokens: totalTokens,
        ...(rule.max_tokens !== undefined ? { thresholdTokens: rule.max_tokens } : {}),
      };
    }
  }
  return null;
}

function stricter(parent: Decision, child: Decision): Decision {
  if (parent.decision === "deny") return parent;
  if (child.decision === "deny") return child;
  if (parent.decision === "ask") return parent;
  if (child.decision === "ask") return child;
  return child;
}

function extractPathValues(input: unknown): string[] {
  const paths: string[] = [];
  collectPaths(input, paths);
  return paths;
}

function collectPaths(value: unknown, paths: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (/^(?:path|targetPath|sourcePath|file|filename)$/i.test(key) && typeof child === "string") {
      paths.push(child);
    } else {
      collectPaths(child, paths);
    }
  }
}

function scopeTokens(scope: SpendRule["scope"], state: SpendState): number {
  if (scope === "turn") return state.turnTokens;
  if (scope === "run") return state.runTokens;
  return state.sessionTokens;
}

function scopeUsd(scope: SpendRule["scope"], state: SpendState): number {
  if (scope === "turn") return state.turnUsd;
  if (scope === "run") return state.runUsd;
  return state.sessionUsd;
}

function globMatches(glob: string, path: string): boolean {
  if (glob === "**" || glob === "**/*") return true;
  const regex = new RegExp(`^${globToRegex(glob)}$`);
  return regex.test(path);
}

function globToRegex(glob: string): string {
  let output = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*") {
      const next = glob[index + 1];
      if (next === "*") {
        output += ".*";
        index += 1;
      } else {
        output += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      output += ".";
      continue;
    }
    output += escapeRegex(char);
  }
  return output;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function withoutParent(ctx: PermissionContext): PermissionContext {
  const { parentContext: _parentContext, ...rest } = ctx;
  return rest;
}
