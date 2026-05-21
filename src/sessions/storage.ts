import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { estimateRunCost } from "../memory/runLogs";
import type { ChatSession, LoadedSession, SessionStats, SessionSummary, SessionTurn } from "./types";

interface StorageOptions {
  cwd?: string | undefined;
  homeDir?: string | undefined;
}

export interface CreateSessionOptions extends StorageOptions {
  provider: string;
  model: string;
  label?: string;
  id?: string;
  now?: Date;
}

export interface ListSessionsOptions extends StorageOptions {
  global?: boolean | undefined;
  limit?: number | undefined;
  all?: boolean | undefined;
}

const activeSessionPaths = new Map<string, string>();

function defaultCwd(cwd?: string): string {
  return resolve(cwd ?? process.cwd());
}

function defaultHome(homeDir?: string): string {
  return resolve(homeDir ?? homedir());
}

function globalSessionsDir(homeDir?: string): string {
  return join(defaultHome(homeDir), ".tania", "sessions", "global");
}

function findProjectTaniaDir(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".tania");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveSessionsDir(options: StorageOptions = {}): { dir: string; scope: "project" | "global" } {
  const projectTania = findProjectTaniaDir(defaultCwd(options.cwd));
  if (projectTania) return { dir: join(projectTania, "sessions"), scope: "project" };
  return { dir: globalSessionsDir(options.homeDir), scope: "global" };
}

function ensureSessionsDir(dir: string, scope: "project" | "global"): void {
  mkdirSync(dir, { recursive: true });
  if (scope === "project") {
    const ignorePath = join(dir, ".gitignore");
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n", "utf8");
  }
}

