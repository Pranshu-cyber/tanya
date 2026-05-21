import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviderAdapters } from "../../src/providers/adapters";
import { OpenAiCompatibleProvider } from "../../src/providers/openAiCompatible";
import type { ToolDefinition } from "../../src/providers/types";

function sseResponse(content: string, status = 200): Response {
  if (status !== 200) return new Response(content, { status });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${content}"},"finish_reason":"stop"}]}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const complexTool = {
  type: "function",
  function: {
    name: "inspect_workspace",
    description: "Inspect a workspace path.",
    parameters: {
      type: "object",
      properties: {
        target: { $ref: "#/$defs/target" },
      },
      oneOf: [
        {
          type: "object",
          properties: {
            target: { type: "string" },
            mode: { type: "string", enum: ["read"] },
          },
          required: ["target"],
        },
        {
          type: "object",
          properties: {
            target: { type: "string" },
            depth: { type: "number" },
          },
          required: ["target"],
        },
      ],
      $defs: {
        target: { type: "string" },
      },
    },
  },
} as unknown as ToolDefinition;

describe("provider conformance mock suite", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(listProviderAdapters().map((adapter) => [adapter.id, adapter.defaultBaseUrl ?? "https://example.com/v1", adapter.capabilities.flattenSchemas] as const))(
    "completes a synthetic 3-message turn for %s",
    async (adapterId, baseUrl, flattenSchemas) => {
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages?: unknown[]; tools?: ToolDefinition[]; tool_choice?: string };
        expect(body.messages).toHaveLength(3);
        expect(body.tool_choice).toBe("auto");

        const serializedTools = JSON.stringify(body.tools ?? []);
        if (flattenSchemas) {
          expect(serializedTools).not.toContain("$ref");
          expect(serializedTools).not.toContain("oneOf");
        }

        return sseResponse(adapterId);
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({
        id: adapterId,
        apiKey: "test",
        baseUrl,
        model: "conformance-model",
      });

      let text = "";
      for await (const delta of provider.streamChat({
        messages: [
          { role: "system", content: "Provider conformance probe." },
          { role: "user", content: "Return the adapter id." },
          { role: "user", content: "Keep it short." },
        ],
        tools: [complexTool],
      })) {
        if (delta.content) text += delta.content;
      }

      expect(text).toBe(adapterId);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});
