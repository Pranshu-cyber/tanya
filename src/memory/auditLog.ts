import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { basename, join } from "node:path";
import type { PermissionMode } from "../safety/permissions/schema";

export interface AuditDecisionEntry {
  ts: string;
  runId: string;
  parentRunId?: string;
  tool: string;
  input: unknown;
  decision: "allow" | "deny" | "ask";
  matchedRule?: string;
  reason?: string;
  source: "user" | "rule" | "engine" | "bypass" | `mcp:${string}`;
  projectedCostUsd?: number;
  projectedTokens?: number;
  thresholdUsd?: number;
  thresholdTokens?: number;
  mode: PermissionMode;
}

export interface AuditReadFilters {
  limit?: number;
  denyOnly?: boolean;
  sinceMs?: number;
  tool?: string;
}

export const DEFAULT_AUDIT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_AUDIT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function appendAuditDecision(workspace: string, entry: AuditDecisionEntry, options: {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: Date;
} = {}): void {
  const path = auditPath(workspace);
  mkdirSync(join(workspace, ".tanya"), { recursive: true });
  rotateAuditIfNeeded(workspace, options);
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}

export function readAuditDecisions(workspace: string, filters: AuditReadFilters = {}): AuditDecisionEntry[] {
  const path = auditPath(workspace);
  if (!existsSync(path)) return [];
  const sinceTs = filters.sinceMs === undefined ? null : Date.now() - filters.sinceMs;
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AuditDecisionEntry];
      } catch {
        return [];
      }
    })
    .filter((entry) => !filters.denyOnly || entry.decision === "deny")
    .filter((entry) => !filters.tool || entry.tool === filters.tool)
    .filter((entry) => sinceTs === null || Date.parse(entry.ts) >= sinceTs)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const limit = filters.limit ?? entries.length;
  return entries.slice(Math.max(0, entries.length - limit));
}

export function auditPath(workspace: string): string {
  return join(workspace, ".tanya", "audit.jsonl");
}

function rotateAuditIfNeeded(workspace: string, options: {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: Date;
}): void {
  const path = auditPath(workspace);
  if (!existsSync(path)) return;
  const stats = statSync(path);
  const maxBytes = options.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_AUDIT_MAX_AGE_MS;
  const now = options.now ?? new Date();
  if (stats.size < maxBytes && now.getTime() - stats.mtimeMs < maxAgeMs) return;

  const archiveDir = join(workspace, ".tanya", "audit", "archive");
  mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, `audit-${stamp}-${basename(path)}.gz`);
  writeFileSync(archivePath, gzipSync(readFileSync(path)));
  unlinkSync(path);
}
