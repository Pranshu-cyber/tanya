import { stdout } from "node:process";
import { deleteSession, listSessions, loadSession, pruneOlderThan } from "../sessions/storage";
import type { SessionSummary } from "../sessions/types";

export interface SessionsCommandOptions {
  action?: string | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  global?: boolean | undefined;
  all?: boolean | undefined;
  limit?: number | undefined;
  olderThan?: string | undefined;
  output?: NodeJS.WritableStream | undefined;
}

const HEADER = `${"ID".padEnd(24)} ${"AGE".padEnd(10)} ${"TURNS".padStart(5)}  LABEL`;

export async function runSessionsCommand(options: SessionsCommandOptions): Promise<void> {
  const output = options.output ?? stdout;
  const action = options.action ?? "list";
  if (action === "list") {
    output.write(formatSessionList(listSessions({
      cwd: options.cwd,
      global: options.global,
      all: options.all,
      limit: options.limit,
    }), outputColumns(output)));
    return;
  }
  if (action === "show") {
    const id = options.args?.[0];
    if (!id) throw new Error("Usage: tanya sessions show <id>");
    const loaded = loadSession(id, { cwd: options.cwd });
    output.write(formatSessionTranscript(loaded.session));
    return;
  }
  if (action === "rm") {
    const id = options.args?.[0];
    if (!id) throw new Error("Usage: tanya sessions rm <id>");
    const deleted = deleteSession(id, { cwd: options.cwd });
    output.write(`Deleted session ${deleted}\n`);
    return;
  }
  if (action === "prune") {
    const raw = options.olderThan ?? flagValue(options.args ?? [], "--older-than");
    if (!raw) throw new Error("Usage: tanya sessions prune --older-than 30d");
    const deleted = pruneOlderThan(parseDurationMs(raw), { cwd: options.cwd, global: options.global });
    output.write(`Deleted ${deleted} session${deleted === 1 ? "" : "s"}.\n`);
    return;
  }
  throw new Error("Usage: tanya sessions list|show|rm|prune");
}

export function formatSessionList(sessions: SessionSummary[], columns = 100): string {
  const fixedWidth = 24 + 1 + 10 + 1 + 5 + 2;
  const labelWidth = Math.max(20, columns - fixedWidth);
  const lines = [HEADER];
  for (const session of sessions) {
    lines.push([
      session.id.padEnd(24),
      relativeAge(new Date(session.lastUpdatedAt), new Date()).padEnd(10),
      String(session.turnCount).padStart(5),
      truncate(session.label || "(untitled)", labelWidth),
    ].join(" "));
  }
  if (sessions.length === 0) lines.push("No sessions found.");
  return `${lines.join("\n")}\n`;
}

export function formatSessionTranscript(session: { id: string; turns: Array<{ role: string; content: string; timestampMs: number; elapsedMs?: number | null }> }): string {
  const lines = [`Session ${session.id}`, ""];
  for (const turn of session.turns) {
    const stamp = new Date(turn.timestampMs).toISOString();
    const elapsed = typeof turn.elapsedMs === "number" ? ` · ${Math.round(turn.elapsedMs / 1000)}s` : "";
    lines.push(`[${stamp}] ${turn.role}${elapsed}`);
    lines.push(turn.content);
    lines.push("");
  }
  return lines.join("\n");
}

export function parseDurationMs(raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration "${raw}". Use values like 30d, 12h, or 45m.`);
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

function outputColumns(output: NodeJS.WritableStream): number {
  return Math.max(60, (output as NodeJS.WritableStream & { columns?: number }).columns ?? 100);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}

function relativeAge(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}