function shortLabel(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 77)}...`;
}

export function createSession(options: CreateSessionOptions): ChatSession {
  const now = options.now ?? new Date();
  const cwd = defaultCwd(options.cwd);
  const id = options.id ?? createSessionId(now);
  const { dir, scope } = resolveSessionsDir({ cwd, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  ensureSessionsDir(dir, scope);
  const session: ChatSession = {
    id,
    createdAt: now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    cwd,
    provider: options.provider,
    model: options.model,
    turns: [],
    sessionStats: emptyStats(),
    label: shortLabel(options.label ?? ""),
  };
  writeFileSync(sessionPath(dir, id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  activeSessionPaths.set(id, sessionPath(dir, id));
  return session;
}

export function createSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "-",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

export function appendTurn(sessionId: string, turn: SessionTurn): void {
  const path = resolveSessionJsonPath(sessionId);
  appendFileSync(jsonlPathFor(path), `${JSON.stringify(sanitizeTurn(turn))}\n`, "utf8");
}

export function materialize(sessionId: string, options: StorageOptions & { label?: string } = {}): ChatSession {
  const path = resolveSessionJsonPath(sessionId, options);
  const base = readBaseSession(path);
  const { turns, warnings } = readTurnsFromJsonl(jsonlPathFor(path), path);
  for (const warning of warnings) console.warn(warning);
  const now = new Date().toISOString();
  const session: ChatSession = {
    ...base,
    lastUpdatedAt: now,
    turns,
    sessionStats: buildStats(base, turns, now),
    label: shortLabel(options.label ?? (base.label || firstUserLabel(turns))),
  };
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  activeSessionPaths.set(session.id, path);
  return session;
}

export function updateSessionLabel(sessionId: string, label: string, options: StorageOptions = {}): ChatSession {
  const session = materialize(sessionId, options);
  const path = resolveSessionJsonPath(sessionId, options);
  const updated = { ...session, label: shortLabel(label), lastUpdatedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export function listSessions(options: ListSessionsOptions = {}): SessionSummary[] {
  const cwd = defaultCwd(options.cwd);
  const dirs = sessionDirsForListing(options);
  const sessions = dirs.flatMap(({ dir, scope }) => readSessionSummaries(dir, scope));
  const filtered = options.cwd && !options.global
    ? sessions.filter((session) => cwdMatches(session.cwd, cwd) || session.scope === "global")
    : sessions;
  const sorted = filtered.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt) || b.id.localeCompare(a.id));
  return options.all ? sorted : sorted.slice(0, options.limit ?? 10);
}

export function findContinueSession(options: StorageOptions = {}): LoadedSession | null {
  const cwd = defaultCwd(options.cwd);
  const projectSessions = sessionDirsForListing({ ...options, global: false })
    .filter((entry) => entry.scope === "project")
    .flatMap(({ dir, scope }) => readSessionSummaries(dir, scope))
    .filter((session) => cwdMatches(session.cwd, cwd))
    .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
  const selected = projectSessions[0] ?? readSessionSummaries(globalSessionsDir(options.homeDir), "global")
    .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt))[0];
  return selected ? loadSession(selected.id, options) : null;
}

export function loadSession(idOrPrefix: string, options: StorageOptions = {}): LoadedSession {
  const matches = findSessionPathMatches(idOrPrefix, options);
  if (matches.length === 0) throw new Error(`Session not found: ${idOrPrefix}`);
  if (matches.length > 1) {
    throw new Error(`Session id "${idOrPrefix}" is ambiguous: ${matches.map((match) => match.id).join(", ")}`);
  }
  const match = matches[0]!;
  const base = readBaseSession(match.path);
  const { turns, warnings } = readTurnsFromJsonl(jsonlPathFor(match.path), match.path);
  for (const warning of warnings) console.warn(warning);
  const lastUpdatedAt = latestUpdatedAt(base, turns);
  const session: ChatSession = {
    ...base,
    turns,
    lastUpdatedAt,
    sessionStats: buildStats(base, turns, lastUpdatedAt),
    label: base.label || firstUserLabel(turns),
  };
  activeSessionPaths.set(session.id, match.path);
  return { session, path: match.path, jsonlPath: jsonlPathFor(match.path), scope: match.scope, warnings };
}

export function deleteSession(idOrPrefix: string, options: StorageOptions = {}): string {
  const loaded = loadSession(idOrPrefix, options);
  rmSync(loaded.path, { force: true });
  rmSync(loaded.jsonlPath, { force: true });
  activeSessionPaths.delete(loaded.session.id);
  return loaded.session.id;
}

export function pruneOlderThan(ms: number, options: ListSessionsOptions = {}): number {
  const cutoff = Date.now() - ms;
  let deleted = 0;
  for (const session of listSessions({ ...options, all: true })) {
    const updatedMs = Date.parse(session.lastUpdatedAt);
    if (Number.isFinite(updatedMs) && updatedMs < cutoff) {
      rmSync(session.path, { force: true });
      rmSync(jsonlPathFor(session.path), { force: true });
      activeSessionPaths.delete(session.id);
      deleted += 1;
    }
  }
  return deleted;
}

function emptyStats(): SessionStats {
  return { elapsedMs: 0, generateMs: 0, turnCount: 0, costUsd: 0, totalTokens: 0 };
}

function sanitizeTurn(turn: SessionTurn): SessionTurn {
  const sanitized: SessionTurn = {
    role: turn.role,
    content: String(turn.content ?? ""),
    timestampMs: Number.isFinite(turn.timestampMs) ? turn.timestampMs : Date.now(),
  };
  if (turn.elapsedMs !== undefined) sanitized.elapsedMs = turn.elapsedMs;
  if (turn.metrics) sanitized.metrics = { ...turn.metrics };
  return sanitized;
}

function sessionPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function jsonlPathFor(path: string): string {
  return path.replace(/\.json$/, ".jsonl");
}

function readBaseSession(path: string): ChatSession {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChatSession>;
  if (!parsed.id || !parsed.createdAt || !parsed.cwd || !parsed.provider || !parsed.model) {
    throw new Error(`Invalid session file: ${path}`);
  }
  return {
    id: parsed.id,
    createdAt: parsed.createdAt,
    lastUpdatedAt: parsed.lastUpdatedAt ?? parsed.createdAt,
    cwd: parsed.cwd,
    provider: parsed.provider,
    model: parsed.model,
    turns: Array.isArray(parsed.turns) ? parsed.turns.flatMap(parseTurn) : [],
    sessionStats: parsed.sessionStats ?? emptyStats(),
    label: typeof parsed.label === "string" ? parsed.label : "",
  };
}

function readTurnsFromJsonl(path: string, fallbackJsonPath: string): { turns: SessionTurn[]; warnings: string[] } {
  if (!existsSync(path)) return { turns: readBaseSession(fallbackJsonPath).turns, warnings: [] };
  const raw = readFileSync(path, "utf8");
  const turns: SessionTurn[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      const turn = parseTurn(parsed);
      if (turn.length === 0) throw new Error("not a session turn");
      turns.push(...turn);
    } catch (error) {
      warnings.push(`Warning: ignored corrupt session JSONL line ${index + 1} in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { turns, warnings };
}

function parseTurn(value: unknown): SessionTurn[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Partial<SessionTurn>;
  if ((record.role !== "user" && record.role !== "assistant") || typeof record.content !== "string" || typeof record.timestampMs !== "number") return [];
  return [sanitizeTurn(record as SessionTurn)];
}

