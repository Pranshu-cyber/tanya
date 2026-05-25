import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../index";
import { resetMcpClientManagerForTests } from "../../mcp/client";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/mcp command", () => {
  afterEach(async () => {
    await resetMcpClientManagerForTests();
  });

  it("lists connected servers and their tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-command-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    const serverPath = writeMockServer(cwd);
    writeFileSync(join(cwd, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [{ name: "mock", transport: "stdio", command: process.execPath, args: [serverPath] }],
    }));
    const output = new MemoryStream();

    await expect(runCommand("/mcp", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: async () => {},
    })).resolves.toBe(true);

    expect(output.chunks.join("")).toContain("mock  connected  stdio");
    expect(output.chunks.join("")).toContain("tools=ping");
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
