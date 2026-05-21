import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtInRouteTable, ROUTES_SCHEMA_VERSION } from "./defaults";
import type {
  EffectiveRouteTable,
  ResolvedRoute,
  RouteMatch,
  RouteRule,
  RouteSchemaIssue,
  RouteSchemaResult,
  RouteSource,
  RouteTable,
  RouteTarget,
  StepType,
} from "./types";

const STEP_TYPES = new Set<StepType>(["planning", "tool_call", "synthesis", "verification", "reasoning", "unknown"]);

export interface LoadRouteTableOptions {
  cwd: string;
  home?: string;
  defaults: RouteTarget;
}

export interface LoadedRouteTable {
  table: EffectiveRouteTable;
  issues: Array<RouteSchemaIssue & { file: string }>;
}

export function loadRouteTable(options: LoadRouteTableOptions): LoadedRouteTable {
  const home = options.home ?? homedir();
  const builtIn = builtInRouteTable(options.defaults);
  const userFiles = [
    join(home, ".tanya", "routes.json"),
    join(home, ".tania", "routes.json"),
  ];
  const user = readFirstRouteFile(userFiles, "user");
  const project = readRouteFile(join(options.cwd, ".tania", "routes.json"), "project");
  const sources = [
    ...(project.source ? [project.source] : []),
    ...(user.source ? [user.source] : []),
    "built-in",
  ];
  const issues = [...project.issues, ...user.issues];
  const routes = [
    ...sourceRoutes(project.value?.routes ?? [], "project"),
    ...sourceRoutes(user.value?.routes ?? [], "user"),
    ...sourceRoutes(builtIn.routes, "built-in"),
  ];

  return {
    table: {
      version: ROUTES_SCHEMA_VERSION,
      routes,
      defaults: project.value?.defaults ?? user.value?.defaults ?? builtIn.defaults,
      defaultSource: project.value?.defaults ? "project" : user.value?.defaults ? "user" : "runtime-default",
      sources,
    },
    issues,
  };
}

export function parseRoutesJson(raw: string): RouteSchemaResult {
  try {
    return validateRouteTable(JSON.parse(raw) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: "$", message: `Invalid JSON: ${message}` }] };
  }
}

export function validateRouteTable(input: unknown): RouteSchemaResult {
  const issues: RouteSchemaIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", message: "Expected an object." }] };
  }

  if (input.version !== ROUTES_SCHEMA_VERSION) {
    issues.push({ path: "$.version", message: `Expected schema version ${ROUTES_SCHEMA_VERSION}.` });
  }

  const routes = validateRoutes(input.routes, issues);
  const defaults = validateTarget(input.defaults, "$.defaults", issues);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: ROUTES_SCHEMA_VERSION,
      routes,
      defaults,
    },
    issues: [],
  };
}

export function resolveRoute(stepType: StepType, table: EffectiveRouteTable, text = ""): ResolvedRoute {
  const haystack = text || stepType;
  for (const rule of table.routes) {
    if (!routeMatches(rule.match, stepType, haystack)) continue;
    return {
      provider: rule.provider,
      model: rule.model,
      match: rule.match,
      ...(rule.fallback ? { fallback: rule.fallback } : {}),
      escalate: rule.escalate ?? true,
      ...(rule.reasoningCap ? { reasoningCap: rule.reasoningCap } : {}),
      source: rule.source,
      reason: typeof rule.match === "string" ? `matched step ${rule.match}` : `matched regex ${rule.match.regex}`,
    };
  }

  return {
    provider: table.defaults.provider,
    model: table.defaults.model,
    match: "defaults",
    escalate: true,
    source: table.defaultSource,
    reason: "matched route defaults",
  };
}

function readFirstRouteFile(files: string[], source: RouteSource): { value?: RouteTable; source?: string; issues: Array<RouteSchemaIssue & { file: string }> } {
  const issues: Array<RouteSchemaIssue & { file: string }> = [];
  for (const file of files) {
    const result = readRouteFile(file, source);
    issues.push(...result.issues);
    if (result.value && result.source) return { value: result.value, source: result.source, issues };
  }
  return { issues };
}

