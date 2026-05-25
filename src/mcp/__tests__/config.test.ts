import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig, parseMcpConfig } from "../config";

describe("MCP config", () => {
  it("validates schema issues with JSON pointer paths", () => {
    const parsed = parseMcpConfig(JSON.stringify({
      version: 1,
      servers: [{ name: "bad", transport: "stdio" }],
    }), "mcp.json");

    expect(parsed).toMatchObject({
      ok: false,
      issues: [{ file: "mcp.json", path: "$.servers[0].command" }],
    });
  });

  it("loads user config and project overrides with project servers first", () => {
    const home = mkdtempSync(join(tmpdir(), "tanya-mcp-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-mcp-cwd-"));
    mkdirSync(join(home, ".tanya"), { recursive: true });
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(home, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [
        { name: "shared", transport: "stdio", command: "user-shared" },
        { name: "user-only", transport: "stdio", command: "user-only" },
      ],
    }));
    writeFileSync(join(cwd, ".tanya", "mcp.json"), JSON.stringify({
      version: 1,
      servers: [
        { name: "shared", transport: "stdio", command: "project-shared" },
        { name: "project-only", transport: "stdio", command: "project-only" },
      ],
    }));

    const loaded = loadMcpConfig({ cwd, home });

    expect(loaded.issues).toEqual([]);
    expect(loaded.config.servers.map((server) => [server.name, server.command])).toEqual([
      ["shared", "project-shared"],
      ["project-only", "project-only"],
      ["user-only", "user-only"],
    ]);
  });
});
