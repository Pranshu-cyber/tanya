import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtInRouteTable, ROUTES_SCHEMA_VERSION } from "./defaults";
import type {
  EffectiveRouteTable,
  ResolvedRoute,
  RouteCascadeEntry,
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
    join(home, ".tanya", "routes.json"),
  ];
  const user = readFirstRouteFile(userFiles, "user");
  const project = readRouteFile(join(options.cwd, ".tanya", "routes.json"), "project");
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
  const defaultSource: RouteSource = project.value?.defaults ? "project" : user.value?.defaults ? "user" : "runtime-default";
  const defaults = project.value?.defaults ?? user.value?.defaults ?? builtIn.defaults;
  const cascadeSource: RouteSource = project.value
    ? "project"
    : user.value
      ? "user"
      : "built-in";
  const cascade = sourceCascade(
    project.value ? cascadeOrLegacyDefault(project.value) :
      user.value ? cascadeOrLegacyDefault(user.value) :
        builtIn.cascade ?? cascadeOrLegacyDefault(builtIn),
    cascadeSource,
  );

  return {
    table: {
      version: ROUTES_SCHEMA_VERSION,
      routes,
      defaults,
      defaultSource,
      cascade,
      cascadeSource,
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
  const defaults = input.defaults === undefined
    ? validateLegacyDefaultTarget(input, issues)
    : validateTarget(input.defaults, "$.defaults", issues);
  const cascade = input.cascade === undefined ? undefined : validateCascade(input.cascade, issues);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: ROUTES_SCHEMA_VERSION,
      routes,
      defaults,
      ...(cascade ? { cascade } : {}),
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

function sourceCascade(cascade: RouteCascadeEntry[], source: RouteSource) {
  return cascade.map((route) => ({ ...route, source }));
}

function cascadeOrLegacyDefault(table: RouteTable): RouteCascadeEntry[] {
  return table.cascade?.length ? table.cascade : [targetToCascade(table.defaults)];
}

function targetToCascade(target: RouteTarget): RouteCascadeEntry {
  return {
    provider: target.provider,
    model: target.model,
    maxInputTokens: target.maxInputTokens ?? contextWindowForProvider(target.provider),
  };
}

function validateRoutes(input: unknown, issues: RouteSchemaIssue[]): RouteRule[] {
  if (input === undefined) return [];
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
      ...(target.maxInputTokens ? { maxInputTokens: target.maxInputTokens } : {}),
      ...(fallback ? { fallback } : {}),
      ...(item.escalate !== undefined ? { escalate: Boolean(item.escalate) } : {}),
      ...(reasoningCap ? { reasoningCap } : {}),
    }];
  });
}

function validateCascade(input: unknown, issues: RouteSchemaIssue[]): RouteCascadeEntry[] {
  if (!Array.isArray(input)) {
    issues.push({ path: "$.cascade", message: "Expected an array when present." });
    return [];
  }
  return input.flatMap((item, index) => {
    const path = `$.cascade[${index}]`;
    const target = validateTarget(item, path, issues);
    const stepTypes = validateStepTypes(isRecord(item) ? item.stepTypes ?? item.step_types : undefined, `${path}.stepTypes`, issues);
    if (!target || !target.maxInputTokens) return [];
    return [{
      provider: target.provider,
      model: target.model,
      maxInputTokens: target.maxInputTokens,
      ...(stepTypes ? { stepTypes } : {}),
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

function validateStepTypes(input: unknown, path: string, issues: RouteSchemaIssue[]): StepType[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) {
    issues.push({ path, message: "Expected an array of step types when present." });
    return null;
  }
  const out: StepType[] = [];
  input.forEach((item, index) => {
    if (typeof item !== "string" || !STEP_TYPES.has(item as StepType)) {
      issues.push({ path: `${path}[${index}]`, message: "Expected a known step type." });
      return;
    }
    out.push(item as StepType);
  });
  return out.length ? out : null;
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
  const provider = typeof input.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : typeof input.cli === "string" && input.cli.trim()
      ? input.cli.trim()
      : "";
  const model = typeof input.model === "string" && input.model.trim()
    ? input.model.trim()
    : "";
  const maxInputTokens = numericField(input.maxInputTokens ?? input.max_input_tokens);
  if (!provider) {
    issues.push({ path: `${path}.provider`, message: "Expected a non-empty provider string." });
  }
  if (!model) {
    issues.push({ path: `${path}.model`, message: "Expected a non-empty model string." });
  }
  if ((input.maxInputTokens !== undefined || input.max_input_tokens !== undefined) && !maxInputTokens) {
    issues.push({ path: `${path}.maxInputTokens`, message: "Expected a positive number." });
  }
  return {
    provider,
    model,
    ...(maxInputTokens ? { maxInputTokens } : {}),
  };
}

function validateLegacyDefaultTarget(input: Record<string, unknown>, issues: RouteSchemaIssue[]): RouteTarget {
  const defaultModel = typeof input.default_model === "string" && input.default_model.trim()
    ? input.default_model.trim()
    : typeof input.defaultModel === "string" && input.defaultModel.trim()
      ? input.defaultModel.trim()
      : "";
  const defaultProvider = typeof input.default_cli === "string" && input.default_cli.trim()
    ? input.default_cli.trim()
    : typeof input.default_provider === "string" && input.default_provider.trim()
      ? input.default_provider.trim()
      : typeof input.defaultProvider === "string" && input.defaultProvider.trim()
        ? input.defaultProvider.trim()
        : "";
  if (!defaultModel) {
    issues.push({ path: "$.defaults", message: "Expected defaults or legacy default_model." });
  }
  const provider = defaultProvider || inferProviderForModel(defaultModel);
  if (!provider) {
    issues.push({ path: "$.default_cli", message: "Expected default_cli/default_provider for this default_model." });
  }
  const maxInputTokens = numericField(input.maxInputTokens ?? input.max_input_tokens);
  return {
    provider,
    model: defaultModel,
    ...(maxInputTokens ? { maxInputTokens } : {}),
  };
}

function routeMatches(match: RouteMatch, stepType: StepType, text: string): boolean {
  if (typeof match === "string") return match === stepType;
  return new RegExp(match.regex).test(text);
}

function numericField(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function inferProviderForModel(model: string): string {
  if (/^deepseek-/i.test(model)) return "deepseek";
  if (/^(?:gpt-|o\d|o\d-|chatgpt)/i.test(model)) return "openai";
  if (/^claude-/i.test(model)) return "claude";
  if (/^gemini-/i.test(model)) return "gemini";
  if (/^qwen/i.test(model)) return "qwen";
  return "";
}

function contextWindowForProvider(provider: string): number {
  switch (provider) {
    case "claude":
      return 1_000_000;
    case "gemini":
      return 2_000_000;
    case "openai":
      return 200_000;
    default:
      return 128_000;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
