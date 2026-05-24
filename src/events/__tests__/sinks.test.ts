import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonlSink } from "../jsonl";
import { createHumanSink } from "../../ui/humanSink";
import type { EventSink, TanyaEvent } from "../types";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("event sinks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("serializes tool progress events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({
      type: "tool_progress",
      toolCallId: "call-1",
      chunk: "installing\n",
      timestamp: "2026-05-14T12:00:00.000Z",
      stream: "stdout",
    });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "tool_progress",
      toolCallId: "call-1",
      chunk: "installing\n",
      timestamp: "2026-05-14T12:00:00.000Z",
      stream: "stdout",
    });
  });

  it("serializes command_invoked events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "command_invoked", name: "help", args: ["--all"], runId: "run-1" });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "command_invoked",
      name: "help",
      args: ["--all"],
      runId: "run-1",
    });
  });

  it("serializes provider throttle events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "provider_throttle", provider: "groq", attempt: 2, waitMs: 1500 });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "provider_throttle",
      provider: "groq",
      attempt: 2,
      waitMs: 1500,
    });
  });

  it("serializes provider raw events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({
      type: "provider.raw",
      provider: "claude",
      model: "claude-sonnet-4-6",
      event: { type: "model_routed", reason: "cascade-fit" },
    });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "provider.raw",
      provider: "claude",
      model: "claude-sonnet-4-6",
      event: { type: "model_routed", reason: "cascade-fit" },
    });
  });

  it("serializes compact events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "compact_event", compactType: "auto", removedTokens: 12_345, summaryTokens: 321, aggression: "normal" });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "compact_event",
      compactType: "auto",
      removedTokens: 12_345,
      summaryTokens: 321,
      aggression: "normal",
    });
  });

  it("serializes prompt budget events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "prompt_budget_exceeded", droppedSections: ["artifact index"], totalTokens: 12_000, cap: 8_000 });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "prompt_budget_exceeded",
      droppedSections: ["artifact index"],
      totalTokens: 12_000,
      cap: 8_000,
    });
  });

  it("serializes reasoning events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "reasoning_chunk", content: "private thought", provider: "deepseek", model: "deepseek-reasoner", runId: "r-1", turn: 1, tokens: 3 });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "reasoning_chunk",
      content: "private thought",
      provider: "deepseek",
      model: "deepseek-reasoner",
      runId: "r-1",
      turn: 1,
      tokens: 3,
    });
  });

  it("drops unknown JSONL event types without throwing", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream) as EventSink;

    await sink({ type: "future_event", value: true } as unknown as TanyaEvent);

    expect(stream.chunks).toEqual([]);
  });

  it("accepts cancellation, permission, and compaction events in human and JSONL sinks", async () => {
    const events: TanyaEvent[] = [
      { type: "tool_cancel_requested", toolCallId: "call-1", tool: "run_shell", timestamp: "2026-05-14T12:00:00.000Z" },
      { type: "tool_cancelled", toolCallId: "call-1", tool: "run_shell", timestamp: "2026-05-14T12:00:00.100Z", partialOutput: "partial" },
      { type: "permission_request", id: "call-2", tool: "write_file", input: { path: "README.md" }, matchedRule: "write_file:.*" },
      { type: "permission_decision", id: "call-2", decision: "deny", source: "rule", matchedRule: "write_file:.*" },
      { type: "compact_event", compactType: "snip", removedTokens: 2000 },
      { type: "prompt_budget_exceeded", droppedSections: ["domain packs"], totalTokens: 12_000, cap: 8_000 },
    ];

    for (const createSink of [createHumanSink, createJsonlSink]) {
      const stream = new MemoryStream();
      const sink = createSink(stream as unknown as NodeJS.WritableStream);
      for (const event of events) await sink(event);
    }
  });

  it("renders reasoning as a collapsed human thinking summary before final output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00.000Z"));
    const stream = new MemoryStream();
    const sink = createHumanSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "message_start" });
    await sink({ type: "reasoning_chunk", content: "checking invariants", provider: "deepseek", model: "deepseek-reasoner", runId: "r-1", turn: 1, tokens: 4 });
    vi.setSystemTime(new Date("2026-05-16T12:00:12.400Z"));
    await sink({ type: "message_delta", text: "Final answer." });
    await sink({ type: "message_end" });

    const output = stream.chunks.join("");
    expect(output).toContain("thinking... checking invariants");
    expect(output).toContain("thinking for 12.4s...");
    expect(output).toContain("Final answer.");
  });

  it("renders optional elapsed time in human message headings", async () => {
    const stream = new MemoryStream();
    const sink = createHumanSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "message_start", elapsedMs: 3240 });
    await sink({ type: "message_delta", text: "Timed response." });
    await sink({ type: "message_end" });

    expect(stream.chunks.join("")).toContain("Tanya · 3.2s: Timed response.");
  });

  it("renders optional clock time in human message headings", async () => {
    const stream = new MemoryStream();
    const sink = createHumanSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "message_start", elapsedMs: 5123, headingStartedAt: new Date(2026, 4, 17, 14, 32, 21).getTime() });
    await sink({ type: "message_delta", text: "Clocked response." });
    await sink({ type: "message_end" });

    expect(stream.chunks.join("")).toContain("[14:32:21] Tanya · 5.1s: Clocked response.");
  });

  it("suppresses human reasoning when TANYA_HIDE_REASONING is set", async () => {
    vi.stubEnv("TANYA_HIDE_REASONING", "1");
    const stream = new MemoryStream();
    const sink = createHumanSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "message_start" });
    await sink({ type: "reasoning_chunk", content: "hidden", provider: "deepseek", model: "deepseek-reasoner", runId: "r-1" });
    await sink({ type: "message_delta", text: "Final answer." });
    await sink({ type: "message_end" });

    const output = stream.chunks.join("");
    expect(output).not.toContain("hidden");
    expect(output).not.toContain("thinking");
    expect(output).toContain("Final answer.");
  });

  it("serializes reasoning truncation events to JSONL", async () => {
    const stream = new MemoryStream();
    const sink = createJsonlSink(stream as unknown as NodeJS.WritableStream);

    await sink({ type: "reasoning_truncated", provider: "qwen", model: "qwen3-thinking-plus", usedTokens: 1200, capTokens: 1000, stepType: "synthesis" });

    expect(JSON.parse(stream.chunks.join(""))).toEqual({
      type: "reasoning_truncated",
      provider: "qwen",
      model: "qwen3-thinking-plus",
      usedTokens: 1200,
      capTokens: 1000,
      stepType: "synthesis",
    });
  });
});
