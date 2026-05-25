import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ChatProvider } from "../../providers/types";
import { createTanyaMcpServer } from "../server";

describe("Tanya MCP server", () => {
  it("exposes verify, golden task search, run, and skills tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-server-"));
    mkdirSync(join(cwd, ".tanya", "memory"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "memory", "golden-tasks.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: "2026-05-16T12:00:00.000Z",
      signature: "task-alpha",
      task: { title: "alpha task", kind: "coding" },
      caller: null,
      outcome: "passed",
      changedFiles: [],
      artifactsRead: [],
      artifactsCreated: [],
      verificationCount: 0,
      toolErrors: 0,
      blockers: [],
      childRunIds: [],
      validation: null,
    })}\n`);

    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        yield { content: "MCP run finished." };
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTanyaMcpServer({
      defaultCwd: cwd,
      providerFactory: () => provider,
    });
    const client = new Client({ name: "mcp-test", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "tanya.golden_task_search",
        "tanya.run",
        "tanya.skills_list",
        "tanya.verify",
      ]);

      const verify = await client.callTool({ name: "tanya.verify", arguments: { path: cwd } });
      expect((verify as { structuredContent?: { verdict?: string } }).structuredContent?.verdict).toMatch(/passed|failed/);

      const search = await client.callTool({ name: "tanya.golden_task_search", arguments: { query: "alpha", limit: 5 } });
      expect(JSON.stringify((search as { structuredContent?: unknown }).structuredContent)).toContain("task-alpha");

      const run = await client.callTool({ name: "tanya.run", arguments: { prompt: "Say done", cwd, max_turns: 1 } });
      expect((run as { structuredContent?: { message?: string } }).structuredContent?.message).toBe("MCP run finished.");

      const recursive = await client.callTool({
        name: "tanya.run",
        arguments: { prompt: "loop", cwd, max_turns: 1 },
        _meta: { "tanya/mcp-depth": 2 },
      });
      expect((recursive as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify((recursive as { structuredContent?: unknown }).structuredContent)).toContain("recursive MCP loop");

      const skills = await client.callTool({ name: "tanya.skills_list", arguments: { cwd } });
      expect((skills as { structuredContent?: { skills?: unknown[] } }).structuredContent?.skills).toEqual(expect.any(Array));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
