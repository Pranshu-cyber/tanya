import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envValue } from "../config/envCompat";
import type { TanyaRunContext } from "../context/runContext";

export type RepairAttemptSnapshot = {
  attempt: number;
  issueIds: string[];
  blockerCount: number;
  changedFileCount: number;
};

export type RepairRunRecord = {
  schemaVersion: 1;
  recordedAt: string;
  signature: string;
  task: TanyaRunContext["task"] | null;
  caller: unknown;
  attempts: RepairAttemptSnapshot[];
  outcome: "passed" | "failed";
  finalIssueIds: string[];
  finalBlockers: string[];
};

type RepairManifest = {
  changedFiles: string[];
  blockers: string[];
  validation?: {
    passed: boolean;
    issues: Array<{ id: string; severity: string; message: string; files?: string[] }>;
  };
};

function memoryRoot(): string {
  return envValue({}, "TANYA_MEMORY_HOME").trim() || join(homedir(), ".tanya", "memory");
}

function taskSignature(runContext: TanyaRunContext | undefined, attempts: RepairAttemptSnapshot[]): string {
  const source = JSON.stringify({
    kind: runContext?.task?.kind ?? null,
    title: runContext?.task?.title ?? null,
    issueIds: [...new Set(attempts.flatMap((attempt) => attempt.issueIds))].sort(),
  });
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export async function recordRepairRunMemory(runContext: TanyaRunContext | undefined, attempts: RepairAttemptSnapshot[], manifest: RepairManifest): Promise<void> {
  if (attempts.length === 0) return;
  const finalErrors = manifest.validation?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.id) ?? [];
  const record: RepairRunRecord = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    signature: taskSignature(runContext, attempts),
    task: runContext?.task ?? null,
    caller: runContext?.metadata?.caller ?? null,
    attempts,
    outcome: manifest.blockers.length === 0 && finalErrors.length === 0 ? "passed" : "failed",
    finalIssueIds: finalErrors,
    finalBlockers: manifest.blockers,
  };
  const path = join(memoryRoot(), "repair-runs.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readRepairRunMemory(): Promise<RepairRunRecord[]> {
  const path = join(memoryRoot(), "repair-runs.jsonl");
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const records: RepairRunRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RepairRunRecord;
      if (parsed?.schemaVersion === 1 && typeof parsed.signature === "string") records.push(parsed);
    } catch {
      // Ignore corrupt historical lines so memory remains best-effort.
    }
  }
  return records;
}
