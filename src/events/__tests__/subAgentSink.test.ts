import { describe, expect, it } from "vitest";
import { createJsonlSink } from "../jsonl";
import { createSubAgentSink } from "../subAgentSink";

function memoryStream(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
  };
}

describe("sub-agent sink", () => {
  it("tags forwarded child events with subRunId in JSONL output", async () => {
    const { chunks, stream } = memoryStream();
    const sink = createSubAgentSink(createJsonlSink(stream), "r-parent.t-1");

    await sink({ type: "tool_call", id: "call-1", tool: "read_file", input: { path: "a.ts" } });

    expect(JSON.parse(chunks.join("").trim())).toMatchObject({
      type: "tool_call",
      id: "call-1",
      subRunId: "r-parent.t-1",
    });
  });
});
