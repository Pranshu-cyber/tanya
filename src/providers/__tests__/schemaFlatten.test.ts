import { afterEach, describe, expect, it, vi } from "vitest";
import { flattenJsonSchema } from "../schemaFlatten";
import { OpenAiCompatibleProvider } from "../openAiCompatible";
import type { ToolDefinition } from "../types";

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

describe("schema flattening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inlines local $ref entries", () => {
    const result = flattenJsonSchema({
      type: "object",
      properties: {
        path: { $ref: "#/$defs/path" },
      },
      $defs: {
        path: { type: "string", description: "Workspace path" },
      },
    });

    expect(result.schema).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace path" },
      },
    });
    expect(result.warnings[0]?.reason).toContain("inlined $ref");
  });

  it("collapses oneOf to a common object shape and warns about lossy flattening", () => {
    const result = flattenJsonSchema({
      oneOf: [
        {
          type: "object",
          properties: {
            path: { type: "string" },
            mode: { type: "string", enum: ["read"] },
          },
          required: ["path", "mode"],
        },
        {
          type: "object",
          properties: {
            path: { type: "string" },
            recursive: { type: "boolean" },
          },
          required: ["path"],
        },
      ],
    });

    expect(result.schema).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    });
    expect(result.warnings.some((warning) => warning.reason.includes("collapsed oneOf"))).toBe(true);
  });

  it("flattens Qwen tool schemas before send and yields schema_flatten warnings", async () => {
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
    const tool = {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            target: { $ref: "#/$defs/target" },
          },
          $defs: {
            target: { type: "string" },
          },
        },
      },
    } as unknown as ToolDefinition;

    const deltas = [];
    for await (const delta of provider.streamChat({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
    })) {
      deltas.push(delta);
    }

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    const init = firstCall?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as { tools: ToolDefinition[] };
    expect(body.tools[0]?.function.parameters).toEqual({
      type: "object",
      properties: {
        target: { type: "string" },
      },
    });
    expect(deltas[0]).toEqual({
      schemaWarnings: [{
        path: "#/properties/target",
        reason: "inlined $ref #/$defs/target",
        tool: "read_file",
      }],
    });
  });
});
