import type { EvalSchemaIssue, EvalValidationResult } from "./EvalSuite";
import { formatEvalSchemaIssues } from "./EvalSuite";

export type EvalRunStatus = "passed" | "failed" | "errored" | "timeout";
export type EvalVerifierVerdict = "passed" | "failed";

export type EvalTokensUsed = {
  input: number;
  output: number;
  reasoning?: number;
  system_prompt?: number;
  repo_map?: number;
};

export type EvalRunResult = {
  taskId: string;
  status: EvalRunStatus;
  durationMs: number;
  tokensUsed: EvalTokensUsed;
  costUsd: number;
  verifierVerdict: EvalVerifierVerdict;
  diff?: string;
  error?: string;
};

export type EvalResult = {
  suite: string;
  suiteVersion: string;
  tanyaVersion: string;
  model: string;
  provider?: string;
  generatedAt?: string;
  totalCostUsd: number;
  costPerPass: number | null;
  tokensPerPass: number | null;
  reasoningShare: number;
  runs: EvalRunResult[];
};

const statuses = new Set<EvalRunStatus>(["passed", "failed", "errored", "timeout"]);
const verdicts = new Set<EvalVerifierVerdict>(["passed", "failed"]);

export function validateEvalResult(input: unknown): EvalValidationResult<EvalResult> {
  const issues: EvalSchemaIssue[] = [];
  const root = asRecord(input);
  requireString(root, "suite", "/suite", issues);
  requireString(root, "suiteVersion", "/suiteVersion", issues);
  requireString(root, "tanyaVersion", "/tanyaVersion", issues);
  requireString(root, "model", "/model", issues);
  if (root?.provider !== undefined && typeof root.provider !== "string") {
    issues.push({ path: "/provider", message: "provider must be a string" });
  }
  requireNumber(root, "totalCostUsd", "/totalCostUsd", issues);
  requireNullableNumber(root, "costPerPass", "/costPerPass", issues);
  requireNullableNumber(root, "tokensPerPass", "/tokensPerPass", issues);
  requireNumber(root, "reasoningShare", "/reasoningShare", issues);
  if (!Array.isArray(root?.runs)) {
    issues.push({ path: "/runs", message: "runs must be an array" });
  } else {
    root.runs.forEach((run, index) => validateRunResult(run, `/runs/${index}`, issues));
  }
  return issues.length === 0 ? { ok: true, data: input as EvalResult } : { ok: false, issues };
}

export function assertEvalResult(input: unknown): EvalResult {
  const result = validateEvalResult(input);
  if (result.ok) return result.data;
  throw new Error(formatEvalSchemaIssues(result.issues));
}

function validateRunResult(input: unknown, path: string, issues: EvalSchemaIssue[]): void {
  const run = asRecord(input);
  requireString(run, "taskId", `${path}/taskId`, issues);
  requireEnum(run?.status, statuses, `${path}/status`, "status", issues);
  requireNumber(run, "durationMs", `${path}/durationMs`, issues);
  requireNumber(run, "costUsd", `${path}/costUsd`, issues);
  requireEnum(run?.verifierVerdict, verdicts, `${path}/verifierVerdict`, "verifierVerdict", issues);
  validateTokens(run?.tokensUsed, `${path}/tokensUsed`, issues);
  if (run?.diff !== undefined && typeof run.diff !== "string") {
    issues.push({ path: `${path}/diff`, message: "diff must be a string" });
  }
  if (run?.error !== undefined && typeof run.error !== "string") {
    issues.push({ path: `${path}/error`, message: "error must be a string" });
  }
}

function validateTokens(input: unknown, path: string, issues: EvalSchemaIssue[]): void {
  const tokens = asRecord(input);
  requireNumber(tokens, "input", `${path}/input`, issues);
  requireNumber(tokens, "output", `${path}/output`, issues);
  for (const key of ["reasoning", "system_prompt", "repo_map"]) {
    if (tokens?.[key] !== undefined && !isNonNegativeNumber(tokens[key])) {
      issues.push({ path: `${path}/${key}`, message: `${key} must be a non-negative number` });
    }
  }
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

function requireString(record: Record<string, unknown> | null, key: string, path: string, issues: EvalSchemaIssue[]): void {
  if (typeof record?.[key] !== "string" || !record[key]) {
    issues.push({ path, message: `${key} must be a non-empty string` });
  }
}

function requireNumber(record: Record<string, unknown> | null, key: string, path: string, issues: EvalSchemaIssue[]): void {
  if (!isNonNegativeNumber(record?.[key])) {
    issues.push({ path, message: `${key} must be a non-negative number` });
  }
}

function requireNullableNumber(record: Record<string, unknown> | null, key: string, path: string, issues: EvalSchemaIssue[]): void {
  if (record?.[key] !== null && !isNonNegativeNumber(record?.[key])) {
    issues.push({ path, message: `${key} must be null or a non-negative number` });
  }
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  path: string,
  key: string,
  issues: EvalSchemaIssue[],
): void {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    issues.push({ path, message: `${key} has an invalid value` });
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
