import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../agent/runner";
import { readAuditDecisions } from "../../memory/auditLog";
import type { ChatProvider, ToolCall } from "../../providers/types";
import { resetMcpClientManagerForTests } from "../client";

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

describe("MCP permission integration", () => {
  afterEach(async () => {
    await resetMcpClientManagerForTests();
  });

  it("denies MCP tools via mcp:<server>:* rules and records the MCP audit source", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-permissions-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    const serverPath = writeMockServer(cwd);
    writeFileSync(join(cwd, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [{ name: "github", transport: "stdio", command: process.execPath, args: [serverPath] }],
    }));
    writeFileSync(join(cwd, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "default",
      alwaysDeny: ["mcp:github:.*"],
    }));
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user") {
          yield { toolCalls: [toolCall("call-github", "mcp:github:ping", {})] };
          return;
        }
        yield { content: "done" };
      },
    };

    await runAgent({
      provider,
      prompt: "Call GitHub MCP.",
      cwd,
      sink: async () => {},
      maxTurns: 2,
    });

    const audit = readAuditDecisions(cwd, { limit: 5 });
    expect(audit).toContainEqual(expect.objectContaining({
      tool: "mcp:github:ping",
      decision: "deny",
      matchedRule: "mcp:github:.*",
      source: "mcp:github",
    }));
  });

  it("rejects invented MCP tools that are not loaded from mcp.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-unknown-"));
    const events: Array<{ type: string; summary?: string; error?: string }> = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user") {
          yield { toolCalls: [toolCall("call-invented", "mcp:unknown:danger", {})] };
          return;
        }
        yield { content: "done" };
      },
    };

    await runAgent({
      provider,
      prompt: "Call an invented MCP tool.",
      cwd,
      sink: async (event) => {
        if (event.type === "tool_result") events.push(event);
      },
      maxTurns: 2,
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      summary: "MCP tool is not configured or allowlisted: mcp:unknown:danger",
    }));
  });
});

function writeMockServer(cwd: string): string {
  const serverPath = join(cwd, "mock-mcp-server.mjs");
  const mcpServerUrl = pathToFileURL(resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdioUrl = pathToFileURL(resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  writeFileSync(serverPath, [
    `import { McpServer } from ${JSON.stringify(mcpServerUrl)};`,
    `import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};`,
    `const server = new McpServer({ name: "mock-mcp", version: "1.0.0" });`,
    `server.registerTool("ping", { description: "Return pong." }, async () => ({ content: [{ type: "text", text: "pong" }] }));`,
    `await server.connect(new StdioServerTransport());`,
  ].join("\n"));
  return serverPath;
}