function readRouteFile(file: string, _source: RouteSource): { value?: RouteTable; source?: string; issues: Array<RouteSchemaIssue & { file: string }> } {
  if (!existsSync(file)) return { issues: [] };
  const parsed = parseRoutesJson(readFileSync(file, "utf8"));
  if (!parsed.ok) {
    return { issues: parsed.issues.map((issue) => ({ ...issue, file })) };
  }
  return { value: parsed.value, source: file, issues: [] };
}

function sourceRoutes(routes: RouteRule[], source: RouteSource) {
  return routes.map((route) => ({ ...route, source }));
}

function validateRoutes(input: unknown, issues: RouteSchemaIssue[]): RouteRule[] {
  if (!Array.isArray(input)) {
    issues.push({ path: "$.routes", message: "Expected an array." });
    return [];
  }

  return input.flatMap((item, index) => {
    const path = `$.routes[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: "Expected an object." });
      return [];
    }

    const match = validateMatch(item.match, `${path}.match`, issues);
    const target = validateTarget(item, path, issues);
    const fallback = item.fallback === undefined ? undefined : validateTarget(item.fallback, `${path}.fallback`, issues);
    if (item.escalate !== undefined && typeof item.escalate !== "boolean") {
      issues.push({ path: `${path}.escalate`, message: "Expected boolean when present." });
    }
    const reasoningCap = validateReasoningCap(item.reasoningCap, `${path}.reasoningCap`, issues);

    if (!match || !target) return [];
    return [{
      match,
      provider: target.provider,
      model: target.model,
      ...(fallback ? { fallback } : {}),
      ...(item.escalate !== undefined ? { escalate: Boolean(item.escalate) } : {}),
      ...(reasoningCap ? { reasoningCap } : {}),
    }];
  });
}

function validateReasoningCap(input: unknown, path: string, issues: RouteSchemaIssue[]): { maxTokens: number } | null {
  if (input === undefined) return null;
  if (!isRecord(input)) {
    issues.push({ path, message: "Expected an object when present." });
    return null;
  }
  if (typeof input.maxTokens !== "number" || !Number.isFinite(input.maxTokens) || input.maxTokens <= 0) {
    issues.push({ path: `${path}.maxTokens`, message: "Expected a positive number." });
    return null;
  }
  return { maxTokens: Math.floor(input.maxTokens) };
}

function validateMatch(input: unknown, path: string, issues: RouteSchemaIssue[]): RouteMatch | null {
  if (typeof input === "string") {
    if (!STEP_TYPES.has(input as StepType)) {
      issues.push({ path, message: "Expected a known step type." });
      return null;
    }
    return input as StepType;
  }

  if (!isRecord(input)) {
    issues.push({ path, message: "Expected a step type string or { regex }." });
    return null;
  }
  if (typeof input.regex !== "string" || input.regex.trim() === "") {
    issues.push({ path: `${path}.regex`, message: "Expected a non-empty regex string." });
    return null;
  }
  try {
    new RegExp(input.regex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ path: `${path}.regex`, message: `Invalid regex: ${message}` });
    return null;
  }
  return { regex: input.regex };
}

function validateTarget(input: unknown, path: string, issues: RouteSchemaIssue[]): RouteTarget {
  if (!isRecord(input)) {
    issues.push({ path, message: "Expected an object." });
    return { provider: "", model: "" };
  }
  if (typeof input.provider !== "string" || input.provider.trim() === "") {
    issues.push({ path: `${path}.provider`, message: "Expected a non-empty provider string." });
  }
  if (typeof input.model !== "string" || input.model.trim() === "") {
    issues.push({ path: `${path}.model`, message: "Expected a non-empty model string." });
  }
  return {
    provider: typeof input.provider === "string" ? input.provider : "",
    model: typeof input.model === "string" ? input.model : "",
  };
}

function routeMatches(match: RouteMatch, stepType: StepType, text: string): boolean {
  if (typeof match === "string") return match === stepType;
  return new RegExp(match.regex).test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
