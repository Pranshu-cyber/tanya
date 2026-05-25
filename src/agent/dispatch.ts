import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { EventSink } from "../events/types";

export type DispatchMode = "sequential" | "parallel";

export type DispatchSubtask = {
  id: string;
  title: string;
  files: string[];
  depends_on: string[];
  tdd?: boolean;
  auto_fix?: boolean;
};

export type DispatchPlan = {
  plan: string;
  subtasks: DispatchSubtask[];
  default_test_cmd?: string;
};

export type DispatchSubtaskResult = {
  done: true;
  files_changed: string[];
  summary: string;
  unfixed_failures?: VerifyFailure[];
};

export type DispatchRunTurn = (prompt: string, meta: { phase: "plan" | "subtask" | "complete"; subtask?: DispatchSubtask }) => Promise<string>;

export type DispatchCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DispatchRunCommand = (cmd: string, cwd: string) => Promise<DispatchCommandResult>;

export type RunPlanAndDispatchOptions = {
  cwd: string;
  prompt: string;
  maxSubtasks?: number;
  mode?: DispatchMode;
  resumeRunID?: string;
  tdd?: boolean;
  testCmd?: string;
  sink?: EventSink;
  runTurn: DispatchRunTurn;
  runCommand?: DispatchRunCommand;
  autoFixVerify?: boolean;
  autoFixWarns?: boolean;
  maxFixIterations?: number;
  readVerifyFailures?: () => Promise<VerifyFailure[]>;
};

export type RunPlanAndDispatchResult = {
  runID: string;
  plan: DispatchPlan;
  completed: DispatchSubtaskResult[];
};

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class DispatchCorruptedStateError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`dispatch state file is corrupted (delete it to recover): ${path} (${causeMessage})`);
    this.name = "DispatchCorruptedStateError";
    this.path = path;
  }
}

function readDispatchJSON<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new DispatchCorruptedStateError(path, err);
  }
}

export type VerifyFailure = {
  type?: "verify_failure";
  kind: string;
  severity?: "error" | "warn" | string;
  description?: string;
  path?: string;
  pattern?: string;
  task_id?: string;
  cmd?: string;
  exit_code?: number;
  output_excerpt?: string;
  matched_at?: string;
};

export function generateRunID(now = Date.now()): string {
  let value = now;
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET[value % 32] + time;
    value = Math.floor(value / 32);
  }
  const bytes = randomBytes(10);
  let random = "";
  for (const byte of bytes) random += ULID_ALPHABET[byte % 32];
  return `${time}${random}`;
}

export function buildPlanningPrompt(prompt: string, maxSubtasks: number): string {
  return [
    "Before writing code, output a JSON plan with this exact shape — nothing else in the response, just the fenced JSON block:",
    "```json",
    "{",
    '  "plan": "<one-paragraph summary of what we will build>",',
    '  "default_test_cmd": "<optional fallback test command for subtasks>",',
    '  "subtasks": [',
    '    {"id": "1", "title": "...", "files": ["path/to/a.go"], "depends_on": [], "tdd": true, "auto_fix": true},',
    '    {"id": "2", "title": "...", "files": ["path/to/b.go"], "depends_on": ["1"], "tdd": false, "auto_fix": false}',
    "  ]",
    "}",
    "```",
    `Constraints: each subtask should be 1-8 files. Total subtasks <= ${maxSubtasks}. depends_on is a list of subtask IDs that must complete first. auto_fix defaults to true when --auto-fix-verify is enabled.`,
    "",
    "User prompt:",
    prompt,
  ].join("\n");
}

export function buildSubtaskPrompt(subtask: DispatchSubtask, ordered: DispatchSubtask[], completed: DispatchSubtaskResult[]): string {
  const index = ordered.findIndex((candidate) => candidate.id === subtask.id) + 1;
  const prior = completed.length === 0
    ? "None."
    : completed.map((result, i) => {
      const files = result.files_changed.length > 0 ? ` Files changed: ${result.files_changed.join(", ")}.` : "";
      return `- ${i + 1}. ${result.summary}${files}`;
    }).join("\n");
  return [
    `Subtask ${index}/${ordered.length}: ${subtask.title}`,
    "",
    `Files to touch: ${subtask.files.join(", ")}`,
    "",
    "Subtasks already complete:",
    prior,
    "",
    "Write the code. When done, output ONLY a fenced JSON block:",
    "```json",
    '{"done": true, "files_changed": ["path/to/file"], "summary": "..."}',
    "```",
  ].join("\n");
}

