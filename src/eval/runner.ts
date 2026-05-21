import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { envValue, numberEnvValue } from "../config/envCompat";
import type { ChatProvider } from "../providers/types";
import { createJsonlSink } from "../events/jsonl";
import { runAgent } from "../agent/runner";
import { estimateRunCost } from "../memory/runLogs";
import type { EvalResult, EvalRunResult, EvalSuite, EvalTask, EvalTokensUsed } from "./schemas";
import { runVerifierExtension } from "./verifierExtensions";

export type EvalExecutionContext = {
  workspace: string;
  provider: string;
  model: string;
  timeoutMs: number;
  tokenCap: number;
};

export type EvalExecutionOutcome = {
  verifierVerdict: "passed" | "failed";
  tokensUsed: EvalTokensUsed;
  costUsd: number;
  diff?: string;
  error?: string;
};

export type EvalExecutor = (task: EvalTask, ctx: EvalExecutionContext) => Promise<EvalExecutionOutcome>;

export type RunEvalOptions = {
  cwd: string;
  provider: string;
  model: string;
  tanyaVersion: string;
  taskIds?: string[];
  parallel?: number;
  timeoutMs?: number;
  tokenCap?: number;
  executor?: EvalExecutor;
  providerFactory?: () => ChatProvider;
  keepWorkspaces?: boolean;
};

export async function runEvalSuite(suite: EvalSuite, options: RunEvalOptions): Promise<EvalResult> {
  const timeoutMs = options.timeoutMs ?? numberEnvValue(process.env, "TANYA_EVAL_TASK_TIMEOUT_MS", 600_000);
  const tokenCap = options.tokenCap ?? numberEnvValue(process.env, "TANYA_EVAL_TASK_TOKEN_CAP", 500_000);
  const selected = options.taskIds?.length
    ? suite.tasks.filter((task) => options.taskIds?.includes(task.id))
    : suite.tasks;
  const missing = (options.taskIds ?? []).filter((id) => !suite.tasks.some((task) => task.id === id));
  if (missing.length > 0) throw new Error(`Unknown eval task id(s): ${missing.join(", ")}`);

  const executor = options.executor ?? defaultExecutor(options);
  const runs: EvalRunResult[] = [];
  // Keep execution sequential for deterministic local logs. The CLI accepts
  // --parallel for forward compatibility; CI can raise it once provider and
  // fixture isolation have enough soak time.
  void (options.parallel ?? numberEnvValue(process.env, "TANYA_EVAL_PARALLEL", 4));
  for (const task of selected) {
    runs.push(await runOneTask(suite, task, options, executor, timeoutMs, tokenCap));
  }

  return {
    suite: suite.name,
    suiteVersion: suite.version,
    tanyaVersion: options.tanyaVersion,
    provider: options.provider,
    model: options.model,
    generatedAt: new Date().toISOString(),
    ...aggregateRuns(runs),
    runs,
  };
}

export async function writeEvalResult(path: string, result: EvalResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}

export async function readEvalResult(path: string): Promise<EvalResult> {
  return JSON.parse(await readFile(path, "utf8")) as EvalResult;
}