function buildStats(base: ChatSession, turns: SessionTurn[], lastUpdatedAt: string): SessionStats {
  let generateMs = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let costKnown = false;
  let assistantTurns = 0;
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    assistantTurns += 1;
    generateMs += typeof turn.elapsedMs === "number" ? turn.elapsedMs : 0;
    const promptTokens = turn.metrics?.promptTokens ?? 0;
    const completionTokens = turn.metrics?.completionTokens ?? 0;
    const reasoningTokens = turn.metrics?.reasoningTokens ?? 0;
    totalTokens += promptTokens + completionTokens + reasoningTokens;
    const estimate = estimateRunCost({
      provider: base.provider,
      model: base.model,
      promptTokens,
      completionTokens,
      reasoningTokens,
    });
    if (estimate.usd !== null) {
      costKnown = true;
      costUsd += estimate.usd;
    }
  }
  const createdMs = Date.parse(base.createdAt);
  const updatedMs = Date.parse(lastUpdatedAt);
  return {
    elapsedMs: Number.isFinite(createdMs) && Number.isFinite(updatedMs) ? Math.max(0, updatedMs - createdMs) : 0,
    generateMs,
    turnCount: assistantTurns,
    costUsd: costKnown ? costUsd : 0,
    totalTokens,
  };
}

function firstUserLabel(turns: SessionTurn[]): string {
  return shortLabel(turns.find((turn) => turn.role === "user")?.content ?? "");
}

function latestUpdatedAt(base: ChatSession, turns: SessionTurn[]): string {
  const latestTurn = turns.reduce((latest, turn) => Math.max(latest, turn.timestampMs), 0);
  const baseUpdated = Date.parse(base.lastUpdatedAt);
  const latest = Math.max(Number.isFinite(baseUpdated) ? baseUpdated : 0, latestTurn);
  return latest > 0 ? new Date(latest).toISOString() : base.lastUpdatedAt;
}

function resolveSessionJsonPath(sessionId: string, options: StorageOptions = {}): string {
  const active = activeSessionPaths.get(sessionId);
  if (active && existsSync(active)) return active;
  const matches = findSessionPathMatches(sessionId, options);
  if (matches.length === 1) return matches[0]!.path;
  if (matches.length > 1) throw new Error(`Session id "${sessionId}" is ambiguous: ${matches.map((match) => match.id).join(", ")}`);
  throw new Error(`Session not found: ${sessionId}`);
}

function findSessionPathMatches(idOrPrefix: string, options: StorageOptions): Array<{ id: string; path: string; scope: "project" | "global" }> {
  const needle = idOrPrefix.trim();
  if (!needle) return [];
  const dirs = sessionDirsForListing({ ...options, all: true });
  const candidates = dirs.flatMap(({ dir, scope }) => sessionJsonFiles(dir).map((path) => ({ id: basename(path, ".json"), path, scope })));
  return candidates.filter((candidate) => candidate.id === needle || candidate.id.startsWith(needle) || shortId(candidate.id).startsWith(needle));
}

function shortId(id: string): string {
  return id.split("-").at(-1) ?? id;
}

function readSessionSummaries(dir: string, scope: "project" | "global"): SessionSummary[] {
  return sessionJsonFiles(dir).flatMap((path) => {
    try {
      const session = readBaseSession(path);
      const { turns } = readTurnsFromJsonl(jsonlPathFor(path), path);
      const lastUpdatedAt = latestUpdatedAt(session, turns);
      const normalized: ChatSession = {
        ...session,
        turns,
        lastUpdatedAt,
        sessionStats: buildStats(session, turns, lastUpdatedAt),
        label: session.label || firstUserLabel(turns),
      };
      return [{
        id: normalized.id,
        createdAt: normalized.createdAt,
        lastUpdatedAt: normalized.lastUpdatedAt,
        cwd: normalized.cwd,
        provider: normalized.provider,
        model: normalized.model,
        label: normalized.label,
        turnCount: normalized.sessionStats.turnCount,
        path,
        scope,
      }];
    } catch {
      return [];
    }
  });
}

function sessionJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(dir, file));
}

function sessionDirsForListing(options: ListSessionsOptions): Array<{ dir: string; scope: "project" | "global" }> {
  if (options.global) return [{ dir: globalSessionsDir(options.homeDir), scope: "global" }];
  const dirs: Array<{ dir: string; scope: "project" | "global" }> = [];
  const cwd = defaultCwd(options.cwd);
  const projectTania = findProjectTaniaDir(cwd);
  if (projectTania) dirs.push({ dir: join(projectTania, "sessions"), scope: "project" });
  dirs.push({ dir: globalSessionsDir(options.homeDir), scope: "global" });
  return dirs;
}

function cwdMatches(sessionCwd: string, cwd: string): boolean {
  const fromSession = relative(resolve(sessionCwd), cwd);
  const fromCurrent = relative(cwd, resolve(sessionCwd));
  return fromSession === "" || (!fromSession.startsWith("..") && !parse(fromSession).root) ||
    fromCurrent === "" || (!fromCurrent.startsWith("..") && !parse(fromCurrent).root);
}
