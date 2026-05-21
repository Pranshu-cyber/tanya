import { describe, expect, it } from "vitest";
import { createCosmoSink } from "../cosmo";
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

  it("keeps Cosmo bridge output byte-stable for live-status event fixtures", () => {
    const output = render(createCosmoSink, events);
    expect(output).toBe([
      "__E:{\"t\":\"status\",\"message\":\"Model routed: planning -> deepseek/deepseek-chat\",\"key\":\"tanya:model-routed:planning:deepseek:deepseek-chat\",\"stepType\":\"planning\",\"provider\":\"deepseek\",\"model\":\"deepseek-chat\",\"reason\":\"route\"}",
      "__E:{\"t\":\"tool_call\",\"tool\":\"read_file\",\"detail\":\"{\\\"path\\\":\\\"README.md\\\"}\",\"content\":\"\",\"id\":\"call-1\"}",
      "__E:{\"t\":\"tool_result\",\"id\":\"call-1\",\"output\":\"read README\",\"error\":false}",
      "__E:{\"t\":\"status\",\"message\":\"Compaction: removed ~2k tokens via snip.\",\"key\":\"tanya:compact:snip:none\",\"compactType\":\"snip\",\"removedTokens\":2000}",
      "Done.",
      "__E:{\"t\":\"status\",\"message\":\"Tanya finished. Changed files: 1. Tool errors: 0.\",\"key\":\"tanya:final\",\"files\":[\"README.md\"]}",
      "",
    ].join("\n"));
    expect(output).not.toContain("\x1b");
  });
});
