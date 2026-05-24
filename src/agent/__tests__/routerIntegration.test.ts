import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";
import type { EffectiveRouteTable, RouteTarget } from "../../router";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function table(routes: EffectiveRouteTable["routes"], defaults: RouteTarget = { provider: "openai", model: "gpt-4.1-mini" }): EffectiveRouteTable {
  return {
    version: 1,
    routes,
    defaults,
    defaultSource: "runtime-default",
    cascade: [{ ...defaults, maxInputTokens: defaults.maxInputTokens ?? 128_000, source: "runtime-default" }],
    cascadeSource: "runtime-default",
    sources: ["test"],
  };
}

function routedProvider(target: RouteTarget, handler: (target: RouteTarget, input: ChatRequest) => AsyncGenerator<unknown>): ChatProvider {
  return {
    id: target.provider,
    model: target.model,
    contextWindow: target.provider === "together" ? 32_000 : 128_000,
    async *streamChat(input) {
      for await (const delta of handler(target, input)) {
        yield delta as never;
      }
    },
  };
}

describe("runner router integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits cascade-fit telemetry when token-fit selection uses a non-first route", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-cascade-telemetry-"));
    const events: TanyaEvent[] = [];
    const calls: string[] = [];
    const routes = table([], { provider: "deepseek", model: "deepseek-chat" });
    routes.cascade = [
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" },
      { provider: "claude", model: "claude-sonnet-4-6", maxInputTokens: 1_000_000, source: "project" },
    ];
    const prompt = "x".repeat(800_000);

    await runAgent({
      provider: routedProvider({ provider: "deepseek", model: "deepseek-chat" }, async function* () {
        yield { content: "unused" };
      }),
      prompt,
      cwd,
      sink: (event) => { events.push(event); },
      maxTurns: 1,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          yield { content: "Fits large prompt." };
        }),
      },
    });

    expect(calls).toEqual(["claude/claude-sonnet-4-6"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_routed",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reason: expect.stringContaining("cascade-fit"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "provider.raw",
      provider: "claude",
      model: "claude-sonnet-4-6",
      event: expect.objectContaining({
        type: "model_routed",
        reason: "cascade-fit",
        estimated_tokens: expect.any(Number),
        attempted_routes: expect.arrayContaining([
          expect.objectContaining({ provider: "deepseek", model: "deepseek-chat" }),
          expect.objectContaining({ provider: "claude", model: "claude-sonnet-4-6" }),
        ]),
      }),
    }));
  });

  it("does not emit cascade-fit telemetry when the first route fits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-cascade-first-"));
    const events: TanyaEvent[] = [];
    const routes = table([], { provider: "deepseek", model: "deepseek-chat" });
    routes.cascade = [
      { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000, source: "project" },
      { provider: "claude", model: "claude-sonnet-4-6", maxInputTokens: 1_000_000, source: "project" },
    ];

    await runAgent({
      provider: routedProvider({ provider: "deepseek", model: "deepseek-chat" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "x".repeat(200_000),
      cwd,
      sink: (event) => { events.push(event); },
      maxTurns: 1,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* () {
          yield { content: "Fits first route." };
        }),
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "model_routed",
      provider: "deepseek",
      model: "deepseek-chat",
    }));
    expect(events.some((event) => event.type === "provider.raw")).toBe(false);
  });

  it("routes planning and tool-call turns through the effective route table", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-integration-"));
    writeFileSync(join(cwd, "package.json"), "{}");
    const events: TanyaEvent[] = [];
    const calls: string[] = [];
    const routes = table([
      { match: "planning", provider: "deepseek", model: "deepseek-chat", source: "project" },
      { match: "tool_call", provider: "groq", model: "llama-3.3-70b-versatile", source: "project" },
    ]);

    await runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Read package.json.",
      cwd,
      sink: (event) => { events.push(event); },
      maxTurns: 2,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          if (calls.length === 1) {
            yield { toolCalls: [toolCall("call-read", "read_file", { path: "package.json" })] };
            return;
          }
          yield { content: "Done." };
        }),
      },
    });

    expect(calls).toEqual([
      "deepseek/deepseek-chat",
      "groq/llama-3.3-70b-versatile",
    ]);
    expect(events.filter((event) => event.type === "model_routed")).toEqual([
      expect.objectContaining({ type: "model_routed", stepType: "planning", provider: "deepseek", model: "deepseek-chat" }),
      expect.objectContaining({ type: "model_routed", stepType: "tool_call", provider: "groq", model: "llama-3.3-70b-versatile", cacheImpact: "miss" }),
    ]);
  });

  it("falls back to the route fallback after a provider failure before progress", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-fallback-"));
    const events: TanyaEvent[] = [];
    const calls: string[] = [];
    const routes = table([
      {
        match: "planning",
        provider: "qwen",
        model: "qwen3-coder-plus",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "project",
      },
    ]);

    const result = await runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Say hi.",
      cwd,
      sink: (event) => { events.push(event); },
      maxTurns: 1,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          if (routeTarget.provider === "qwen") throw new Error("fetch failed");
          yield { content: "Recovered." };
        }),
      },
    });

    expect(result.message).toContain("Recovered.");
    expect(calls).toEqual([
      "qwen/qwen3-coder-plus",
      "qwen/qwen3-coder-plus",
      "openai/gpt-4.1-mini",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_routed",
      provider: "openai",
      model: "gpt-4.1-mini",
      reason: expect.stringContaining("fallback after provider error"),
    }));
  });

  it("declines a route whose context window is too small", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-context-"));
    const calls: string[] = [];
    const events: TanyaEvent[] = [];
    const routes = table([
      {
        match: "planning",
        provider: "together",
        model: "small-window",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "project",
      },
    ]);
    const longHistory = "x".repeat(140_000);

    await runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Continue.",
      cwd,
      history: [{ role: "assistant", content: longHistory }],
      sink: (event) => { events.push(event); },
      maxTurns: 1,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          yield { content: "Fits fallback." };
        }),
      },
    });

    expect(calls).toEqual(["openai/gpt-4.1-mini"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_routed",
      provider: "openai",
      model: "gpt-4.1-mini",
      reason: expect.stringContaining("context-window guard"),
    }));
  });

  it("uses preferred model metadata for verifier-style tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-preferred-"));
    writeFileSync(join(cwd, "schema.prisma"), "model User {\n  id String @id\n}\n");
    const events: TanyaEvent[] = [];
    const calls: string[] = [];
    const routes = table([
      { match: "planning", provider: "deepseek", model: "deepseek-chat", source: "project" },
      { match: "tool_call", provider: "groq", model: "llama-3.3-70b-versatile", source: "project" },
    ]);

    await runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Validate the Prisma schema.",
      cwd,
      sink: (event) => { events.push(event); },
      maxTurns: 2,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          if (calls.length === 1) {
            yield { toolCalls: [toolCall("call-validate", "validate_prisma_schema", { schemaPath: "schema.prisma", requiredModels: ["User"] })] };
            return;
          }
          yield { content: "Validation complete." };
        }),
      },
    });

    expect(calls).toEqual([
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_routed",
      stepType: "verification",
      provider: "deepseek",
      model: "deepseek-reasoner",
      reason: "preferred model for tool validate_prisma_schema",
    }));
  });

  it("pins task sub-agent runs to the requested model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-task-pin-"));
    const calls: string[] = [];
    const routes = table([
      { match: "planning", provider: "deepseek", model: "deepseek-chat", source: "project" },
      { match: "tool_call", provider: "deepseek", model: "deepseek-chat", source: "project" },
    ]);

    await runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Delegate once.",
      cwd,
      sink: () => {},
      maxTurns: 2,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget, input) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          const isChild = input.messages.some((message) => message.role === "user" && message.content === "Child work.");
          if (isChild) {
            yield { content: "Child done." };
            return;
          }
          if (calls.length === 1) {
            yield {
              toolCalls: [toolCall("call-task", "task", {
                prompt: "Child work.",
                max_turns: 1,
                model: { provider: "openai", model: "gpt-4.1-mini" },
              })],
            };
            return;
          }
          yield { content: "Parent done." };
        }),
      },
    });

    expect(calls).toContain("openai/gpt-4.1-mini");
    const childOpenAiCalls = calls.filter((call) => call === "openai/gpt-4.1-mini");
    expect(childOpenAiCalls).toHaveLength(1);
  });

  it("escalates after the cheap route exhausts malformed tool-call correction", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-escalation-"));
    const events: TanyaEvent[] = [];
    const calls: string[] = [];
    const routes = table([
      {
        match: "planning",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "project",
      },
      {
        match: "unknown",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "project",
      },
    ]);

    const result = await runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Read package.json.",
      cwd,
      sink: (event) => { events.push(event); },
      maxTurns: 4,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* (routeTarget) {
          calls.push(`${routeTarget.provider}/${routeTarget.model}`);
          if (routeTarget.provider === "deepseek") {
            yield {
              toolCalls: [{
                id: "bad-call",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":" },
              }],
            };
            return;
          }
          yield { content: "Escalated success." };
        }),
      },
    });

    expect(result.message).toContain("Escalated success.");
    expect(calls).toEqual([
      "deepseek/deepseek-chat",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-chat",
      "openai/gpt-4.1-mini",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "escalation_event",
      reason: "parse_failure",
      from: { provider: "deepseek", model: "deepseek-chat" },
      to: { provider: "openai", model: "gpt-4.1-mini" },
    }));
  });

  it("throws when the escalation cap is exhausted", async () => {
    vi.stubEnv("TANYA_ESCALATION_CAP", "0");
    const cwd = mkdtempSync(join(tmpdir(), "tanya-router-escalation-cap-"));
    const routes = table([
      {
        match: "planning",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "project",
      },
      {
        match: "unknown",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        source: "project",
      },
    ]);

    await expect(runAgent({
      provider: routedProvider({ provider: "openai", model: "gpt-4.1-mini" }, async function* () {
        yield { content: "unused" };
      }),
      prompt: "Read package.json.",
      cwd,
      sink: () => {},
      maxTurns: 4,
      routing: {
        enabled: true,
        table: routes,
        providerFactory: (target) => routedProvider(target, async function* () {
          yield {
            toolCalls: [{
              id: "bad-call",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":" },
            }],
          };
        }),
      },
    })).rejects.toMatchObject({ name: "EscalationExhaustedError" });
  });
});