export function buildCompletionPrompt(plan: DispatchPlan, completed: DispatchSubtaskResult[]): string {
  return [
    "All dispatch subtasks are complete. Run the existing verification discipline for this coding step, fix any issues you find, and then report the aggregate result.",
    "",
    `Original plan: ${plan.plan}`,
    "",
    "Completed subtasks:",
    ...completed.map((result, i) => `- ${i + 1}. ${result.summary} (${result.files_changed.join(", ") || "no files reported"})`),
  ].join("\n");
}

export function parseFencedJSON<T>(text: string): T {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fence?.[1] ?? text;
  return JSON.parse(raw.trim()) as T;
}

export function normalizePlan(plan: DispatchPlan, maxSubtasks: number): DispatchPlan {
  if (!plan || typeof plan.plan !== "string" || !Array.isArray(plan.subtasks)) {
    throw new Error("dispatch plan must include plan and subtasks");
  }
  if (plan.subtasks.length === 0) throw new Error("dispatch plan must include at least one subtask");
  if (plan.subtasks.length > maxSubtasks) {
    throw new Error(`dispatch plan has ${plan.subtasks.length} subtasks, exceeding max ${maxSubtasks}`);
  }
  const ids = new Set<string>();
  const subtasks = plan.subtasks.map((task) => {
    if (!task || typeof task.id !== "string" || typeof task.title !== "string") {
      throw new Error("each dispatch subtask must include id and title");
    }
    if (ids.has(task.id)) throw new Error(`duplicate dispatch subtask id: ${task.id}`);
    ids.add(task.id);
    const files = Array.isArray(task.files) ? task.files.map(String) : [];
    const dependsOn = Array.isArray(task.depends_on) ? task.depends_on.map(String) : [];
    // files is advisory: the planning prompt nudges toward small subtasks and runtime
    // outOfScopeFiles() warns on sprawl. No hard cap — a legit CRUD feature spans many
    // files and a pre-flight throw would abort the whole run.
    const tdd = typeof task.tdd === "boolean" ? task.tdd : undefined;
    const autoFix = typeof task.auto_fix === "boolean" ? task.auto_fix : undefined;
    return { id: task.id, title: task.title, files, depends_on: dependsOn, ...(tdd !== undefined ? { tdd } : {}), ...(autoFix !== undefined ? { auto_fix: autoFix } : {}) };
  });
  for (const task of subtasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) throw new Error(`dispatch subtask ${task.id} depends on unknown subtask ${dep}`);
    }
  }
  return { plan: plan.plan, subtasks, ...(typeof plan.default_test_cmd === "string" && plan.default_test_cmd.trim() ? { default_test_cmd: plan.default_test_cmd.trim() } : {}) };
}

export function topologicalSubtasks(plan: DispatchPlan): DispatchSubtask[] {
  const remaining = new Map(plan.subtasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const ordered: DispatchSubtask[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) => task.depends_on.every((dep) => done.has(dep)));
    if (ready.length === 0) throw new Error("dispatch plan contains a dependency cycle");
    ready.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const task of ready) {
      ordered.push(task);
      done.add(task.id);
      remaining.delete(task.id);
    }
  }
  return ordered;
}

function dispatchDir(cwd: string, runID: string): string {
  return resolve(cwd, ".tanya", "dispatch", runID);
}

function subtaskResultPath(dir: string, id: string): string {
  return join(dir, `subtask_${id}.json`);
}

function subtaskPhasePath(dir: string, id: string): string {
  return join(dir, `subtask_${id}_phases.jsonl`);
}

function subtaskFixPath(dir: string, id: string): string {
  return join(dir, `subtask_${id}_fixes.jsonl`);
}

