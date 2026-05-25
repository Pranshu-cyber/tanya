import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EventSink } from "../events/types";
import type { ToolDefinition } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import type { TanyaTool, ToolContext, ToolResult } from "../tools/types";
import { numberEnvValue } from "../config/envCompat";
import { runIdDepth } from "../agent/subAgentContext";
import { loadMcpConfig, type LoadedMcpConfig, type McpServerConfig } from "./config";

export type McpConnectionStatus = "connected" | "disconnected" | "restarting" | "failed";

export interface McpServerStatus {
  name: string;
  transport: McpServerConfig["transport"];
  status: McpConnectionStatus;
  toolNames: string[];
  error?: string;
  restarts: number;
}

type ManagedServer = {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  status: McpConnectionStatus;
  tools: Tool[];
  restarts: number;
  error?: string;
  heartbeat?: ReturnType<typeof setInterval>;
};

export class McpClientManager {
  private readonly servers = new Map<string, ManagedServer>();

  constructor(
    private readonly workspace: string,
    private readonly loadedConfig: LoadedMcpConfig,
    private readonly sink?: EventSink,
  ) {}

  get configSources(): string[] {
    return this.loadedConfig.sources;
  }

  get configIssues() {
    return this.loadedConfig.issues;
  }

  async connectAll(): Promise<void> {
    for (const server of this.loadedConfig.config.servers) {
      if (server.enabled === false) continue;
      await this.connectServer(server, this.servers.get(server.name)?.restarts ?? 0);
    }
  }

  registerTools(registry: ToolRegistry): void {
    for (const server of this.servers.values()) {
      for (const tool of server.tools) {
        registry.register(this.toTanyaTool(server, tool));
      }
    }
  }

  statuses(): McpServerStatus[] {
    return [...this.servers.values()]
      .map((server) => ({
        name: server.config.name,
        transport: server.config.transport,
        status: server.status,
        toolNames: server.tools.map((tool) => tool.name).sort(),
        restarts: server.restarts,
        ...(server.error ? { error: server.error } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map(async (server) => {
      server.status = "disconnected";
      try {
        if (server.heartbeat) clearInterval(server.heartbeat);
        await server.transport.close();
      } catch {
        // Best effort shutdown; the process is ending or tests are cleaning up.
      }
    }));
    this.servers.clear();
  }

  async restartServer(name: string): Promise<void> {
    const existing = this.servers.get(name);
    if (!existing) throw new Error(`MCP server not found: ${name}`);
    await this.handleServerClose(name);
  }

  private async connectServer(config: McpServerConfig, restarts: number): Promise<void> {
    const client = new Client({ name: "tanya", version: "0.10.0-beta.0" }, { capabilities: {} });
    const transport = this.createTransport(config);
    const managed: ManagedServer = {
      config,
      client,
      transport,
      status: "disconnected",
      tools: [],
      restarts,
    };
    this.servers.set(config.name, managed);
    client.onclose = () => {
      void this.handleServerClose(config.name).catch(() => {});
    };
    client.onerror = (error) => {
      const current = this.servers.get(config.name);
      if (current) current.error = error.message;
    };
    try {
      await client.connect(transport);
      const listed = await client.listTools(undefined, { timeout: mcpCallTimeoutMs() });
      managed.tools = listed.tools;
      managed.status = "connected";
      managed.heartbeat = setInterval(() => {
        void client.ping({ timeout: 5_000 }).catch((error) => {
          managed.error = error instanceof Error ? error.message : String(error);
          void this.handleServerClose(config.name).catch(() => {});
        });
      }, 30_000);
      managed.heartbeat.unref?.();
    } catch (error) {
      managed.status = "failed";
      managed.error = error instanceof Error ? error.message : String(error);
      await this.sink?.({ type: "status", message: `MCP server ${config.name} failed to connect: ${managed.error}` });
    }
  }

  private async handleServerClose(name: string): Promise<void> {
    const current = this.servers.get(name);
    if (!current || current.status === "disconnected") return;
    if (current.restarts >= 3) {
      current.status = "failed";
      current.error = "server exited after 3 restart attempts";
      await this.sink?.({ type: "status", message: `MCP server ${name} failed after 3 restart attempts.` });
      return;
    }
    const restarts = current.restarts + 1;
    current.status = "restarting";
    current.restarts = restarts;
    await this.sink?.({ type: "status", message: `MCP server ${name} exited; restarting (${restarts}/3).` });
    await sleep(Math.min(500 * 2 ** (restarts - 1), 4_000));
    await this.connectServer(current.config, restarts);
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.transport === "stdio") {
      const logPath = mcpLogPath(this.workspace, config.name);
      mkdirSync(join(this.workspace, ".tanya", "mcp", "logs"), { recursive: true });
      rotateMcpLogIfNeeded(logPath);
      const transport = new StdioClientTransport({
        command: config.command ?? "",
        args: config.args ?? [],
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
        stderr: "pipe",
      });
      const stderr = transport.stderr;
      if (stderr) stderr.pipe(createWriteStream(logPath, { flags: "a" }));
      return transport;
    }
    if (!config.url) throw new Error(`MCP server ${config.name} requires url.`);
    const url = new URL(config.url);
    return config.transport === "sse"
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url) as unknown as Transport;
  }

  private toTanyaTool(server: ManagedServer, tool: Tool): TanyaTool {
    const mcpToolName = tool.name;
    const name = `mcp:${server.config.name}:${mcpToolName}`;
    return {
      name,
      description: `[MCP ${server.config.name}] ${tool.description ?? mcpToolName}`,
      definition: {
        type: "function",
        function: {
          name,
          description: `[MCP ${server.config.name}] ${tool.description ?? mcpToolName}`,
          parameters: toToolParameters(tool.inputSchema),
        },
      },
      keepFullForVerifier: true,
      async run(input: unknown, _context: ToolContext): Promise<ToolResult> {
        try {
          const result = await server.client.callTool(
            {
              name: mcpToolName,
              arguments: isRecord(input) ? input : {},
              _meta: {
                "tanya/mcp-depth": runIdDepth(_context.runId ?? ""),
              },
            },
            undefined,
            { timeout: mcpCallTimeoutMs() },
          );
          const schemaViolation = validateMcpToolOutput(tool.outputSchema, result);
          if (schemaViolation) {
            return {
              ok: false,
              summary: `mcp schema violation: ${schemaViolation}`,
              error: `mcp schema violation: ${schemaViolation}`,
              output: { ok: false, error: `mcp schema violation: ${schemaViolation}` },
            };
          }
          return mcpResultToToolResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            summary: `MCP tool ${name} failed.`,
            error: message,
            output: { ok: false, error: message },
          };
        }
      },
    };
  }
}

