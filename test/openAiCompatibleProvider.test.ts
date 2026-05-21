import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../src/providers/openAiCompatible";

function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenAiCompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams content, usage, and assembled tool calls from SSE chunks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"file\",\"arguments\":\"\\\"src/index.ts\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":123,\"completion_tokens\":45}}\n",
      "data: [DONE]\n",
    ])));

    const provider = new OpenAiCompatibleProvider({
      id: "test",
      apiKey: "test",
      baseUrl: "https://example.com",
      model: "demo",
    });

    const deltas = [];
    for await (const delta of provider.streamChat({ messages: [{ role: "user", content: "hello" }] })) {
      deltas.push(delta);
    }

    expect(deltas).toContainEqual({ content: "Hel" });
    expect(deltas).toContainEqual({ content: "lo" });
    expect(deltas).toContainEqual({ usage: { promptTokens: 123, completionTokens: 45 } });
    expect(deltas).toContainEqual({
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"src/index.ts\"}",
        },
      }],
    });
  });

  it("raises an HTTP error with response details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));

    const provider = new OpenAiCompatibleProvider({
      id: "test",
      apiKey: "test",
      baseUrl: "https://example.com",
      model: "demo",
    });

    await expect(async () => {
      for await (const _delta of provider.streamChat({ messages: [{ role: "user", content: "hello" }] })) {
        // exhaust
      }
    }).rejects.toThrow('Provider test returned HTTP 400: bad request');
  });

  it("normalizes tool history before sending it to the provider", async () => {
    let sentBody: { messages?: unknown[] } | undefined;
    const keepCall = { id: "call_keep", type: "function" as const, function: { name: "read_file", arguments: "{}" } };
    const missingCall = { id: "call_missing_result", type: "function" as const, function: { name: "write_file", arguments: "{}" } };
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sentBody = JSON.parse(String((init as RequestInit).body)) as { messages?: unknown[] };
      return sseResponse(["data: [DONE]\n"]);
    }));

    const provider = new OpenAiCompatibleProvider({
      id: "test",
      apiKey: "test",
      baseUrl: "https://example.com",
      model: "demo",
    });

    for await (const _delta of provider.streamChat({
      messages: [
        { role: "user", content: "start" },
        { role: "tool", tool_call_id: "orphan", content: "must be dropped" },
        {
          role: "assistant",
          content: null,
          tool_calls: [keepCall, missingCall],
        },
        { role: "tool", tool_call_id: "call_keep", content: "stale duplicate" },
        { role: "tool", tool_call_id: "call_keep", content: "{\"ok\":true}" },
        { role: "user", content: "continue" },
      ],
    })) {
      // exhaust
    }

    expect(sentBody?.messages).toEqual([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        tool_calls: [keepCall],
      },
      { role: "tool", tool_call_id: "call_keep", content: "{\"ok\":true}" },
      { role: "user", content: "continue" },
    ]);
  });
});
