import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInRouteTable } from "../defaults";
import { loadRouteTable, parseRoutesJson, resolveRoute, validateRouteTable } from "../load";
import { resolveRouteWithContextGuard } from "../resolve";
import type { EffectiveRouteTable } from "../types";

const runtimeDefault = { provider: "openai", model: "gpt-4.1-mini" };

describe("route table schema", () => {
  it("validates a route table with step and regex matches", () => {
    const result = validateRouteTable({
      version: 1,
      routes: [
        { match: "planning", provider: "deepseek", model: "deepseek-chat", reasoningCap: { maxTokens: 2000 } },
        { match: { regex: "verify|finalize" }, provider: "deepseek", model: "deepseek-reasoner", escalate: false },
      ],
      defaults: runtimeDefault,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routes).toHaveLength(2);
      expect(result.value.routes[0]?.reasoningCap).toEqual({ maxTokens: 2000 });
      expect(result.value.routes[1]?.escalate).toBe(false);
    }
  });

  it("rejects malformed configs with path-specific issues", () => {
    const result = parseRoutesJson(JSON.stringify({
      version: 2,
      routes: [
        { match: "bad-step", provider: "", model: "x", fallback: { provider: "openai" } },
        { match: { regex: "[" }, provider: "openai", model: "gpt" },
        { match: "planning", provider: "openai", model: "gpt", escalate: "yes", reasoningCap: { maxTokens: 0 } },
      ],
      defaults: { provider: "openai" },
      cascade: [{ cli: "deepseek", model: "deepseek-chat", max_input_tokens: 0 }],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "$.version",
        "$.routes[0].match",
        "$.routes[0].provider",
        "$.routes[0].fallback.model",
        "$.routes[1].match.regex",
        "$.routes[2].escalate",
        "$.routes[2].reasoningCap.maxTokens",
        "$.defaults.model",
        "$.cascade[0].maxInputTokens",
      ]));
    }
  });

  it("accepts legacy default_model as a one-entry route cascade", () => {
    const result = validateRouteTable({
      version: 1,
      routes: [],
      default_model: "deepseek-chat",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defaults).toEqual({ provider: "deepseek", model: "deepseek-chat" });
      expect(result.value.cascade).toBeUndefined();
    }
  });
});

