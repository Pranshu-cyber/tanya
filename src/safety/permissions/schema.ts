export const PERMISSIONS_SCHEMA_VERSION = 1;

export type PermissionMode = "default" | "ask" | "bypass" | "plan";
export type PermissionAction = "allow" | "deny" | "ask";
export type SpendScope = "turn" | "run" | "session";

export interface PathRule {
  glob: string;
  action: PermissionAction;
}

export interface SpendRule {
  type: "spend";
  scope: SpendScope;
  max_usd?: number;
  max_tokens?: number;
  action: Exclude<PermissionAction, "allow">;
}

export interface PermissionRulesConfig {
  version: 1;
  mode: PermissionMode;
  alwaysAllow: string[];
  alwaysDeny: string[];
  alwaysAsk: string[];
  pathRules: PathRule[];
  spendRules: SpendRule[];
  override?: boolean;
}

export type PermissionInheritanceWarning = {
  field: "alwaysAllow" | "pathRules" | "mode" | "override";
  value: string;
  reason: string;
};

export interface SchemaIssue {
  path: string;
  message: string;
}

export type SchemaResult =
  | { ok: true; value: PermissionRulesConfig; issues: [] }
  | { ok: false; issues: SchemaIssue[] };

const MODES = new Set<PermissionMode>(["default", "ask", "bypass", "plan"]);
const ACTIONS = new Set<PermissionAction>(["allow", "deny", "ask"]);
const SPEND_ACTIONS = new Set<SpendRule["action"]>(["deny", "ask"]);
const SPEND_SCOPES = new Set<SpendScope>(["turn", "run", "session"]);

export const DEFAULT_PERMISSION_RULES: PermissionRulesConfig = {
  version: PERMISSIONS_SCHEMA_VERSION,
  mode: "bypass",
  alwaysAllow: [],
  alwaysDeny: [],
  alwaysAsk: [],
  pathRules: [],
  spendRules: [],
};

export function parsePermissionsJson(raw: string): SchemaResult {
  try {
    return validatePermissionsConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: "$", message: `Invalid JSON: ${message}` }] };
  }
}

export function validatePermissionsConfig(input: unknown): SchemaResult {
  const issues: SchemaIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", message: "Expected an object." }] };
  }

  const version = input.version;
  if (version !== PERMISSIONS_SCHEMA_VERSION) {
    issues.push({ path: "$.version", message: `Expected schema version ${PERMISSIONS_SCHEMA_VERSION}.` });
  }

  const mode = input.mode ?? "bypass";
  if (typeof mode !== "string" || !MODES.has(mode as PermissionMode)) {
    issues.push({ path: "$.mode", message: "Expected one of: default, ask, bypass, plan." });
  }

  const alwaysAllow = stringArray(input.alwaysAllow, "$.alwaysAllow", issues);
  const alwaysDeny = stringArray(input.alwaysDeny, "$.alwaysDeny", issues);
  const alwaysAsk = stringArray(input.alwaysAsk, "$.alwaysAsk", issues);
  for (const [field, patterns] of [
    ["alwaysAllow", alwaysAllow],
    ["alwaysDeny", alwaysDeny],
    ["alwaysAsk", alwaysAsk],
  ] as const) {
    for (let index = 0; index < patterns.length; index += 1) {
      validatePattern(patterns[index] ?? "", `$.${field}[${index}]`, issues);
    }
  }

  const pathRules = validatePathRules(input.pathRules, issues);
  const spendRules = validateSpendRules(input.spendRules, issues);
  const override = input.override;
  if (override !== undefined && typeof override !== "boolean") {
    issues.push({ path: "$.override", message: "Expected boolean when present." });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      version: PERMISSIONS_SCHEMA_VERSION,
      mode: mode as PermissionMode,
      alwaysAllow,
      alwaysDeny,
      alwaysAsk,
      pathRules,
      spendRules,
      ...(override !== undefined ? { override: Boolean(override) } : {}),
    },
    issues: [],
  };
}

