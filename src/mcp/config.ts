import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type McpTransportKind = "stdio" | "sse" | "http";

export interface McpServerConfig {
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface McpConfig {
  version: 1;
  servers: McpServerConfig[];
}

export interface McpConfigIssue {
  file: string;
  path: string;
  message: string;
}

export interface LoadedMcpConfig {
  config: McpConfig;
  sources: string[];
  issues: McpConfigIssue[];
}

const EMPTY_CONFIG: McpConfig = { version: 1, servers: [] };
const TRANSPORTS = new Set<McpTransportKind>(["stdio", "sse", "http"]);

export function loadMcpConfig(options: { cwd: string; home?: string }): LoadedMcpConfig {
  const home = options.home ?? homedir();
  const userCurrent = join(home, ".tanya", "mcp.json");
  const userLegacy = join(home, ".tanya", "mcp.json");
  const userFile = existsSync(userCurrent) ? userCurrent : existsSync(userLegacy) ? userLegacy : null;
  const candidates = [
    ...(userFile ? [userFile] : []),
    join(options.cwd, ".tanya", "mcp.json"),
  ];

  let config = cloneConfig(EMPTY_CONFIG);
  const sources: string[] = [];
  const issues: McpConfigIssue[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseMcpConfig(readFileSync(file, "utf8"), file);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      continue;
    }
    config = mergeMcpConfig(config, parsed.config);
    sources.push(file);
  }

  return { config, sources, issues };
}

export function mergeMcpConfig(base: McpConfig, next: McpConfig): McpConfig {
  const byName = new Map<string, McpServerConfig>();
  for (const server of base.servers) byName.set(server.name, cloneServer(server));
  for (const server of next.servers) byName.set(server.name, cloneServer(server));
  const nextNames = new Set(next.servers.map((server) => server.name));
  return {
    version: 1,
    servers: [
      ...next.servers.map((server) => cloneServer(server)),
      ...base.servers.filter((server) => !nextNames.has(server.name)).map((server) => cloneServer(server)),
    ],
  };
}

export function parseMcpConfig(raw: string, file = "<memory>"): { ok: true; config: McpConfig } | { ok: false; issues: McpConfigIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ file, path: "$", message: `Invalid JSON: ${message}` }] };
  }
  return validateMcpConfig(parsed, file);
}

export function validateMcpConfig(input: unknown, file = "<memory>"): { ok: true; config: McpConfig } | { ok: false; issues: McpConfigIssue[] } {
  const issues: McpConfigIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ file, path: "$", message: "Expected an object." }] };
  }
  if (input.version !== 1) {
    issues.push({ file, path: "$.version", message: "Expected schema version 1." });
  }
  if (!Array.isArray(input.servers)) {
    issues.push({ file, path: "$.servers", message: "Expected an array." });
  }
  const servers = Array.isArray(input.servers)
    ? input.servers.flatMap((server, index) => validateServer(server, `$.servers[${index}]`, file, issues))
    : [];
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: { version: 1, servers } };
}

function validateServer(input: unknown, path: string, file: string, issues: McpConfigIssue[]): McpServerConfig[] {
  if (!isRecord(input)) {
    issues.push({ file, path, message: "Expected an object." });
    return [];
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) issues.push({ file, path: `${path}.name`, message: "Expected a non-empty server name." });
  if (name && !/^[A-Za-z0-9_.-]+$/.test(name)) {
    issues.push({ file, path: `${path}.name`, message: "Server names may contain letters, numbers, '.', '_' and '-'." });
  }
  const transport = typeof input.transport === "string" && TRANSPORTS.has(input.transport as McpTransportKind)
    ? input.transport as McpTransportKind
    : null;
  if (!transport) issues.push({ file, path: `${path}.transport`, message: "Expected stdio, sse, or http." });
  if (transport === "stdio" && (typeof input.command !== "string" || input.command.trim() === "")) {
    issues.push({ file, path: `${path}.command`, message: "stdio servers require command." });
  }
  if ((transport === "sse" || transport === "http") && (typeof input.url !== "string" || input.url.trim() === "")) {
    issues.push({ file, path: `${path}.url`, message: `${transport} servers require url.` });
  }
  const args = input.args === undefined ? undefined : stringArray(input.args, `${path}.args`, file, issues);
  const env = input.env === undefined ? undefined : stringRecord(input.env, `${path}.env`, file, issues);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    issues.push({ file, path: `${path}.enabled`, message: "Expected boolean when present." });
  }
  if (!name || !transport) return [];
  return [{
    name,
    transport,
    ...(typeof input.command === "string" && input.command.trim() ? { command: input.command.trim() } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof input.url === "string" && input.url.trim() ? { url: input.url.trim() } : {}),
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
  }];
}

function stringArray(input: unknown, path: string, file: string, issues: McpConfigIssue[]): string[] {
  if (!Array.isArray(input)) {
    issues.push({ file, path, message: "Expected an array of strings." });
    return [];
  }
  return input.flatMap((item, index) => {
    if (typeof item === "string") return [item];
    issues.push({ file, path: `${path}[${index}]`, message: "Expected a string." });
    return [];
  });
}

function stringRecord(input: unknown, path: string, file: string, issues: McpConfigIssue[]): Record<string, string> {
  if (!isRecord(input)) {
    issues.push({ file, path, message: "Expected an object with string values." });
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      output[key] = value;
    } else {
      issues.push({ file, path: `${path}.${key}`, message: "Expected a string." });
    }
  }
  return output;
}

function cloneConfig(config: McpConfig): McpConfig {
  return { version: 1, servers: config.servers.map((server) => cloneServer(server)) };
}

function cloneServer(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
