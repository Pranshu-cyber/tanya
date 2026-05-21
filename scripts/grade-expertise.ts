import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillPacks } from "../src/skills/load";

type Args = {
  runLive: boolean;
  taskFilter?: string;
};

type TaskCase = {
  id: string;
  dir: string;
  fixtureDir: string;
  taskPath: string;
  expectedPath: string;
};

type Criterion = {
  index: number;
  criterion: string;
  check: string;
};

type LiveCriterionResult = Criterion & {
  status: "PASS" | "FAIL" | "ERROR";
  detail: string;
};

type TaskResult = {
  task: TaskCase;
  valid: boolean;
  errors: string[];
  criteria: Criterion[];
  antiCriteria: string[];
  matchedPacks: string[];
  live?: {
    exitCode: number | null;
    status: "PASS" | "FAIL" | "ERROR";
    results: LiveCriterionResult[];
  };
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const expertiseRoot = join(repoRoot, "test/golden/expertise");
const resultsPath = join(expertiseRoot, "RESULTS.md");
const requiredTaskIds = [
  "failure-modes/analyze-mode",
  "ios/add-feature-screen",
  "ios/implement-paywall",
  "ios/verify-splash",
  "android/add-feature-screen",
  "android/implement-paywall",
  "android/verify-splash",
  "go-backend/add-rest-route-housestyle",
  "go-backend/add-rest-route-huma",
  "go-backend/service-token-auth",
  "landing/add-pricing-section",
];

function parseArgs(argv: string[]): Args {
  const args: Args = { runLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-live") {
      args.runLive = true;
      continue;
    }
    if (arg === "--task") {
      const value = argv[index + 1];
      if (!value) throw new Error("--task requires a task id");
      args.taskFilter = value.replace(/^\/+|\/+$/g, "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function section(text: string, title: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return null;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.startsWith("## ")) break;
    body.push(line ?? "");
  }
  const value = body.join("\n").trim();
  return value ? value : null;
}

function collectTaskDirs(): TaskCase[] {
  const tasks: TaskCase[] = [];

  function walk(current: string): void {
    if (!isDirectory(current)) return;
    const fixtureDir = join(current, "fixture");
    const taskPath = join(current, "task.md");
    const expectedPath = join(current, "expected.md");
    if (isDirectory(fixtureDir) || existsSync(taskPath) || existsSync(expectedPath)) {
      tasks.push({
        id: relative(expertiseRoot, current).replace(/\\/g, "/"),
        dir: current,
        fixtureDir,
        taskPath,
        expectedPath,
      });
      return;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
    }
  }

  walk(expertiseRoot);
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

function splitMarkdownRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseCriteria(expected: string): Criterion[] {
  const rows: Criterion[] = [];
  for (const line of expected.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = splitMarkdownRow(line);
    const index = Number(cells[0]);
    const criterion = cells[1] ?? "";
    const check = cells[2] ?? "";
    if (Number.isFinite(index)) rows.push({ index, criterion, check });
  }
  return rows;
}

function parseAntiCriteria(expected: string): string[] {
  const antiSection = section(expected, "Anti-criteria (must NOT be present)") ?? section(expected, "Anti-criteria");
  if (!antiSection) return [];
  return antiSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function isParseableCheck(check: string): boolean {
  return /^(report|output) contains ".+"$/.test(check) ||
    /^(report|output) not-contains ".+"$/.test(check) ||
    /^report table columns ".+"$/.test(check) ||
    /^commands <= \d+$/.test(check) ||
    /^no modified files$/.test(check) ||
    /^modified contains ".+"$/.test(check) ||
    /^rg ".+" ".+" (matches|no-match)$/.test(check) ||
    /^file exists ".+"$/.test(check) ||
    /^file not exists ".+"$/.test(check);
}

function quotedValue(check: string): string | null {
  const match = /"((?:\\"|[^"])*)"/.exec(check);
  return match?.[1]?.replace(/\\"/g, "\"") ?? null;
}

function countCommandsInReport(output: string): number {
  const lines = output.split(/\r?\n/);
  let commandColumn = -1;
  let count = 0;
  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitMarkdownRow(line).map((cell) => cell.toLowerCase());
    if (cells.includes("command")) {
      commandColumn = cells.indexOf("command");
      continue;
    }
    const commandCell = commandColumn >= 0 ? cells[commandColumn] : undefined;
    if (commandCell && !/^-+$/.test(commandCell)) count += 1;
  }
  return count;
}

function evaluateCheck(check: string, output: string, cwd: string): LiveCriterionResult["status"] | "UNSUPPORTED" {
  const value = quotedValue(check);
  if ((check.startsWith("report contains ") || check.startsWith("output contains ")) && value) {
    return output.includes(value) ? "PASS" : "FAIL";
  }
  if ((check.startsWith("report not-contains ") || check.startsWith("output not-contains ")) && value) {
    return output.includes(value) ? "FAIL" : "PASS";
  }
  if (check.startsWith("report table columns ") && value) {
    const columns = value.split(",").map((column) => column.trim().toLowerCase()).filter(Boolean);
    const lowered = output.toLowerCase();
    return columns.every((column) => lowered.includes(column)) ? "PASS" : "FAIL";
  }
  const commandLimit = /^commands <= (\d+)$/.exec(check);
  if (commandLimit?.[1]) {
    return countCommandsInReport(output) <= Number(commandLimit[1]) ? "PASS" : "FAIL";
  }
  if (check === "no modified files") {
    return /(^|\n)Modified:\s/.test(output) ? "FAIL" : "PASS";
  }
  if (check.startsWith("modified contains ") && value) {
    return new RegExp(`(^|\\n)Modified: .*${escapeRegExp(value)}`).test(output) ? "PASS" : "FAIL";
  }
  const fileExists = /^file (not )?exists "(.+)"$/.exec(check);
  if (fileExists?.[2]) {
    const exists = existsSync(join(cwd, fileExists[2]));
    return fileExists[1] ? (exists ? "FAIL" : "PASS") : (exists ? "PASS" : "FAIL");
  }
  const rg = /^rg "(.+)" "(.+)" (matches|no-match)$/.exec(check);
  if (rg?.[1] && rg[2] && rg[3]) {
    const result = spawnSync("rg", ["-n", rg[1], rg[2]], { cwd, encoding: "utf8" });
    const matched = result.status === 0;
    return rg[3] === "matches" ? (matched ? "PASS" : "FAIL") : (matched ? "FAIL" : "PASS");
  }
  return "UNSUPPORTED";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateTask(task: TaskCase, runLive: boolean): TaskResult {
  const errors: string[] = [];
  if (!isDirectory(task.fixtureDir)) errors.push("fixture/ is missing");
  if (!existsSync(task.taskPath)) errors.push("task.md is missing");
  if (!existsSync(task.expectedPath)) errors.push("expected.md is missing");

  let criteria: Criterion[] = [];
  let antiCriteria: string[] = [];
  let matchedPacks: string[] = [];

  if (existsSync(task.taskPath)) {
    const taskText = readText(task.taskPath);
    for (const required of ["Workspace", "Intent", "Goal", "Constraints"]) {
      if (!section(taskText, required)) errors.push(`task.md missing ## ${required}`);
    }
  }

  if (existsSync(task.expectedPath)) {
    const expectedText = readText(task.expectedPath);
    criteria = parseCriteria(expectedText);
    antiCriteria = parseAntiCriteria(expectedText);
    if (criteria.length === 0) errors.push("expected.md has no criterion table rows");
    for (const criterion of criteria) {
      if (!criterion.criterion) errors.push(`expected.md criterion ${criterion.index} has empty criterion`);
      if (!criterion.check) errors.push(`expected.md criterion ${criterion.index} has empty check`);
      if (criterion.check && !isParseableCheck(criterion.check)) {
        errors.push(`expected.md criterion ${criterion.index} has unsupported check: ${criterion.check}`);
      }
    }
  }

  if (isDirectory(task.fixtureDir)) {
    const taskText = existsSync(task.taskPath) ? readText(task.taskPath) : "";
    matchedPacks = loadSkillPacks({
      workspace: task.fixtureDir,
      hints: {},
      taskHint: taskText,
    }).map((pack) => `${pack.slug}(${pack.reason}, ${pack.tokens})`);
    if (matchedPacks.length === 0) errors.push("fixture matched zero skill packs");
  }

  const result: TaskResult = {
    task,
    valid: errors.length === 0,
    errors,
    criteria,
    antiCriteria,
    matchedPacks,
  };

  if (runLive && result.valid) result.live = runLiveTask(task, criteria);
  return result;
}

function runLiveTask(task: TaskCase, criteria: Criterion[]): NonNullable<TaskResult["live"]> {
  const cliPath = join(repoRoot, "dist/cli.js");
  if (!existsSync(cliPath)) {
    return {
      exitCode: null,
      status: "ERROR",
      results: criteria.map((criterion) => ({
        ...criterion,
        status: "ERROR",
        detail: "dist/cli.js missing; run npm run build first",
      })),
    };
  }

  const run = spawnSync(process.execPath, [
    cliPath,
    "run",
    "--json",
    "--cwd",
    task.fixtureDir,
    "--prompt-file",
    task.taskPath,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const results = criteria.map((criterion): LiveCriterionResult => {
    const status = evaluateCheck(criterion.check, output, task.fixtureDir);
    if (status === "UNSUPPORTED") {
      return { ...criterion, status: "ERROR", detail: "unsupported check" };
    }
    return { ...criterion, status, detail: criterion.check };
  });
  const hasError = results.some((item) => item.status === "ERROR");
  const hasFail = results.some((item) => item.status === "FAIL") || run.status !== 0;
  return {
    exitCode: run.status,
    status: hasError ? "ERROR" : hasFail ? "FAIL" : "PASS",
    results,
  };
}

function renderResults(results: TaskResult[], runLive: boolean): string {
  const validCount = results.filter((result) => result.valid).length;
  const lines = [
    "# Expertise Eval Results",
    "",
    `Mode: ${runLive ? "live" : "validate-only"}`,
    `Generated: ${new Date().toISOString()}`,
    `Tasks: ${validCount}/${results.length} valid`,
    "",
    "| Task | Status | Criteria | Anti-criteria | Matched packs |",
    "|------|--------|----------|---------------|---------------|",
  ];

  for (const result of results) {
    const status = result.valid ? (result.live?.status ?? "VALID") : "INVALID";
    lines.push(`| ${result.task.id} | ${status} | ${result.criteria.length} | ${result.antiCriteria.length} | ${result.matchedPacks.map((pack) => `\`${pack}\``).join("<br>")} |`);
  }

  for (const result of results) {
    lines.push("", `## ${result.task.id}`, "");
    lines.push(`Fixture: \`${relative(repoRoot, result.task.fixtureDir)}\``);
    lines.push(`Criteria: ${result.criteria.length}`);
    lines.push(`Anti-criteria: ${result.antiCriteria.length}`);
    lines.push("");
    lines.push("Matched packs:");
    for (const pack of result.matchedPacks) lines.push(`- ${pack}`);
    if (result.errors.length > 0) {
      lines.push("", "Errors:");
      for (const error of result.errors) lines.push(`- ${error}`);
    }
    if (result.live) {
      lines.push("", `Live exit code: ${result.live.exitCode ?? "n/a"}`);
      lines.push("", "| # | Status | Criterion | Check |");
      lines.push("|---|--------|-----------|-------|");
      for (const criterion of result.live.results) {
        lines.push(`| ${criterion.index} | ${criterion.status} | ${criterion.criterion} | \`${criterion.check.replace(/`/g, "\\`")}\` |`);
      }
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const collected = collectTaskDirs();
  const byId = new Map(collected.map((task) => [task.id, task]));
  const selectedIds = args.taskFilter ? [args.taskFilter] : requiredTaskIds;
  const tasks = selectedIds.map((id) => byId.get(id) ?? {
    id,
    dir: join(expertiseRoot, id),
    fixtureDir: join(expertiseRoot, id, "fixture"),
    taskPath: join(expertiseRoot, id, "task.md"),
    expectedPath: join(expertiseRoot, id, "expected.md"),
  });

  mkdirSync(expertiseRoot, { recursive: true });
  const results = tasks.map((task) => validateTask(task, args.runLive));
  writeFileSync(resultsPath, renderResults(results, args.runLive), "utf8");

  const invalid = results.filter((result) => !result.valid || result.live?.status === "FAIL" || result.live?.status === "ERROR");
  if (invalid.length > 0) {
    console.error(`Expertise grading failed for ${invalid.length} task(s). See ${resultsPath}`);
    process.exit(1);
  }
  console.log(`Expertise grading passed for ${results.length} task(s). Results: ${resultsPath}`);
}

main();
