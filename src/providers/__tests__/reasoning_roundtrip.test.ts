import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../agent/runner";
import { messagesForAdapter, OpenAiCompatibleProvider } from "../openAiCompatible";
import type { ChatMessage } from "../types";

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

type RequestBody = {
  messages?: Array<{
    role?: string;
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: unknown[];
  }>;
};

describe("DeepSeek reasoning_content round-trip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists and sends DeepSeek assistant reasoning_content byte-identically on the next turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-deepseek-reasoning-roundtrip-"));
    writeFileSync(join(cwd, "package.json"), "{}");
    const bodies: RequestBody[] = [];
    const streamedReasoning = "inspect package\nthen read file";
    const responses = [
      [
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"inspect package\\n\"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"then read file\"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Need package\"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-read\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"package.json\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
        "data: [DONE]\n",
      ],
      [
        "data: {\"choices\":[{\"delta\":{\"content\":\"Done.\"},\"finish_reason\":\"stop\"}]}\n",
        "data: [DONE]\n",
      ],
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)) as RequestBody);
      return sseResponse(responses.shift() ?? ["data: [DONE]\n"]);
    }));

    const provider = new OpenAiCompatibleProvider({
      id: "deepseek",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    });

    await runAgent({
      provider,
      prompt: "Read package.json.",
      cwd,
      sink: async () => {},
      maxTurns: 2,
    });

    const assistant = bodies[1]?.messages?.find((message) => message.role === "assistant");
    expect(assistant).toEqual(expect.objectContaining({
      role: "assistant",
      content: "Need package",
      reasoning_content: streamedReasoning,
    }));
  });

  it("strips reasoning_content from OpenAI-compatible providers that do not opt into round-trip reasoning", async () => {
    const bodies: RequestBody[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)) as RequestBody);
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n",
        "data: [DONE]\n",
      ]);
    }));

    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      apiKey: "test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    });

    for await (const _delta of provider.streamChat({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "answer", reasoning_content: "must not leak" },
      ],
    })) {
      // exhaust stream
    }

    expect(bodies[0]?.messages?.[1]).toEqual({ role: "assistant", content: "answer" });
    expect(JSON.stringify(bodies[0])).not.toContain("reasoning_content");
  });

  it("forwards empty string content when assistant turn has only reasoning_content (DeepSeek)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "continue" },
      { role: "assistant", content: null, reasoning_content: "thinking..." },
    ];

    const adapted = messagesForAdapter([...messages], true);
    expect(adapted[1]).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "thinking...",
    });
    expect(adapted[1]).not.toHaveProperty("tool_calls");
  });

  it("leaves null content alone for non-DeepSeek adapters", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "continue" },
      { role: "assistant", content: null, reasoning_content: "thinking..." },
    ];

    const adapted = messagesForAdapter([...messages], false);
    expect(adapted[1]).toEqual({
      role: "assistant",
      content: null,
    });
  });

  it("leaves null content alone when tool_calls is present", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        reasoning_content: "thinking...",
        tool_calls: [
          {
            id: "x",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
      },
    ];

    const adapted = messagesForAdapter([...messages], true);
    expect(adapted[0]).toEqual(messages[0]);
  });
});
