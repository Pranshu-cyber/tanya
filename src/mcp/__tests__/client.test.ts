import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../agent/runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ToolCall } from "../../providers/types";
import { ToolRegistry } from "../../tools/registry";
import { loadMcpToolsForWorkspace, resetMcpClientManagerForTests, validateMcpToolOutputForTests } from "../client";

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

describe("MCP client", () => {
  afterEach(async () => {
    await resetMcpClientManagerForTests();
  });

  it("registers a mock MCP server tool and routes the result through the standard tool path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-client-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    const serverPath = writeMockServer(cwd);
    writeFileSync(join(cwd, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [{
        name: "mock",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
      }],
    }));

    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user") {
          expect(input.tools?.some((tool) => tool.function.name === "mcp:mock:ping")).toBe(true);
          yield { toolCalls: [toolCall("call-mcp", "mcp:mock:ping", {})] };
          return;
        }
        if (last?.role === "tool" && last.tool_call_id === "call-mcp") {
          yield { content: "MCP call finished." };
        }
      },
    };
    const events: TanyaEvent[] = [];

    const result = await runAgent({
      provider,
      prompt: "Call the MCP ping tool.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    expect(result.message).toContain("MCP call finished.");
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      id: "call-mcp",
      tool: "mcp:mock:ping",
      ok: true,
      output: "pong",
    }));
  });

  it("auto-restarts a crashed stdio server and increments the restart counter", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-restart-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    const marker = join(cwd, "already-crashed");
    const serverPath = writeMockServer(cwd, { marker });
    writeFileSync(join(cwd, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [{
        name: "flaky",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath, marker],
      }],
    }));

    const manager = await loadMcpToolsForWorkspace({
      cwd,
      registry: new ToolRegistry([]),
      sink: async () => {},
    });

    await waitFor(() => manager.statuses()[0]?.restarts === 1 && manager.statuses()[0]?.status === "connected");
    expect(manager.statuses()[0]).toMatchObject({
      name: "flaky",
      status: "connected",
      restarts: 1,
      toolNames: ["after_restart", "ping"],
    });
  });

  it("returns a structured tool error when an MCP call exceeds the configured timeout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-timeout-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    const serverPath = writeMockServer(cwd, { slow: true });
    writeFileSync(join(cwd, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [{
        name: "slow",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
      }],
    }));
    const previous = process.env.TANYA_MCP_CALL_TIMEOUT_MS;
    process.env.TANYA_MCP_CALL_TIMEOUT_MS = "50";
    try {
      const registry = new ToolRegistry([]);
      await loadMcpToolsForWorkspace({ cwd, registry, sink: async () => {} });
      const tool = registry.get("mcp:slow:slow");
      if (!tool) throw new Error("missing slow MCP tool");
      await expect(tool.run({}, { workspace: cwd })).resolves.toMatchObject({
        ok: false,
        summary: "MCP tool mcp:slow:slow failed.",
      });
    } finally {
      if (previous === undefined) delete process.env.TANYA_MCP_CALL_TIMEOUT_MS;
      else process.env.TANYA_MCP_CALL_TIMEOUT_MS = previous;
    }
  });

  it("rejects malformed MCP results against a declared output schema before model exposure", () => {
    expect(validateMcpToolOutputForTests(
      {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      {
        content: [{ type: "text", text: "bad" }],
        structuredContent: { answer: 42 },
      },
    )).toBe("$.structuredContent.answer expected string, got number");
  });
});

function writeMockServer(cwd: string, options: { marker?: string; slow?: boolean } = {}): string {
  const serverPath = join(cwd, "mock-mcp-server.mjs");
  const mcpServerUrl = pathToFileURL(resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdioUrl = pathToFileURL(resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  const lines = [
    `import { McpServer } from ${JSON.stringify(mcpServerUrl)};`,
    `import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};`,
    `import { existsSync, writeFileSync } from "node:fs";`,
    `const marker = process.argv[2];`,
    `const shouldCrash = marker && !existsSync(marker);`,
    `if (shouldCrash) writeFileSync(marker, "crashed once");`,
    `const server = new McpServer({ name: "mock-mcp", version: "1.0.0" });`,
    `server.registerTool("ping", { description: "Return pong." }, async () => ({ content: [{ type: "text", text: "pong" }] }));`,
    `if (marker && existsSync(marker)) server.registerTool("after_restart", { description: "Appears after restart." }, async () => ({ content: [{ type: "text", text: "fresh" }] }));`,
    ...(options.slow
      ? [`server.registerTool("slow", { description: "Return slowly." }, async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); return { content: [{ type: "text", text: "slow" }] }; });`]
      : []),
    `await server.connect(new StdioServerTransport());`,
  ];
  if (options.marker) lines.push(`if (shouldCrash) setTimeout(() => process.exit(23), 100);`);
  writeFileSync(serverPath, lines.join("\n"));
  return serverPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for predicate");
}