async function runOneTask(
  suite: EvalSuite,
  task: EvalTask,
  options: RunEvalOptions,
  executor: EvalExecutor,
  timeoutMs: number,
  tokenCap: number,
): Promise<EvalRunResult> {
  const started = Date.now();
  let workspace = "";
  try {
    workspace = await setupEvalWorkspace(suite, task, options.cwd);
    const outcome = await withTimeout(
      executor(task, {
        workspace,
        provider: options.provider,
        model: options.model,
        timeoutMs,
        tokenCap,
      }),
      timeoutMs,
    );
    const status = outcome.verifierVerdict === "passed" ? "passed" : "failed";
    return {
      taskId: task.id,
      status,
      durationMs: Date.now() - started,
      tokensUsed: outcome.tokensUsed,
      costUsd: outcome.costUsd,
      verifierVerdict: outcome.verifierVerdict,
      ...(outcome.diff ? { diff: outcome.diff } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  } catch (err) {
    const timeout = err instanceof Error && err.message === "eval task timeout";
    return {
      taskId: task.id,
      status: timeout ? "timeout" : "errored",
      durationMs: Date.now() - started,
      tokensUsed: { input: 0, output: 0 },
      costUsd: 0,
      verifierVerdict: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (workspace && !options.keepWorkspaces) await rm(workspace, { recursive: true, force: true });
  }
}

async function setupEvalWorkspace(suite: EvalSuite, task: EvalTask, cwd: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `tanya-eval-${suite.name}-${task.id}-`));
  if (task.repo_setup.type === "local_fixture" && !task.repo_setup.path.startsWith("builtin:")) {
    const source = resolve(cwd, task.repo_setup.path);
    if (!existsSync(source)) throw new Error(`local fixture does not exist: ${source}`);
    await cp(source, workspace, { recursive: true });
  } else if (task.repo_setup.type === "git_clone") {
    execFileSync("git", ["clone", "--quiet", task.repo_setup.url, workspace], { stdio: "ignore" });
    execFileSync("git", ["checkout", "--quiet", task.repo_setup.commit], { cwd: workspace, stdio: "ignore" });
  } else {
    await writeFile(join(workspace, "README.md"), `# ${task.id}\n\n${task.prompt}\n`);
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const status = 'pending';\n");
  }
  initializeGit(workspace);
  return workspace;
}

function initializeGit(workspace: string): void {
  try {
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "eval@tanya.local"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Tanya Eval"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "eval baseline"], { cwd: workspace, stdio: "ignore" });
  } catch {
    // Git is useful for diffs but not required for accounting errored tasks.
  }
}

function defaultExecutor(options: RunEvalOptions): EvalExecutor {
  return async (task, ctx) => {
    if (!options.providerFactory) throw new Error("eval runner requires a providerFactory");
    const provider = options.providerFactory();
    const outputChunks: string[] = [];
    const sink = createJsonlSink({
      write(chunk: string) {
        outputChunks.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream);
    const result = await runAgent({
      provider,
      prompt: task.prompt,
      cwd: ctx.workspace,
      sink,
      maxTurns: 40,
      runContext: { task: { kind: "coding" } },
    });
    const diff = safeGitDiff(ctx.workspace);
    const tokensUsed: EvalTokensUsed = {
      input: result.metrics?.promptTokens ?? 0,
      output: result.metrics?.completionTokens ?? 0,
      reasoning: result.metrics?.reasoningTokens ?? 0,
      system_prompt: result.metrics?.systemPromptTokens ?? 0,
      repo_map: result.metrics?.repoMapTokens ?? 0,
    };
    const costUsd = estimateRunCost({
      provider: ctx.provider,
      model: ctx.model,
      promptTokens: tokensUsed.input,
      completionTokens: tokensUsed.output,
      ...(tokensUsed.reasoning !== undefined ? { reasoningTokens: tokensUsed.reasoning } : {}),
    }).usd ?? 0;
    const extension = await runVerifierExtension(task, ctx.workspace, options.cwd);
    const verifierVerdict = extension
      ? extension.ok ? "passed" : "failed"
      : result.manifest.blockers.length === 0 ? "passed" : "failed";
    const errors = extension
      ? extension.ok ? [] : extension.errors
      : result.manifest.blockers;
    return {
      verifierVerdict,
      tokensUsed,
      costUsd,
      ...(diff ? { diff } : {}),
      ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
    };
  };
}

function safeGitDiff(workspace: string): string {
  try {
    return execFileSync("git", ["diff", "HEAD"], { cwd: workspace, encoding: "utf8" });
  } catch {
    return "";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("eval task timeout")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseTaskFilter(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

export function aggregateRuns(runs: EvalRunResult[]): Pick<EvalResult, "totalCostUsd" | "costPerPass" | "tokensPerPass" | "reasoningShare"> {
  const totalCostUsd = runs.reduce((sum, run) => sum + run.costUsd, 0);
  const passed = runs.filter((run) => run.status === "passed").length;
  const totalInput = runs.reduce((sum, run) => sum + run.tokensUsed.input, 0);
  const totalOutput = runs.reduce((sum, run) => sum + run.tokensUsed.output, 0);
  const totalReasoning = runs.reduce((sum, run) => sum + (run.tokensUsed.reasoning ?? 0), 0);
  const totalTokens = totalInput + totalOutput + totalReasoning;
  return {
    totalCostUsd,
    costPerPass: passed > 0 ? totalCostUsd / passed : null,
    tokensPerPass: passed > 0 ? totalTokens / passed : null,
    reasoningShare: totalTokens > 0 ? totalReasoning / totalTokens : 0,
  };
}