describe("route loading and resolution", () => {
  it("loads project routes before user routes before built-ins", () => {
    const home = mkdtempSync(join(tmpdir(), "tanya-routes-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-routes-cwd-"));
    mkdirSync(join(home, ".tanya"), { recursive: true });
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(home, ".tanya", "routes.json"), JSON.stringify({
      version: 1,
      routes: [
        { match: "planning", provider: "qwen", model: "qwen3-coder-plus" },
        { match: "synthesis", provider: "openai", model: "gpt-4.1-mini" },
      ],
      defaults: { provider: "openai", model: "gpt-4.1-mini" },
    }));
    writeFileSync(join(cwd, ".tanya", "routes.json"), JSON.stringify({
      version: 1,
      routes: [
        { match: "planning", provider: "groq", model: "llama-3.3-70b-versatile" },
      ],
      defaults: { provider: "deepseek", model: "deepseek-chat" },
    }));

    const loaded = loadRouteTable({ cwd, home, defaults: runtimeDefault });

    expect(loaded.issues).toEqual([]);
    expect(loaded.table.routes.slice(0, 3).map((route) => `${route.source}:${route.provider}/${route.model}`)).toEqual([
      "project:groq/llama-3.3-70b-versatile",
      "user:qwen/qwen3-coder-plus",
      "user:openai/gpt-4.1-mini",
    ]);
    expect(resolveRoute("planning", loaded.table)).toMatchObject({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      source: "project",
    });
    expect(resolveRoute("synthesis", loaded.table)).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "user",
    });
  });

  it("falls through to built-in routes and runtime defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "tanya-routes-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-routes-cwd-"));
    const loaded = loadRouteTable({ cwd, home, defaults: { provider: "custom", model: "local-model" } });

    expect(resolveRoute("tool_call", loaded.table)).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      source: "built-in",
    });
    expect(resolveRoute("unknown", loaded.table)).toMatchObject({
      provider: "custom",
      model: "local-model",
      source: "runtime-default",
    });
  });

  it("loads legacy default_model configs as a one-entry cascade", () => {
    const home = mkdtempSync(join(tmpdir(), "tanya-routes-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-routes-cwd-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "routes.json"), JSON.stringify({
      version: 1,
      routes: [],
      default_model: "deepseek-chat",
    }));

    const loaded = loadRouteTable({ cwd, home, defaults: runtimeDefault });

    expect(loaded.issues).toEqual([]);
    expect(loaded.table.defaults).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(loaded.table.cascade).toEqual([
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" },
    ]);
  });

  it("resolves regex matches against supplied route text", () => {
    const table = builtInRouteTable(runtimeDefault);
    const effective = {
      version: 1 as const,
      routes: [{ match: { regex: "validate_" }, provider: "deepseek", model: "deepseek-reasoner", source: "project" as const }],
      defaults: table.defaults,
      defaultSource: "runtime-default" as const,
      cascade: [{ provider: "openai", model: "gpt-4.1-mini", maxInputTokens: 128_000, source: "runtime-default" as const }],
      cascadeSource: "runtime-default" as const,
      sources: ["test"],
    } satisfies EffectiveRouteTable;

    expect(resolveRoute("unknown", effective, "validate_schema")).toMatchObject({
      provider: "deepseek",
      model: "deepseek-reasoner",
      source: "project",
    });
  });

  it("blocks deepseek-chat for unknown turns that look like code-editing tasks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-route-code-guard-"));
    writeFileSync(join(cwd, "go.mod"), "module example.com/app\n");
    const effective = {
      version: 1 as const,
      routes: [{
        match: "unknown" as const,
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "deepseek", model: "deepseek-reasoner" },
        source: "project" as const,
      }],
      defaults: { provider: "deepseek", model: "deepseek-chat" },
      defaultSource: "runtime-default" as const,
      cascade: [{ provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "runtime-default" as const }],
      cascadeSource: "runtime-default" as const,
      sources: ["test"],
    } satisfies EffectiveRouteTable;

    expect(resolveRouteWithContextGuard({
      stepType: "unknown",
      table: effective,
      messages: [{ role: "assistant", content: "I will inspect the repo." }],
      cwd,
      prompt: "Update the existing Go API implementation.\n".repeat(80),
    })).toMatchObject({
      provider: "deepseek",
      model: "deepseek-reasoner",
      reason: expect.stringContaining("declined deepseek-chat for code-editing task"),
    });
  });

  it("selects a later cascade route when the first route cannot fit the estimated prompt", () => {
    const effective = cascadeTable([
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" as const },
      { provider: "claude", model: "claude-sonnet-4-6", maxInputTokens: 1_000_000, source: "project" as const },
    ]);

    const route = resolveRouteWithContextGuard({
      stepType: "tool_call",
      table: effective,
      messages: [{ role: "user", content: "x".repeat(800_000) }],
    });

    expect(route).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-6",
      cascade: expect.objectContaining({
        reason: "cascade-fit",
        estimatedTokens: expect.any(Number),
        selectedIndex: 1,
      }),
    });
  });

  it("keeps the first cascade route when it fits", () => {
    const effective = cascadeTable([
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" as const },
      { provider: "claude", model: "claude-sonnet-4-6", maxInputTokens: 1_000_000, source: "project" as const },
    ]);

    const route = resolveRouteWithContextGuard({
      stepType: "tool_call",
      table: effective,
      messages: [{ role: "user", content: "x".repeat(200_000) }],
    });

    expect(route).toMatchObject({ provider: "deepseek", model: "deepseek-chat" });
    expect(route.cascade).toBeUndefined();
  });

  it("reports the highest configured route when no cascade entry can fit", () => {
    const effective = cascadeTable([
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" as const },
    ]);

    expect(() => resolveRouteWithContextGuard({
      stepType: "tool_call",
      table: effective,
      messages: [{ role: "user", content: "x".repeat(800_000) }],
    })).toThrow(/deepseek\/deepseek-chat.*128,000 tokens × 0\.85 safety = 108,800/);
  });

  it("does not cascade when a forced route cannot fit", () => {
    const effective = cascadeTable([
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" as const },
      { provider: "claude", model: "claude-sonnet-4-6", maxInputTokens: 1_000_000, source: "project" as const },
    ]);

    expect(() => resolveRouteWithContextGuard({
      stepType: "tool_call",
      table: effective,
      messages: [{ role: "user", content: "x".repeat(800_000) }],
      forcedRoute: { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000 },
    })).toThrow(/Forced route deepseek\/deepseek-chat cannot fit estimated/);
  });
});

function cascadeTable(cascade: EffectiveRouteTable["cascade"]): EffectiveRouteTable {
  return {
    version: 1,
    routes: [],
    defaults: { provider: "deepseek", model: "deepseek-chat" },
    defaultSource: "runtime-default",
    cascade,
    cascadeSource: "project",
    sources: ["test"],
  };
}
