export type EvalRepoSetup =
  | { type: "git_clone"; url: string; commit: string; path?: string }
  | { type: "local_fixture"; path: string };

export type EvalTask = {
  id: string;
  repo_setup: EvalRepoSetup;
  prompt: string;
  expected_files?: string[];
  verifier_extension?: string;
  metadata?: Record<string, unknown>;
};

export type EvalSuite = {
  name: string;
  version: string;
  tasks: EvalTask[];
};

export type EvalSchemaIssue = {
  path: string;
  message: string;
};

export type EvalValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: EvalSchemaIssue[] };

const repoSetupTypes = new Set(["git_clone", "local_fixture"]);

export function validateEvalSuite(input: unknown): EvalValidationResult<EvalSuite> {
  const issues: EvalSchemaIssue[] = [];
  const root = asRecord(input);
  requireString(root, "name", "/name", issues);
  requireString(root, "version", "/version", issues);
  if (!Array.isArray(root?.tasks)) {
    issues.push({ path: "/tasks", message: "tasks must be an array" });
  } else {
    root.tasks.forEach((task, index) => validateTask(task, `/tasks/${index}`, issues));
  }
  return issues.length === 0 ? { ok: true, data: input as EvalSuite } : { ok: false, issues };
}

export function assertEvalSuite(input: unknown): EvalSuite {
  const result = validateEvalSuite(input);
  if (result.ok) return result.data;
  throw new Error(formatEvalSchemaIssues(result.issues));
}

export function formatEvalSchemaIssues(issues: EvalSchemaIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

function validateTask(input: unknown, path: string, issues: EvalSchemaIssue[]): void {
  const task = asRecord(input);
  requireString(task, "id", `${path}/id`, issues);
  requireString(task, "prompt", `${path}/prompt`, issues);
  validateRepoSetup(task?.repo_setup, `${path}/repo_setup`, issues);
  if (task?.expected_files !== undefined && !isStringArray(task.expected_files)) {
    issues.push({ path: `${path}/expected_files`, message: "expected_files must be an array of strings" });
  }
  if (task?.verifier_extension !== undefined && typeof task.verifier_extension !== "string") {
    issues.push({ path: `${path}/verifier_extension`, message: "verifier_extension must be a string" });
  }
}

function validateRepoSetup(input: unknown, path: string, issues: EvalSchemaIssue[]): void {
  const setup = asRecord(input);
  const type = typeof setup?.type === "string" ? setup.type : "";
  if (!repoSetupTypes.has(type)) {
    issues.push({ path: `${path}/type`, message: "type must be git_clone or local_fixture" });
    return;
  }
  if (type === "git_clone") {
    requireString(setup, "url", `${path}/url`, issues);
    requireString(setup, "commit", `${path}/commit`, issues);
  }
  if (type === "local_fixture") {
    requireString(setup, "path", `${path}/path`, issues);
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