function loadCompleted(dir: string, ordered: DispatchSubtask[]): DispatchSubtaskResult[] {
  const completed: DispatchSubtaskResult[] = [];
  for (const task of ordered) {
    const path = subtaskResultPath(dir, task.id);
    if (!existsSync(path)) break;
    completed.push(readDispatchJSON<DispatchSubtaskResult>(path));
  }
  return completed;
}

// Logging-path appends must never fail the dispatch run they are recording.
// Best-effort: swallow ENOSPC/EBUSY/permission errors on the log files.
function safeAppend(path: string, line: string): void {
  try {
    appendFileSync(path, line);
  } catch {
    // Observability failure; intentionally ignored.
  }
}

function recordFailure(dir: string, subtaskID: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  safeAppend(join(dir, "failures.log"), `${new Date().toISOString()} subtask=${subtaskID} ${message}\n`);
}

function appendPhase(dir: string, subtaskID: string, event: Record<string, unknown>): void {
  safeAppend(subtaskPhasePath(dir, subtaskID), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function appendFix(dir: string, subtaskID: string, event: Record<string, unknown>): void {
  safeAppend(subtaskFixPath(dir, subtaskID), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function parseVerifyFailureJSONL(lines: string[]): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type === "verify_failure_eof") break;
    if (record.type !== "verify_failure") continue;
    const failure: VerifyFailure = { type: "verify_failure", kind: String(record.kind ?? "") };
    if (typeof record.severity === "string") failure.severity = record.severity;
    if (typeof record.description === "string") failure.description = record.description;
    if (typeof record.path === "string") failure.path = record.path;
    if (typeof record.pattern === "string") failure.pattern = record.pattern;
    if (typeof record.task_id === "string") failure.task_id = record.task_id;
    if (typeof record.cmd === "string") failure.cmd = record.cmd;
    if (typeof record.exit_code === "number") failure.exit_code = record.exit_code;
    if (typeof record.output_excerpt === "string") failure.output_excerpt = record.output_excerpt;
    if (typeof record.matched_at === "string") failure.matched_at = record.matched_at;
    failures.push(failure);
  }
  return failures.filter((failure) => failure.kind);
}

export function buildAutoFixPrompt(failures: VerifyFailure[]): string {
  const lines = [
    `The verify suite ran on your sub-task output and ${failures.length} check(s) failed:`,
    "",
  ];
  failures.forEach((failure, index) => {
    lines.push(`Failure ${index + 1}/${failures.length}: ${failure.kind}${failure.path ? ` in ${failure.path}` : ""}`);
    if (failure.description) lines.push(`  Description: ${failure.description}`);
    if (failure.pattern) lines.push(`  Pattern: ${failure.pattern}`);
    if (failure.matched_at) lines.push(`  Matched at: ${failure.matched_at}`);
    if (failure.cmd) lines.push(`  Cmd: ${failure.cmd}`);
    if (typeof failure.exit_code === "number") lines.push(`  Exit code: ${failure.exit_code}`);
    if (failure.output_excerpt) lines.push(`  Cmd output: ${failure.output_excerpt.slice(0, 2048)}`);
    lines.push("");
  });
  lines.push("Fix the implementation. Touch only the files that need to change. Do NOT modify test files unless the failure points at a test file directly.");
  lines.push('When done, output ONLY a fenced JSON block: {"done": true, "files_changed": ["..."], "summary": "fixed: ..."}');
  return lines.join("\n");
}

function failureKey(failure: VerifyFailure): string {
  return [failure.kind, failure.path ?? "", failure.pattern ?? "", failure.cmd ?? "", failure.matched_at ?? ""].join("\x1f");
}

function sameFailureSet(a: VerifyFailure[], b: VerifyFailure[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(failureKey).sort();
  const right = b.map(failureKey).sort();
  return left.every((key, i) => key === right[i]);
}

function outOfScopeFiles(subtask: DispatchSubtask, changed: string[]): string[] {
  const allowed = new Set(subtask.files);
  return changed.filter((file) => !allowed.has(file));
}

async function runAutoFixLoop(
  options: RunPlanAndDispatchOptions,
  subtask: DispatchSubtask,
  result: DispatchSubtaskResult,
  dir: string,
): Promise<DispatchSubtaskResult> {
  if (!options.autoFixVerify || subtask.auto_fix === false || !options.readVerifyFailures) return result;
  const max = options.maxFixIterations ?? 5;
  let previous: VerifyFailure[] | undefined;
  let current = (await options.readVerifyFailures()).filter((failure) => options.autoFixWarns || failure.severity !== "warn");
  if (current.length === 0) return result;
  for (let iteration = 1; iteration <= max; iteration += 1) {
    if (previous && sameFailureSet(previous, current)) {
      const gaveUp = { ...result, summary: `auto-fix entered a loop at iteration ${iteration}`, unfixed_failures: current };
      appendFix(dir, subtask.id, { iteration, failures_in: current, success: false, loop_detected: true });
      return gaveUp;
    }
    const response = await options.runTurn(buildAutoFixPrompt(current), { phase: "subtask", subtask });
    const fixed = parseFencedJSON<DispatchSubtaskResult>(response);
    fixed.files_changed = Array.isArray(fixed.files_changed) ? fixed.files_changed.map(String) : [];
    fixed.summary = typeof fixed.summary === "string" ? fixed.summary : "";
    appendFix(dir, subtask.id, { iteration, failures_in: current, files_changed_out: fixed.files_changed, success: true });
    previous = current;
    result = fixed;
    current = (await options.readVerifyFailures()).filter((failure) => options.autoFixWarns || failure.severity !== "warn");
    if (current.length === 0) {
      writeFileSync(subtaskResultPath(dir, subtask.id), JSON.stringify(result, null, 2));
      return result;
    }
  }
  const gaveUp = { ...result, summary: `auto-fix gave up after ${max} iterations`, unfixed_failures: current };
  appendFix(dir, subtask.id, { iteration: max, failures_in: current, success: false, giveup: true });
  writeFileSync(subtaskResultPath(dir, subtask.id), JSON.stringify(gaveUp, null, 2));
  return gaveUp;
}

type RedWritten = {
  phase: "red_written";
  test_files?: string[];
  test_cmd?: string;
};

type GreenWritten = {
  phase: "green_written";
  impl_files?: string[];
};

export function buildRedPrompt(subtask: DispatchSubtask, plan: DispatchPlan, cwd: string, cliTestCmd?: string): string {
  const testHint = cliTestCmd || plan.default_test_cmd || inferTestCommand(cwd);
  return [
    `TDD phase 1 of 4 for subtask ${subtask.id}: ${subtask.title}`,
    "",
    "Write or extend the test(s) for this subtask. Do NOT touch implementation files yet.",
    "The test must capture the intended behavior precisely.",
    testHint ? `Use this test command unless the new test requires a narrower one: ${testHint}` : "Declare the exact test command to run.",
    "",
    "When done, output ONLY a fenced JSON block:",
    "```json",
    '{"phase": "red_written", "test_files": ["path/to/test"], "test_cmd": "go test ./... -count=1"}',
    "```",
  ].join("\n");
}

function buildRedViolationPrompt(output: DispatchCommandResult, attempt: number): string {
  return [
    "TDD violation: your test passed before the implementation existed. This means the test isn't testing what you think.",
    "Options: (a) tighten the test to actually fail, (b) the implementation already exists and your test is redundant, or (c) the test command isn't running the new test.",
    `RED attempt ${attempt}/3 passed unexpectedly.`,
    "Update and output a new {\"phase\": \"red_written\", \"test_files\": [...], \"test_cmd\": \"...\"} block.",
    "If this is the 3rd failed RED attempt for this subtask, TDD will be abandoned for this subtask and regular dispatch will continue.",
    "",
    trimCommandOutput(output),
  ].join("\n");
}

function buildGreenPrompt(subtask: DispatchSubtask, redOutput: DispatchCommandResult): string {
  return [
    `TDD phase 3 of 4 for subtask ${subtask.id}: ${subtask.title}`,
    "",
    "The test failed correctly (RED). Now write the implementation.",
    "Touch only the files needed to make the test pass. Do NOT modify the test itself.",
    "",
    "RED output:",
    trimCommandOutput(redOutput),
    "",
    "When done, output ONLY a fenced JSON block:",
    "```json",
    '{"phase": "green_written", "impl_files": ["path/to/file"]}',
    "```",
  ].join("\n");
}

function buildGreenRetryPrompt(output: DispatchCommandResult, attempt: number): string {
  return [
    `Test still failing after GREEN attempt ${attempt}/5.`,
    "Output:",
    trimCommandOutput(output),
    "",
    "Diagnose and fix the IMPLEMENTATION (do not weaken the test).",
    "Output a new {\"phase\": \"green_written\", \"impl_files\": [...]} block.",
  ].join("\n");
}

function trimCommandOutput(output: DispatchCommandResult, max = 6000): string {
  const text = [`exit_code=${output.exitCode}`, output.stdout, output.stderr].filter(Boolean).join("\n");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...<trimmed>`;
}

export function inferTestCommand(cwd: string): string | undefined {
  if (existsSync(join(cwd, "go.mod"))) return "go test ./... -count=1";
  if (existsSync(join(cwd, "package.json"))) return "npm test";
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml"))) return "pytest";
  return undefined;
}

async function defaultRunCommand(cmd: string, cwd: string): Promise<DispatchCommandResult> {
  return new Promise((resolveCommand) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const maybeCode = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : 0;
      resolveCommand({ exitCode: error ? maybeCode || 1 : 0, stdout, stderr });
    });
  });
}

function resolveTestCommand(options: RunPlanAndDispatchOptions, plan: DispatchPlan, red?: RedWritten): string {
  const declared = red?.test_cmd?.trim();
  if (options.testCmd?.trim()) return options.testCmd.trim();
  if (declared) return declared;
  if (plan.default_test_cmd?.trim()) return plan.default_test_cmd.trim();
  const inferred = inferTestCommand(options.cwd);
  if (inferred) return inferred;
  throw new Error("cannot infer test_cmd — declare one in the subtask's red_written JSON or the plan's default_test_cmd");
}

async function runRegularSubtask(
  options: RunPlanAndDispatchOptions,
  subtask: DispatchSubtask,
  ordered: DispatchSubtask[],
  completed: DispatchSubtaskResult[],
  dir: string,
): Promise<DispatchSubtaskResult> {
  const response = await options.runTurn(buildSubtaskPrompt(subtask, ordered, completed), { phase: "subtask", subtask });
  const result = parseFencedJSON<DispatchSubtaskResult>(response);
  if (!result.done) throw new Error(`subtask ${subtask.id} did not report done=true`);
  result.files_changed = Array.isArray(result.files_changed) ? result.files_changed.map(String) : [];
  result.summary = typeof result.summary === "string" ? result.summary : "";
  writeFileSync(subtaskResultPath(dir, subtask.id), JSON.stringify(result, null, 2));
  return result;
}

async function runTDDSubtask(
  options: RunPlanAndDispatchOptions,
  plan: DispatchPlan,
  subtask: DispatchSubtask,
  ordered: DispatchSubtask[],
  completed: DispatchSubtaskResult[],
  dir: string,
): Promise<DispatchSubtaskResult> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  let red: RedWritten | undefined;
  let redOutput: DispatchCommandResult | undefined;
  let redPrompt = buildRedPrompt(subtask, plan, options.cwd, options.testCmd);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    appendPhase(dir, subtask.id, { phase: "red_write", attempt });
    red = parseFencedJSON<RedWritten>(await options.runTurn(redPrompt, { phase: "subtask", subtask }));
    if (red.phase !== "red_written") throw new Error(`subtask ${subtask.id} did not report phase=red_written`);
    const testCmd = resolveTestCommand(options, plan, red);
    appendPhase(dir, subtask.id, { phase: "red_verify", attempt, test_cmd: testCmd });
    const output = await runCommand(testCmd, options.cwd);
    appendPhase(dir, subtask.id, { phase: "red_verify_result", attempt, ok: output.exitCode !== 0, exit_code: output.exitCode, stdout: output.stdout, stderr: output.stderr });
    if (output.exitCode !== 0) {
      redOutput = output;
      break;
    }
    redPrompt = buildRedViolationPrompt(output, attempt);
  }
  if (!redOutput || !red) {
    appendPhase(dir, subtask.id, { phase: "red_abandoned", reason: "test passed before implementation after 3 attempts" });
    return runRegularSubtask(options, subtask, ordered, completed, dir);
  }

  const testCmd = resolveTestCommand(options, plan, red);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    appendPhase(dir, subtask.id, { phase: "green_write", attempt });
    const prompt = attempt === 1 ? buildGreenPrompt(subtask, redOutput) : buildGreenRetryPrompt(redOutput, attempt - 1);
    const green = parseFencedJSON<GreenWritten>(await options.runTurn(prompt, { phase: "subtask", subtask }));
    if (green.phase !== "green_written") throw new Error(`subtask ${subtask.id} did not report phase=green_written`);
    appendPhase(dir, subtask.id, { phase: "green_verify", attempt, test_cmd: testCmd });
    const output = await runCommand(testCmd, options.cwd);
    appendPhase(dir, subtask.id, { phase: "green_verify_result", attempt, ok: output.exitCode === 0, exit_code: output.exitCode, stdout: output.stdout, stderr: output.stderr });
    if (output.exitCode === 0) {
      const result: DispatchSubtaskResult = {
        done: true,
        files_changed: Array.isArray(green.impl_files) ? green.impl_files.map(String) : [],
        summary: `TDD subtask ${subtask.id} passed ${testCmd}`,
      };
      writeFileSync(subtaskResultPath(dir, subtask.id), JSON.stringify(result, null, 2));
      return result;
    }
    redOutput = output;
  }
  throw new Error(`subtask ${subtask.id} failed TDD GREEN after 5 attempts`);
}

export async function runPlanAndDispatch(options: RunPlanAndDispatchOptions): Promise<RunPlanAndDispatchResult> {
  const maxSubtasks = options.maxSubtasks ?? 12;
  const mode = options.mode ?? "sequential";
  if (mode === "parallel") throw new Error("--dispatch-mode parallel is not implemented yet; use sequential");

  const runID = options.resumeRunID ?? generateRunID();
  const dir = dispatchDir(options.cwd, runID);
  mkdirSync(dir, { recursive: true });
  await options.sink?.({ type: "status", message: `Dispatch run: ${runID}` });

  let plan: DispatchPlan;
  if (options.resumeRunID) {
    const planPath = join(dir, "plan.json");
    if (!existsSync(planPath)) throw new Error(`dispatch run ${runID} has no plan.json`);
    plan = normalizePlan(readDispatchJSON<DispatchPlan>(planPath), maxSubtasks);
  } else {
    const planningResponse = await options.runTurn(buildPlanningPrompt(options.prompt, maxSubtasks), { phase: "plan" });
    plan = normalizePlan(parseFencedJSON<DispatchPlan>(planningResponse), maxSubtasks);
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  }

  const ordered = topologicalSubtasks(plan);
  const completed = loadCompleted(dir, ordered);

  for (const subtask of ordered.slice(completed.length)) {
    await options.sink?.({ type: "subtask_start", subtask_id: subtask.id, title: subtask.title, files: subtask.files });
    try {
      let result = options.tdd && subtask.tdd !== false
        ? await runTDDSubtask(options, plan, subtask, ordered, completed, dir)
        : await runRegularSubtask(options, subtask, ordered, completed, dir);
      result = await runAutoFixLoop(options, subtask, result, dir);
      const outOfScope = outOfScopeFiles(subtask, result.files_changed);
      if (outOfScope.length > 0) {
        await options.sink?.({
          type: "status",
          message: `Subtask ${subtask.id} changed files outside its declared scope: ${outOfScope.join(", ")}`,
        });
      }
      completed.push(result);
      await options.sink?.({
        type: "subtask_done",
        subtask_id: subtask.id,
        files_changed: result.files_changed,
        summary: result.summary,
        ok: !result.unfixed_failures?.some((failure) => failure.severity !== "warn"),
      });
    } catch (err) {
      recordFailure(dir, subtask.id, err);
      await options.sink?.({ type: "subtask_done", subtask_id: subtask.id, files_changed: [], summary: err instanceof Error ? err.message : String(err), ok: false });
      throw err;
    }
  }

  await options.runTurn(buildCompletionPrompt(plan, completed), { phase: "complete" });
  return { runID, plan, completed };
}
