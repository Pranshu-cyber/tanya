import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInRouteTable } from "../defaults";
import { loadRouteTable, parseRoutesJson, resolveRoute, validateRouteTable } from "../load";

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
      ]));
    }
  });
});

describe("route loading and resolution", () => {
  it("loads project routes before user routes before built-ins", () => {
    const home = mkdtempSync(join(tmpdir(), "tanya-routes-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-routes-cwd-"));
    mkdirSync(join(home, ".tanya"), { recursive: true });
    mkdirSync(join(cwd, ".tania"), { recursive: true });
    writeFileSync(join(home, ".tanya", "routes.json"), JSON.stringify({
      version: 1,
      routes: [
        { match: "planning", provider: "qwen", model: "qwen3-coder-plus" },
        { match: "synthesis", provider: "openai", model: "gpt-4.1-mini" },
      ],
      defaults: { provider: "openai", model: "gpt-4.1-mini" },
    }));
    writeFileSync(join(cwd, ".tania", "routes.json"), JSON.stringify({
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

  it("resolves regex matches against supplied route text", () => {
    const table = builtInRouteTable(runtimeDefault);
    const effective = {
      version: 1 as const,
      routes: [{ match: { regex: "validate_" }, provider: "deepseek", model: "deepseek-reasoner", source: "project" as const }],
      defaults: table.defaults,
      defaultSource: "runtime-default" as const,
      sources: ["test"],
    };

    expect(resolveRoute("unknown", effective, "validate_schema")).toMatchObject({
      provider: "deepseek",
      model: "deepseek-reasoner",
      source: "project",
    });
  });
});
