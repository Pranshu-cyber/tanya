import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PERMISSION_RULES,
  parsePermissionsJson,
  type PermissionRulesConfig,
  type PermissionMode,
  type PermissionInheritanceWarning,
  type SchemaIssue,
} from "./schema";

export interface LoadPermissionRulesOptions {
  cwd: string;
  home?: string;
}

export interface LoadedPermissionRules {
  rules: PermissionRulesConfig;
  sources: string[];
  issues: Array<SchemaIssue & { file: string }>;
}

export interface InheritedPermissionRules {
  rules: PermissionRulesConfig;
  warnings: PermissionInheritanceWarning[];
}

export function loadPermissionRules(options: LoadPermissionRulesOptions): LoadedPermissionRules {
  const home = options.home ?? homedir();
  const candidates = [
    join(home, ".tanya", "permissions.json"),
    join(options.cwd, ".tanya", "permissions.json"),
  ];

  let rules = cloneRules(DEFAULT_PERMISSION_RULES);
  const sources: string[] = [];
  const issues: Array<SchemaIssue & { file: string }> = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parsePermissionsJson(readFileSync(file, "utf8"));
    if (!parsed.ok) {
      issues.push(...parsed.issues.map((issue) => ({ ...issue, file })));
      continue;
    }
    rules = mergePermissionRules(rules, parsed.value);
    sources.push(file);
  }

  return { rules, sources, issues };
}

export function mergePermissionRules(base: PermissionRulesConfig, next: PermissionRulesConfig): PermissionRulesConfig {
  if (next.override) return cloneRules(next);
  return {
    version: 1,
    mode: next.mode,
    alwaysAllow: unique([...base.alwaysAllow, ...next.alwaysAllow]),
    alwaysDeny: unique([...base.alwaysDeny, ...next.alwaysDeny]),
    alwaysAsk: unique([...base.alwaysAsk, ...next.alwaysAsk]),
    pathRules: [...base.pathRules, ...next.pathRules],
    spendRules: [...base.spendRules, ...next.spendRules],
  };
}

export function mergeInheritedPermissionRules(parent: PermissionRulesConfig, child: PermissionRulesConfig): InheritedPermissionRules {
  const warnings: PermissionInheritanceWarning[] = [];
  if (child.override) {
    warnings.push({
      field: "override",
      value: "true",
      reason: "child override ignored; sub-agent permissions can only tighten parent rules",
    });
  }

  const parentGuardPatterns = [...parent.alwaysDeny, ...parent.alwaysAsk];
  const childAlwaysAllow = child.alwaysAllow.filter((pattern) => {
    const blockedBy = parentGuardPatterns.find((parentPattern) => patternsMayOverlap(pattern, parentPattern));
    if (!blockedBy) return true;
    warnings.push({
      field: "alwaysAllow",
      value: pattern,
      reason: `child allow overlaps inherited ${blockedBy}`,
    });
    return false;
  });

  const childPathRules = child.pathRules.filter((rule) => {
    if (rule.action !== "allow") return true;
    const blockedBy = parent.pathRules.find((parentRule) => parentRule.action !== "allow" && pathGlobsMayOverlap(rule.glob, parentRule.glob));
    if (!blockedBy) return true;
    warnings.push({
      field: "pathRules",
      value: `${rule.glob}:${rule.action}`,
      reason: `child path allow overlaps inherited ${blockedBy.action} for ${blockedBy.glob}`,
    });
    return false;
  });

  const mode = stricterPermissionMode(parent.mode, child.mode);
  if (mode !== child.mode) {
    warnings.push({
      field: "mode",
      value: child.mode,
      reason: `child mode demoted to inherited ${mode}`,
    });
  }

  return {
    rules: {
      version: 1,
      mode,
      alwaysAllow: unique([...parent.alwaysAllow, ...childAlwaysAllow]),
      alwaysDeny: unique([...parent.alwaysDeny, ...child.alwaysDeny]),
      alwaysAsk: unique([...parent.alwaysAsk, ...child.alwaysAsk]),
      pathRules: [...parent.pathRules, ...childPathRules],
      spendRules: [...parent.spendRules, ...child.spendRules],
    },
    warnings,
  };
}

export function stricterPermissionMode(parent: PermissionMode, child: PermissionMode): PermissionMode {
  return modeRank(parent) >= modeRank(child) ? parent : child;
}

function cloneRules(rules: PermissionRulesConfig): PermissionRulesConfig {
  return {
    version: 1,
    mode: rules.mode,
    alwaysAllow: [...rules.alwaysAllow],
    alwaysDeny: [...rules.alwaysDeny],
    alwaysAsk: [...rules.alwaysAsk],
    pathRules: rules.pathRules.map((rule) => ({ ...rule })),
    spendRules: rules.spendRules.map((rule) => ({ ...rule })),
    ...(rules.override !== undefined ? { override: rules.override } : {}),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function modeRank(mode: PermissionMode): number {
  switch (mode) {
    case "plan": return 3;
    case "ask": return 2;
    case "default": return 1;
    case "bypass": return 0;
  }
}

function patternsMayOverlap(child: string, parent: string): boolean {
  if (child === parent) return true;
  const childTool = child.slice(0, child.indexOf(":"));
  const parentTool = parent.slice(0, parent.indexOf(":"));
  if (!childTool || !parentTool || childTool !== parentTool) return false;
  const childRegex = child.slice(child.indexOf(":") + 1);
  const parentRegex = parent.slice(parent.indexOf(":") + 1);
  if (parentRegex === ".*") return true;
  if (childRegex === ".*" && parentRegex.length > 0) return true;
  const childLiteral = regexLiteralPrefix(childRegex);
  const parentLiteral = regexLiteralPrefix(parentRegex);
  return Boolean(childLiteral && parentLiteral && (childLiteral.startsWith(parentLiteral) || parentLiteral.startsWith(childLiteral)));
}

function regexLiteralPrefix(pattern: string): string {
  return pattern
    .replace(/^\.*/, "")
    .replace(/\\\./g, ".")
    .replace(/\\\//g, "/")
    .split(/[()[\]{}?+*|^$]/, 1)[0] ?? "";
}

function pathGlobsMayOverlap(childGlob: string, parentGlob: string): boolean {
  if (childGlob === parentGlob) return true;
  if (parentGlob === "**" || parentGlob === "**/*") return true;
  const parentPrefix = globPrefix(parentGlob);
  const childPrefix = globPrefix(childGlob);
  return Boolean(parentPrefix && childPrefix && (childPrefix.startsWith(parentPrefix) || parentPrefix.startsWith(childPrefix)));
}

function globPrefix(glob: string): string {
  const wildcard = glob.search(/[*?[\]{}]/);
  return (wildcard === -1 ? glob : glob.slice(0, wildcard)).replace(/\/+$/, "");
}
