import type { ChatMessage } from "../providers/types";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ArchivedMessage {
  archivedAt: string;
  originalTs?: string;
  role: ChatMessage["role"];
  content: string;
  toolName?: string;
  tokens?: number;
}

export interface ArchiveOptions {
  workspace?: string;
}

const appendQueues = new Map<string, Promise<void>>();

export async function appendArchive(runId: string, messages: ArchivedMessage[], options: ArchiveOptions = {}): Promise<void> {
  if (messages.length === 0) return;
  const path = archivePath(options.workspace ?? process.cwd(), runId);
  await mkdir(join(options.workspace ?? process.cwd(), ".tanya", "runs", runId), { recursive: true });
  const payload = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
  const previous = appendQueues.get(path) ?? Promise.resolve();
  const next = previous.then(() => appendFile(path, payload, "utf8"));
  appendQueues.set(path, next.catch(() => {}));
  await next;
}

// Best-effort archive append. The archive is an audit trail; a permission-denied
// or ENOSPC at the archive path should surface through the run's event sink
// (so it appears in the run log) rather than silently dropping the audit entry
// or crashing the run loop.
export async function safeAppendArchive(
  runId: string,
  messages: ArchivedMessage[],
  options: ArchiveOptions = {},
  onError?: (err: Error) => void | Promise<void>,
): Promise<void> {
  try {
    await appendArchive(runId, messages, options);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!onError) return;
    try {
      await onError(error);
    } catch {
      // The sink itself failing must not crash the run either.
    }
  }
}

export async function readArchive(runId: string, options: ArchiveOptions = {}): Promise<ArchivedMessage[]> {
  const path = archivePath(options.workspace ?? process.cwd(), runId);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw.split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<ArchivedMessage>;
        if (typeof parsed.archivedAt !== "string" || typeof parsed.role !== "string" || typeof parsed.content !== "string") return [];
        return [{
          archivedAt: parsed.archivedAt,
          ...(typeof parsed.originalTs === "string" ? { originalTs: parsed.originalTs } : {}),
          role: parsed.role as ChatMessage["role"],
          content: parsed.content,
          ...(typeof parsed.toolName === "string" ? { toolName: parsed.toolName } : {}),
          ...(typeof parsed.tokens === "number" ? { tokens: parsed.tokens } : {}),
        }];
      } catch {
        return [];
      }
    });
}

export async function searchArchive(runId: string, query: string, options: ArchiveOptions = {}): Promise<ArchivedMessage[]> {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const entries = await readArchive(runId, options);
  return entries.filter((entry) =>
    entry.content.toLowerCase().includes(needle) ||
    entry.toolName?.toLowerCase().includes(needle),
  );
}

export function toArchivedMessages(messages: ChatMessage[], archivedAt = new Date().toISOString()): ArchivedMessage[] {
  const toolNamesById = new Map<string, string>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      toolNamesById.set(toolCall.id, toolCall.function.name);
    }
  }

  return messages.map((message) => {
    const content = JSON.stringify({
      content: message.content,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    });
    const toolName = message.tool_calls?.map((call) => call.function.name).filter(Boolean).join(",") ||
      (message.tool_call_id ? toolNamesById.get(message.tool_call_id) : undefined);
    return {
      archivedAt,
      role: message.role,
      content,
      ...(toolName ? { toolName } : {}),
      tokens: Math.ceil(JSON.stringify(message).length / 4),
    };
  });
}

export function fileTouchPathsFromArchive(entries: ArchivedMessage[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    for (const path of fileTouchPathsFromArchivedContent(entry.content)) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

function archivePath(workspace: string, runId: string): string {
  return join(workspace, ".tanya", "runs", runId, "archive.jsonl");
}

function fileTouchPathsFromArchivedContent(content: string): string[] {
  const paths = new Set<string>();
  try {
    const parsed = JSON.parse(content) as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
    for (const toolCall of parsed.tool_calls ?? []) {
      const name = toolCall.function?.name;
      const rawArgs = toolCall.function?.arguments;
      if (!name || !rawArgs) continue;
      for (const path of fileTouchPathsFromToolArguments(name, rawArgs)) paths.add(path);
    }
  } catch {
    // Fall through to regex extraction below.
  }

  for (const match of content.matchAll(/\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+([^\n]+)/g)) {
    const path = match[1]?.trim();
    if (path) paths.add(path);
  }
  return [...paths];
}

function fileTouchPathsFromToolArguments(toolName: string, rawArguments: string): string[] {
  if (toolName === "apply_patch") return patchPaths(rawArguments);
  if (!["write_file", "search_replace", "read_file"].includes(toolName)) return [];
  try {
    const parsed = JSON.parse(rawArguments) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path.trim() ? [parsed.path.trim()] : [];
  } catch {
    return [];
  }
}

function patchPaths(rawArguments: string): string[] {
  const paths = new Set<string>();
  try {
    const parsed = JSON.parse(rawArguments) as { patch?: unknown };
    const patch = typeof parsed.patch === "string" ? parsed.patch : rawArguments;
    for (const match of patch.matchAll(/\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+([^\n]+)/g)) {
      const path = match[1]?.trim();
      if (path) paths.add(path);
    }
  } catch {
    for (const match of rawArguments.matchAll(/\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+([^\n]+)/g)) {
      const path = match[1]?.trim();
      if (path) paths.add(path);
    }
  }
  return [...paths];
}
