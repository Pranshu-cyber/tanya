import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// A persistent task ledger. The interactive chat used to keep no record of its
// plan — when a long build hit the budget, "continue" started cold and the model
// had to re-infer where it was (the amnesia). A ledger written to the workspace
// is the durable spine: the model writes the plan, checks steps off, and the
// remaining work can be re-read on resume instead of guessed.

export type PlanStepStatus = "pending" | "in_progress" | "done";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface TaskLedger {
  steps: PlanStep[];
}

// `.tania/` is the gitignored workspace runtime-state dir used across the repo
// (artifacts, context, metrics). The plan lives there so it is never committed
// or picked up as a changed file / scanned by the validators.
const LEDGER_REL = ".tania/plan.json";
const VALID_STATUSES: PlanStepStatus[] = ["pending", "in_progress", "done"];

export function normalizeLedger(steps: Array<{ text?: unknown; status?: unknown }>): TaskLedger {
  return {
    steps: steps
      .map((s) => ({
        text: typeof s?.text === "string" ? s.text.trim() : "",
        status: VALID_STATUSES.includes(s?.status as PlanStepStatus) ? (s.status as PlanStepStatus) : "pending",
      }))
      .filter((s) => s.text.length > 0),
  };
}

export function remainingSteps(ledger: TaskLedger): PlanStep[] {
  return ledger.steps.filter((s) => s.status !== "done");
}

export function isComplete(ledger: TaskLedger): boolean {
  return ledger.steps.length > 0 && ledger.steps.every((s) => s.status === "done");
}

function stepGlyph(status: PlanStepStatus): string {
  return status === "done" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
}

export function renderLedger(ledger: TaskLedger): string {
  return ledger.steps.map((s, i) => `${stepGlyph(s.status)} ${i + 1}. ${s.text}`).join("\n");
}

// A compact "done so far / remaining" string to re-inject on resume so a
// continuation picks up where it left off instead of re-doing completed work.
export function resumeSummary(ledger: TaskLedger): string {
  const done = ledger.steps.filter((s) => s.status === "done").map((s) => s.text);
  const remaining = remainingSteps(ledger).map((s) => s.text);
  const lines: string[] = [];
  if (done.length) lines.push(`Completed: ${done.map((t, i) => `(${i + 1}) ${t}`).join("; ")}`);
  if (remaining.length) lines.push(`Remaining: ${remaining.map((t, i) => `(${i + 1}) ${t}`).join("; ")}`);
  return lines.join("\n");
}

export function ledgerPath(workspace: string): string {
  return join(workspace, LEDGER_REL);
}

export async function loadLedger(workspace: string): Promise<TaskLedger | null> {
  try {
    const raw = await readFile(ledgerPath(workspace), "utf8");
    const parsed = JSON.parse(raw) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    return normalizeLedger(parsed.steps as Array<{ text?: unknown; status?: unknown }>);
  } catch {
    return null;
  }
}

export async function saveLedger(workspace: string, ledger: TaskLedger): Promise<void> {
  const path = ledgerPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}
