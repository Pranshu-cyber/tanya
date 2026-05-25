import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export type ReasoningArchiveEntry = {
  ts: string;
  runId: string;
  turn?: number;
  provider: string;
  model: string;
  content: string;
  tokens?: number;
  evicted?: boolean;
};

export async function appendReasoningChunk(params: {
  workspace: string;
  runId: string;
  turn?: number;
  provider: string;
  model: string;
  content: string;
  tokens?: number;
}): Promise<void> {
  if (!params.content) return;
  const dir = reasoningRunDir(params.workspace, params.runId);
  mkdirSync(dir, { recursive: true });
  const entry: ReasoningArchiveEntry = {
    ts: new Date().toISOString(),
    runId: params.runId,
    ...(params.turn !== undefined ? { turn: params.turn } : {}),
    provider: params.provider,
    model: params.model,
    content: params.content,
    ...(params.tokens !== undefined ? { tokens: params.tokens } : {}),
  };
  await appendFile(reasoningArchivePath(params.workspace, params.runId), `${JSON.stringify(entry)}\n`, "utf8");
}

export function readReasoningArchive(workspace: string, runId: string): ReasoningArchiveEntry[] {
  const file = reasoningArchivePath(workspace, runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<ReasoningArchiveEntry>;
        if (typeof parsed.content !== "string") return [];
        return [{
          ts: typeof parsed.ts === "string" ? parsed.ts : "",
          runId: typeof parsed.runId === "string" ? parsed.runId : runId,
          ...(typeof parsed.turn === "number" ? { turn: parsed.turn } : {}),
          provider: typeof parsed.provider === "string" ? parsed.provider : "unknown",
          model: typeof parsed.model === "string" ? parsed.model : "unknown",
          content: parsed.content,
          ...(typeof parsed.tokens === "number" ? { tokens: parsed.tokens } : {}),
          ...(parsed.evicted === true ? { evicted: true } : {}),
        }];
      } catch {
        return [];
      }
    });
}

export function evictReasoningFromArchive(workspace: string, runId: string, thresholdBytes: number): number {
  const file = reasoningArchivePath(workspace, runId);
  if (!existsSync(file)) return 0;
  const before = statSync(file).size;
  if (before <= thresholdBytes) return 0;
  const entries = readReasoningArchive(workspace, runId);
  const tombstone: ReasoningArchiveEntry = {
    ts: new Date().toISOString(),
    runId,
    provider: "archive",
    model: "eviction",
    content: `<reasoning archive evicted ${before} bytes; live conversation history was already reasoning-free>`,
    evicted: true,
  };
  const next = `${entries
    .filter((entry) => entry.evicted)
    .concat(tombstone)
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, file);
  return Math.max(0, before - statSync(file).size);
}

export function reasoningArchivePath(workspace: string, runId: string): string {
  return join(reasoningRunDir(workspace, runId), "reasoning.jsonl");
}

function reasoningRunDir(workspace: string, runId: string): string {
  return join(workspace, ".tanya", "runs", runId);
}
