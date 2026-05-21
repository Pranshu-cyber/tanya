import { describe, expect, it } from "vitest";
import { createCosmoSink } from "../src/events/cosmo";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("createCosmoSink", () => {
  it("keeps structured events at the start of a new line after streamed text", async () => {
    const stream = new MemoryStream();
    const sink = createCosmoSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "message_delta", text: "Thinking" });
    await sink({ type: "tool_call", id: "1", tool: "search", input: { query: "x" } });

    expect(stream.chunks.join("")).toMatch(/^Thinking\n__E:/);
  });
});
