import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { TanyaFinalManifest } from "../agent/runner";
import type { TanyaRunContext } from "../context/runContext";

export type TaskHistoryEntry = {
  timestamp: string;
  prompt: string;
  outcome: "passed" | "blocked";
  changedFiles: string[];
  gitHead: string | null;
};

export async function appendTaskHistory(
  workspace: string,
  prompt: string,
  manifest: TanyaFinalManifest,
  _runContext?: TanyaRunContext,
): Promise<void> {
  const historyPath = join(workspace, ".tanya", "history.json");
  await mkdir(dirname(historyPath), { recursive: true });
  let entries: TaskHistoryEntry[] = [];
  try {
    entries = JSON.parse(await readFile(historyPath, "utf8")) as TaskHistoryEntry[];
    if (!Array.isArray(entries)) entries = [];
  } catch {
    // First run or corrupt history; start fresh.
  }

  const validationErrors = manifest.validation?.issues.filter((issue) => issue.severity === "error") ?? [];
  const entry: TaskHistoryEntry = {
    timestamp: new Date().toISOString(),
    prompt: prompt.slice(0, 200),
    outcome: manifest.blockers.length === 0 && validationErrors.length === 0 ? "passed" : "blocked",
    changedFiles: manifest.changedFiles,
    gitHead: manifest.git.head,
  };

  entries = [...entries, entry].slice(-20);
  await writeFile(historyPath, JSON.stringify(entries, null, 2), "utf8");
}

export async function readRecentTaskHistory(workspace: string, count = 3): Promise<TaskHistoryEntry[]> {
  try {
    const raw = await readFile(join(workspace, ".tanya", "history.json"), "utf8");
    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries)) return [];
    return entries.slice(-count) as TaskHistoryEntry[];
  } catch {
    return [];
  }
}

export function buildHistoryBlock(entries: TaskHistoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["## Recent task history"];
  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    const files = entry.changedFiles.length > 0
      ? entry.changedFiles.join(", ")
      : "none";
    lines.push(`- [${date}] ${entry.outcome.toUpperCase()}: "${entry.prompt}" → changed: ${files}`);
  }
  return lines.join("\n");
}
