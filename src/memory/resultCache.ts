import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const RESULT_CACHE_MAX_BYTES = 100 * 1024 * 1024;

export type ResultByteRange = {
  startByte: number;
  endByte: number;
};

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 160) || "result";
}

export function resultCacheDir(workspace: string, runId: string): string {
  return join(workspace, ".tanya", "cache", "results", safeSegment(runId));
}

export function resultCachePath(workspace: string, runId: string, toolCallId: string): string {
  return join(resultCacheDir(workspace, runId), `${safeSegment(toolCallId)}.txt`);
}

export function writeCachedToolResult(workspace: string, runId: string, toolCallId: string, content: string): string {
  const dir = resultCacheDir(workspace, runId);
  mkdirSync(dir, { recursive: true });
  const path = resultCachePath(workspace, runId, toolCallId);
  writeFileSync(path, content, "utf8");
  evictRunCache(dir);
  return path;
}

export async function readCachedToolResult(
  workspace: string,
  runId: string,
  toolCallId: string,
  range?: ResultByteRange,
): Promise<string | null> {
  const path = resultCachePath(workspace, runId, toolCallId);
  if (!existsSync(path)) return null;
  const buffer = await readFile(path);
  if (!range) return buffer.toString("utf8");
  const start = Math.max(0, Math.floor(range.startByte));
  const end = Math.max(start, Math.min(buffer.length, Math.floor(range.endByte)));
  return buffer.subarray(start, end).toString("utf8");
}

function evictRunCache(dir: string): void {
  let entries = cacheEntries(dir);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= RESULT_CACHE_MAX_BYTES) return;
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    try {
      rmSync(entry.path, { force: true });
      total -= entry.size;
      if (total <= RESULT_CACHE_MAX_BYTES) break;
    } catch {
      // Cache eviction is best-effort.
    }
  }
  entries = cacheEntries(dir);
  if (entries.length === 0) {
    try { rmSync(dir, { force: true, recursive: true }); } catch { /* best-effort */ }
  }
}

function cacheEntries(dir: string): Array<{ path: string; size: number; mtimeMs: number }> {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".txt"))
      .flatMap((file) => {
        const path = join(dir, file);
        try {
          const stat = statSync(path);
          return stat.isFile() ? [{ path, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
