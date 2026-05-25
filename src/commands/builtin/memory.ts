import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readGoldenTaskMemory } from "../../memory/goldenTasks";
import { readReasoningArchive } from "../../memory/reasoningArchive";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const DEFAULT_LIMIT = 10;

const memoryCommand: CommandDefinition = {
  name: "memory",
  description: "Show recent golden-task memory.",
  category: "built-in",
  async handler(args, ctx) {
    const reasoningRunId = flagValue(args, "--reasoning");
    if (reasoningRunId) {
      const turn = parseOptionalNumber(flagValue(args, "--turn"));
      const entries = readReasoningArchive(ctx.cwd, reasoningRunId)
        .filter((entry) => turn === undefined || entry.turn === turn);
      if (entries.length === 0) {
        ctx.output.write(`No reasoning archive found for ${reasoningRunId}${turn === undefined ? "" : ` turn ${turn}`}.\n`);
        return;
      }
      ctx.output.write(`Reasoning archive for ${reasoningRunId}:\n`);
      for (const entry of entries) {
        const turnLabel = entry.turn === undefined ? "turn ?" : `turn ${entry.turn}`;
        ctx.output.write(`- ${entry.ts} ${turnLabel} ${entry.provider}:${entry.model} ${entry.tokens ?? 0} tokens\n`);
        ctx.output.write(`${indent(entry.content.trim() || "(empty)")}\n`);
      }
      return;
    }

    const records = [...await readGoldenTaskMemory(ctx.cwd)]
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const fullId = flagValue(args, "--full");
    if (fullId) {
      const record = records.find((candidate) => candidate.signature === fullId);
      if (!record) {
        ctx.output.write(`Golden task not found: ${fullId}\n`);
        return;
      }
      ctx.output.write(`${JSON.stringify(record, null, 2)}\n`);
      const children = await Promise.all(record.childRunIds.map((runId) => readChildRunSummary(ctx.cwd, runId)));
      const found = children.filter((child): child is ChildRunSummary => child !== null);
      if (found.length > 0) {
        ctx.output.write("Child runs:\n");
        for (const child of found) {
          const status = child.blockers.length > 0 ? "failed" : "passed";
          ctx.output.write(`  - ${child.runId}  ${status}  ${child.prompt}\n`);
        }
      }
      return;
    }

    const limit = parseLimit(flagValue(args, "--limit"));
    if (records.length === 0) {
      ctx.output.write("No golden task memory found.\n");
      return;
    }

    ctx.output.write("Recent golden tasks:\n");
    for (const record of records.slice(0, limit)) {
      const title = record.task?.title ?? "(untitled)";
      ctx.output.write(`${record.recordedAt.slice(0, 16)}  ${record.outcome.padEnd(6)}  ${record.signature}  ${title}\n`);
    }
  },
};

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parseLimit(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : DEFAULT_LIMIT;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

registerCommand(memoryCommand);

type ChildRunSummary = {
  runId: string;
  prompt: string;
  blockers: string[];
};

async function readChildRunSummary(workspace: string, runId: string): Promise<ChildRunSummary | null> {
  const runsRoot = join(workspace, ".tanya", "runs");
  const path = await findRunSummaryPath(runsRoot, `${runId}.json`);
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ChildRunSummary>;
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : runId,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "(prompt unavailable)",
      blockers: Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return null;
  }
}

async function findRunSummaryPath(dir: string, filename: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const nested = await findRunSummaryPath(path, filename);
      if (nested) return nested;
    }
  }
  return null;
}
