import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";
import type { EffectiveRouteTable } from "../../router";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function table(): EffectiveRouteTable {
  return {
    version: 1,
    routes: [
      {
        match: "planning",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "qwen", model: "qwen3-coder-plus" },
        source: "built-in",
      },
      {
        match: "synthesis",
        provider: "deepseek",
        model: "deepseek-reasoner",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "built-in",
      },
    ],
    defaults: { provider: "openai", model: "gpt-4.1-mini" },
    defaultSource: "runtime-default",
    cascade: [{ provider: "openai", model: "gpt-4.1-mini", maxInputTokens: 128_000, source: "runtime-default" }],
    cascadeSource: "runtime-default",
    sources: ["built-in"],
  };
}

describe("/route command", () => {
  it("prints the effective route table", async () => {
    const output = new MemoryStream();
    await runCommand("/route", ctx(output, table()));

    const text = output.chunks.join("");
    expect(text).toContain("stepType | provider | model | fallback | source");
    expect(text).toContain("planning | deepseek | deepseek-chat | qwen/qwen3-coder-plus | built-in");
    expect(text).toContain("defaults | openai | gpt-4.1-mini");
  });

  it("shows the resolved route source for a step", async () => {
    const output = new MemoryStream();
    await runCommand("/route show synthesis", ctx(output, table()));

    expect(output.chunks.join("")).toContain("synthesis: deepseek/deepseek-reasoner (built-in;");
  });

  it("sets a session-scoped route patch and uses it for later show calls", async () => {
    const output = new MemoryStream();
    const routingTable = table();
    const context = ctx(output, routingTable);

    await runCommand("/route set synthesis qwen/qwen3-coder-plus", context);
    await runCommand("/route show synthesis", context);

    const text = output.chunks.join("");
    expect(text).toContain("Route synthesis set to qwen/qwen3-coder-plus for this session.");
    expect(text).toContain("synthesis: qwen/qwen3-coder-plus (session;");
    expect(context.routing?.enabled).toBe(true);
  });

  it("resets session route patches", async () => {
    const output = new MemoryStream();
    const routingTable = table();
    const context = ctx(output, routingTable);

    await runCommand("/route set planning groq/llama-3.3-70b-versatile", context);
    await runCommand("/route reset", context);
    await runCommand("/route show planning", context);

    const text = output.chunks.join("");
    expect(text).toContain("Session route patches cleared.");
    expect(text).toContain("planning: deepseek/deepseek-chat (built-in;");
  });

  it("prints usage for invalid subcommands", async () => {
    const output = new MemoryStream();
    await runCommand("/route set nope", ctx(output, table()));

    expect(output.chunks.join("")).toContain("Usage: /route set");
  });
});

function ctx(output: MemoryStream, routeTable: EffectiveRouteTable) {
  return {
    cwd: mkdtempSync(join(tmpdir(), "tanya-route-command-")),
    output: output as unknown as NodeJS.WritableStream,
    sink: () => {},
    routing: {
      enabled: false,
      table: routeTable,
      providerFactory: () => {
        throw new Error("not needed in /route tests");
      },
    },
  };
}
