import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextWindowExceededError } from "../types";
import { OpenAiCompatibleProvider } from "../openAiCompatible";

describe("context window error detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates 413 provider responses into a typed context-window error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("context_length_exceeded", { status: 413 })));
    const provider = new OpenAiCompatibleProvider({
      id: "deepseek",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });

    await expect(async () => {
      for await (const _delta of provider.streamChat({ messages: [{ role: "user", content: "hello" }] })) {
        // exhaust
      }
    }).rejects.toMatchObject({
      name: "ContextWindowExceededError",
      provider: "deepseek",
      status: 413,
      rawMessage: "context_length_exceeded",
    });
  });

  it("leaves non-413 server errors as generic provider failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("context_length_exceeded", { status: 500 })));
    const provider = new OpenAiCompatibleProvider({
      id: "deepseek",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });

    await expect(async () => {
      for await (const _delta of provider.streamChat({ messages: [{ role: "user", content: "hello" }] })) {
        // exhaust
      }
    }).rejects.not.toBeInstanceOf(ContextWindowExceededError);
  });

  it("does not inspect successful response bodies as context failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("context_length_exceeded", { status: 200 })));
    const provider = new OpenAiCompatibleProvider({
      id: "deepseek",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });

    const deltas = [];
    for await (const delta of provider.streamChat({ messages: [{ role: "user", content: "hello" }] })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([]);
  });
});
