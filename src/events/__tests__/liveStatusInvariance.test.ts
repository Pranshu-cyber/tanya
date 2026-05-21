import { describe, expect, it } from "vitest";
import { createJsonlSink } from "../jsonl";
import type { TanyaEvent } from "../types";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

function render(createSink: (stream: NodeJS.WritableStream) => (event: TanyaEvent) => void | Promise<void>, events: TanyaEvent[]): string {
  const stream = new MemoryStream();
  const sink = createSink(stream as unknown as NodeJS.WritableStream);
  for (const event of events) void sink(event);
  return stream.text();
}

describe("live status sink invariance", () => {
  const events: TanyaEvent[] = [
    { type: "model_routed", stepType: "planning", provider: "deepseek", model: "deepseek-chat", reason: "route" },
    { type: "tool_call", id: "call-1", tool: "read_file", input: { path: "README.md" } },
    { type: "tool_result", id: "call-1", tool: "read_file", ok: true, summary: "read README" },
    { type: "compact_event", compactType: "snip", removedTokens: 2_000 },
    { type: "final", message: "Done.", files: ["README.md"] },
  ];

  it("keeps JSONL output byte-stable for live-status event fixtures", () => {
    const output = render(createJsonlSink, events);
    expect(output).toBe(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(output).not.toContain("\x1b");
  });

});