function validatePathRules(input: unknown, issues: SchemaIssue[]): PathRule[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    issues.push({ path: "$.pathRules", message: "Expected an array." });
    return [];
  }
  return input.flatMap((item, index) => {
    const path = `$.pathRules[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: "Expected an object." });
      return [];
    }
    if (typeof item.glob !== "string" || item.glob.trim() === "") {
      issues.push({ path: `${path}.glob`, message: "Expected a non-empty glob string." });
    }
    if (typeof item.action !== "string" || !ACTIONS.has(item.action as PermissionAction)) {
      issues.push({ path: `${path}.action`, message: "Expected action allow, deny, or ask." });
    }
    if (typeof item.glob === "string" && ACTIONS.has(item.action as PermissionAction)) {
      return [{ glob: item.glob, action: item.action as PermissionAction }];
    }
    return [];
  });
}

function validateSpendRules(input: unknown, issues: SchemaIssue[]): SpendRule[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    issues.push({ path: "$.spendRules", message: "Expected an array." });
    return [];
  }
  return input.flatMap((item, index) => {
    const path = `$.spendRules[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: "Expected an object." });
      return [];
    }
    if (item.type !== "spend") {
      issues.push({ path: `${path}.type`, message: "Expected \"spend\"." });
    }
    if (typeof item.scope !== "string" || !SPEND_SCOPES.has(item.scope as SpendScope)) {
      issues.push({ path: `${path}.scope`, message: "Expected turn, run, or session." });
    }
    if (typeof item.action !== "string" || !SPEND_ACTIONS.has(item.action as SpendRule["action"])) {
      issues.push({ path: `${path}.action`, message: "Expected action deny or ask." });
    }
    const hasUsd = item.max_usd !== undefined;
    const hasTokens = item.max_tokens !== undefined;
    if (!hasUsd && !hasTokens) {
      issues.push({ path, message: "Expected at least one threshold: max_usd or max_tokens." });
    }
    if (hasUsd && !positiveNumber(item.max_usd)) {
      issues.push({ path: `${path}.max_usd`, message: "Expected a positive number." });
    }
    if (hasTokens && !positiveNumber(item.max_tokens)) {
      issues.push({ path: `${path}.max_tokens`, message: "Expected a positive number." });
    }
    if (
      item.type === "spend" &&
      SPEND_SCOPES.has(item.scope as SpendScope) &&
      SPEND_ACTIONS.has(item.action as SpendRule["action"]) &&
      (positiveNumber(item.max_usd) || positiveNumber(item.max_tokens))
    ) {
      return [{
        type: "spend" as const,
        scope: item.scope as SpendScope,
        ...(positiveNumber(item.max_usd) ? { max_usd: item.max_usd as number } : {}),
        ...(positiveNumber(item.max_tokens) ? { max_tokens: item.max_tokens as number } : {}),
        action: item.action as SpendRule["action"],
      }];
    }
    return [];
  });
}

function stringArray(input: unknown, path: string, issues: SchemaIssue[]): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    issues.push({ path, message: "Expected an array of strings." });
    return [];
  }
  return input.flatMap((item, index) => {
    if (typeof item !== "string") {
      issues.push({ path: `${path}[${index}]`, message: "Expected a string." });
      return [];
    }
    return [item];
  });
}

function validatePattern(pattern: string, path: string, issues: SchemaIssue[]): void {
  const separator = pattern.indexOf(":");
  if (separator <= 0) {
    issues.push({ path, message: "Expected pattern format tool:<regex>." });
    return;
  }
  const tool = pattern.slice(0, separator).trim();
  const regex = pattern.slice(separator + 1);
  if (!/^[A-Za-z0-9_.-]+$/.test(tool)) {
    issues.push({ path, message: "Tool name must contain only letters, numbers, '.', '_' or '-'." });
  }
  try {
    new RegExp(regex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ path, message: `Invalid regex: ${message}` });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
