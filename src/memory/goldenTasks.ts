import { appendFile, mkdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { TanyaRunContext } from "../context/runContext";

const GOLDEN_TASK_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const GOLDEN_TASK_KEEP_LATEST = 200;

async function rotateGoldenTaskFileIfTooLarge(memoryPath: string): Promise<void> {
  let info;
  try {
    info = await stat(memoryPath);
  } catch {
    return;
  }
  if (info.size <= GOLDEN_TASK_MAX_BYTES) return;
  let raw = "";
  try {
    raw = await readFile(memoryPath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const kept = lines.slice(-GOLDEN_TASK_KEEP_LATEST);
  await writeFile(`${memoryPath}.compact`, `${kept.join("\n")}\n`, "utf8");
  await rename(`${memoryPath}.compact`, memoryPath);
}

type GoldenTaskManifest = {
  changedFiles: string[];
  artifactsRead: string[];
  artifactsCreated: string[];
  verification: string[];
  blockers: string[];
  toolErrors: number;
  childRunIds?: string[];
  validation?: {
    passed: boolean;
    issues: Array<{ id: string; severity: string; message: string; files?: string[] }>;
  };
};

export type GoldenTaskRecord = {
  schemaVersion: 1;
  recordedAt: string;
  signature: string;
  task: TanyaRunContext["task"] | null;
  caller: unknown;
  outcome: "passed" | "failed";
  changedFiles: string[];
  artifactsRead: string[];
  artifactsCreated: string[];
  verificationCount: number;
  toolErrors: number;
  blockers: string[];
  childRunIds: string[];
  validation: GoldenTaskManifest["validation"] | null;
};

export type GoldenTaskSummary = {
  total: number;
  passed: number;
  failed: number;
  signatures: number;
  latestBySignature: GoldenTaskRecord[];
  failureReasons: Array<{ reason: string; count: number }>;
};

function enabled(runContext?: TanyaRunContext): boolean {
  if (runContext?.metadata?.subAgent === true || runContext?.metadata?.subAgent === "true") return false;
  const value = runContext?.metadata?.goldenTask ?? runContext?.metadata?.goldenTaskCandidate;
  return value === true || value === "true" || value === "yes";
}

function taskSignature(runContext: TanyaRunContext | undefined, manifest: GoldenTaskManifest): string {
  const source = JSON.stringify({
    kind: runContext?.task?.kind ?? null,
    title: runContext?.task?.title ?? null,
    artifacts: manifest.artifactsRead,
    changedExtensions: [...new Set(manifest.changedFiles.map((file) => file.split(".").pop()?.toLowerCase()).filter(Boolean))].sort(),
  });
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export async function recordGoldenTaskMemory(workspace: string, manifest: GoldenTaskManifest, runContext?: TanyaRunContext): Promise<void> {
  if (!enabled(runContext)) return;
  const memoryPath = join(workspace, ".tanya", "memory", "golden-tasks.jsonl");
  const validationErrors = manifest.validation?.issues.filter((issue) => issue.severity === "error") ?? [];
  const record: GoldenTaskRecord = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    signature: taskSignature(runContext, manifest),
    task: runContext?.task ?? null,
    caller: runContext?.metadata?.caller ?? null,
    outcome: manifest.blockers.length === 0 && validationErrors.length === 0 ? "passed" : "failed",
    changedFiles: manifest.changedFiles,
    artifactsRead: manifest.artifactsRead,
    artifactsCreated: manifest.artifactsCreated,
    verificationCount: manifest.verification.length,
    toolErrors: manifest.toolErrors,
    blockers: manifest.blockers,
    childRunIds: manifest.childRunIds ?? [],
    validation: manifest.validation ?? null,
  };
  await mkdir(dirname(memoryPath), { recursive: true });
  await appendFile(memoryPath, `${JSON.stringify(record)}\n`, "utf8");
  await rotateGoldenTaskFileIfTooLarge(memoryPath);
}

export async function readGoldenTaskMemory(workspace: string): Promise<GoldenTaskRecord[]> {
  const memoryPath = join(workspace, ".tanya", "memory", "golden-tasks.jsonl");
  let raw = "";
  try {
    raw = await readFile(memoryPath, "utf8");
  } catch {
    return [];
  }
  const records: GoldenTaskRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as GoldenTaskRecord;
      if (parsed?.schemaVersion === 1 && typeof parsed.signature === "string") {
        records.push({ ...parsed, childRunIds: parsed.childRunIds ?? [] });
      }
    } catch {
      // Ignore corrupt historical lines; the suite summary should remain usable.
    }
  }
  return records;
}

export function buildGoldenTaskSummary(records: GoldenTaskRecord[]): GoldenTaskSummary {
  const latest = new Map<string, GoldenTaskRecord>();
  for (const record of records) {
    const previous = latest.get(record.signature);
    if (!previous || previous.recordedAt < record.recordedAt) latest.set(record.signature, record);
  }

  const failureCounts = new Map<string, number>();
  for (const record of records.filter((item) => item.outcome === "failed")) {
    const validationErrors = record.validation?.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.id) ?? [];
    const reasons = [...record.blockers, ...validationErrors];
    for (const reason of reasons.length ? reasons : ["failed-without-reason"]) {
      failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
    }
  }

  return {
    total: records.length,
    passed: records.filter((record) => record.outcome === "passed").length,
    failed: records.filter((record) => record.outcome === "failed").length,
    signatures: latest.size,
    latestBySignature: [...latest.values()].sort((a, b) => a.signature.localeCompare(b.signature)),
    failureReasons: [...failureCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

export function validateGoldenTaskSummary(summary: GoldenTaskSummary): string[] {
  const problems: string[] = [];
  if (summary.total === 0) problems.push("No golden task records found.");
  const latestFailures = summary.latestBySignature.filter((record) => record.outcome === "failed");
  for (const record of latestFailures) {
    const title = record.task?.title ?? record.signature;
    const errors = record.validation?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.id) ?? [];
    const reasons = [...record.blockers, ...errors];
    problems.push(`${title}: ${reasons.join("; ") || "failed"}`);
  }
  return problems;
}