let activeManager: { workspace: string; manager: McpClientManager } | null = null;

export async function loadMcpToolsForWorkspace(options: {
  cwd: string;
  registry: ToolRegistry;
  sink?: EventSink;
  home?: string;
}): Promise<McpClientManager> {
  if (activeManager?.workspace === options.cwd) {
    activeManager.manager.registerTools(options.registry);
    return activeManager.manager;
  }
  if (activeManager) await activeManager.manager.closeAll();
  const manager = new McpClientManager(options.cwd, loadMcpConfig({ cwd: options.cwd, ...(options.home ? { home: options.home } : {}) }), options.sink);
  await manager.connectAll();
  manager.registerTools(options.registry);
  activeManager = { workspace: options.cwd, manager };
  return manager;
}

export function getActiveMcpManager(): McpClientManager | null {
  return activeManager?.manager ?? null;
}

export async function resetMcpClientManagerForTests(): Promise<void> {
  if (activeManager) await activeManager.manager.closeAll();
  activeManager = null;
}

function toToolParameters(inputSchema: Tool["inputSchema"]): ToolDefinition["function"]["parameters"] {
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((item): item is string => typeof item === "string")
    : undefined;
  const additional = typeof inputSchema.additionalProperties === "boolean" ? inputSchema.additionalProperties : undefined;
  return {
    type: "object",
    properties,
    ...(required ? { required } : {}),
    ...(additional !== undefined ? { additionalProperties: additional } : {}),
  };
}

function mcpResultToToolResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolResult {
  if ("toolResult" in result) {
    return {
      ok: true,
      summary: "MCP tool returned a compatibility result.",
      output: result.toolResult,
    };
  }
  const output = callToolResultOutput(result);
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return {
    ok: result.isError !== true,
    summary: result.isError === true
      ? `MCP tool returned an error: ${text.slice(0, 200)}`
      : `MCP tool returned ${result.content.length} content item${result.content.length === 1 ? "" : "s"}.`,
    output,
    ...(result.isError === true ? { error: text.slice(0, 2_000) } : {}),
  };
}

function callToolResultOutput(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const textParts = result.content.flatMap((item) => {
    if (item.type === "text") return [item.text];
    if (item.type === "resource" && "text" in item.resource) return [item.resource.text];
    if (item.type === "image") return [`[image:${item.mimeType}; ${item.data.length} base64 chars]`];
    if (item.type === "audio") return [`[audio:${item.mimeType}; ${item.data.length} base64 chars]`];
    if (item.type === "resource_link") return [`[resource:${item.uri}]`];
    return [];
  });
  return textParts.length === 1 ? textParts[0] : textParts;
}

function validateMcpToolOutput(outputSchema: Tool["outputSchema"], result: Awaited<ReturnType<Client["callTool"]>>): string | null {
  if (!outputSchema) return null;
  if ("toolResult" in result) return null;
  if (!result.structuredContent) return "missing structuredContent for declared output schema";
  if (!isRecord(result.structuredContent)) return "structuredContent must be an object";
  return validateObjectSchema(outputSchema, result.structuredContent, "$.structuredContent");
}

function validateObjectSchema(schema: Tool["outputSchema"], value: Record<string, unknown>, path: string): string | null {
  for (const key of schema?.required ?? []) {
    if (!(key in value)) return `${path}.${key} is required`;
  }
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value) || !isRecord(propertySchema)) continue;
    const expected = typeof propertySchema.type === "string" ? propertySchema.type : "";
    if (!expected) continue;
    const actual = Array.isArray(value[key]) ? "array" : typeof value[key];
    if (actual !== expected) return `${path}.${key} expected ${expected}, got ${actual}`;
  }
  return null;
}

function mcpCallTimeoutMs(): number {
  return Math.max(1_000, numberEnvValue(process.env, "TANYA_MCP_CALL_TIMEOUT_MS", 30_000));
}

function mcpLogPath(workspace: string, serverName: string): string {
  return join(workspace, ".tanya", "mcp", "logs", `${serverName}.log`);
}

function rotateMcpLogIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (statSync(path).size < 10 * 1024 * 1024) return;
    const rotated = `${path}.1`;
    try {
      if (existsSync(rotated)) unlinkSync(rotated);
    } catch {
      // Ignore stale rotated log cleanup failures.
    }
    renameSync(path, rotated);
  } catch {
    // Log rotation is best-effort; a bad log file must not block startup.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const validateMcpToolOutputForTests = validateMcpToolOutput;
