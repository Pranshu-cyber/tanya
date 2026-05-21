import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviderAdapters, resolveProviderAdapter } from "../adapters";
import { OpenAiCompatibleProvider } from "../openAiCompatible";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("provider adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the known cheap-provider adapters", () => {
    expect(listProviderAdapters().map((adapter) => adapter.id)).toEqual([
      "deepseek",
      "qwen",
      "grok",
      "groq",
      "together",
      "ollama",
      "openai",
    ]);
  });

  it.each([
    ["deepseek", "https://api.deepseek.com", "deepseek"],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen"],
    ["grok", "https://api.x.ai/v1", "grok"],
    ["groq", "https://api.groq.com/openai/v1", "groq"],
    ["together", "https://api.together.xyz/v1", "together"],
    ["ollama", "http://localhost:11434/v1", "ollama"],
    ["openai", "https://api.openai.com/v1", "openai"],
  ])("resolves %s by explicit provider and base URL", (provider, baseUrl, expected) => {
    expect(resolveProviderAdapter({ provider }).id).toBe(expected);
    expect(resolveProviderAdapter({ baseUrl }).id).toBe(expected);
  });

  it("prefers explicit provider over base URL and falls back to openai", () => {
    expect(resolveProviderAdapter({ provider: "qwen", baseUrl: "https://api.openai.com/v1" }).id).toBe("qwen");
    expect(resolveProviderAdapter({ provider: "unknown", baseUrl: "https://example.com/v1" }).id).toBe("openai");
  });

  it("applies adapter preRequest hooks before sending", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n",
      "data: [DONE]\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider({
      id: "qwen",
      apiKey: "test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-coder-plus",
    });

    for await (const _delta of provider.streamChat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: {
          name: "noop",
          description: "No-op",
          parameters: { type: "object", properties: {} },
        },
      }],
    })) {
      // exhaust
    }

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    const init = firstCall?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.model).toBe("qwen3-coder-plus");
  });

  it("applies adapter postResponse hooks to streamed chunks", async () => {
    const adapter = resolveProviderAdapter({ provider: "openai" });
    const originalPostResponse = adapter.postResponse;
    try {
      adapter.postResponse = (res) => ({
        ...res,
        choices: [{ delta: { content: "patched" }, finish_reason: "stop" }],
      });
      vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"raw\"},\"finish_reason\":\"stop\"}]}\n",
        "data: [DONE]\n",
      ])));

      const provider = new OpenAiCompatibleProvider({
        id: "openai",
        apiKey: "test",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
      });

      const deltas = [];
      for await (const delta of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
        deltas.push(delta);
      }

      expect(deltas).toContainEqual({ content: "patched" });
    } finally {
      if (originalPostResponse) adapter.postResponse = originalPostResponse;
      else delete adapter.postResponse;
    }
  });
});
