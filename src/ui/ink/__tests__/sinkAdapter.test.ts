import { afterEach, describe, expect, it, vi } from "vitest";
import { createInkSink } from "../sinkAdapter";
import type { InkAction } from "../state";

afterEach(() => {
  vi.useRealTimers();
});

describe("createInkSink", () => {
  it("translates streaming message events into Ink state actions", async () => {
    const actions: InkAction[] = [];
    const startedAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 500);
    const sink = createInkSink((action) => actions.push(action), {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      startedAt,
    });

    await sink({ type: "message_delta", text: "hel" });
    await sink({ type: "message_delta", text: "lo" });
    await sink({
      type: "final",
      message: "hello",
      metrics: {
        durationMs: 500,
        toolCallCount: 0,
        toolErrorCount: 0,
        changedFileCount: 0,
        promptTokens: 1000,
        completionTokens: 500,
      },
    });

    expect(actions[0]).toMatchObject({ type: "assistant_start", elapsedMs: 500 });
    expect(actions).toContainEqual(expect.objectContaining({ type: "assistant_delta", text: "hello" }));
    expect(actions).toContainEqual(expect.objectContaining({
      type: "turn_complete",
      promptTokens: 1000,
      completionTokens: 500,
    }));
  });

  it("coalesces token deltas before dispatching reducer updates", async () => {
    const actions: InkAction[] = [];
    const startedAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 500);
    const sink = createInkSink((action) => actions.push(action), {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      startedAt,
    });

    for (let index = 0; index < 100; index += 1) {
      await sink({ type: "message_delta", text: "x" });
    }

    expect(actions.filter((action) => action.type === "assistant_start")).toHaveLength(1);
    expect(actions.filter((action) => action.type === "assistant_delta")).toHaveLength(0);

    vi.advanceTimersByTime(30);

    const deltas = actions.filter((action): action is Extract<InkAction, { type: "assistant_delta" }> => action.type === "assistant_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.text).toHaveLength(100);
  });

  it("renders final messages when a provider does not stream deltas", async () => {
    const actions: InkAction[] = [];
    const sink = createInkSink((action) => actions.push(action), {
      provider: "custom",
      model: "test-model",
      startedAt: Date.now(),
    });

    await sink({ type: "final", message: "single final response" });

    expect(actions).toContainEqual(expect.objectContaining({ type: "assistant_delta", text: "single final response" }));
    expect(actions).toContainEqual(expect.objectContaining({ type: "turn_complete" }));
  });

  it("coalesces reasoning and emits readable tool activity", async () => {
    const actions: InkAction[] = [];
    const startedAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 500);
    const sink = createInkSink((action) => actions.push(action), {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      startedAt,
    });

    await sink({ type: "reasoning_chunk", content: "checking ", provider: "deepseek", model: "deepseek-v4-pro", runId: "r1" });
    await sink({ type: "reasoning_chunk", content: "files", provider: "deepseek", model: "deepseek-v4-pro", runId: "r1" });
    await sink({ type: "tool_call", id: "t1", tool: "list_files", input: { path: "src/", depth: 1 } });
    await sink({ type: "tool_result", id: "t1", tool: "list_files", ok: true, summary: "23 files" });

    vi.advanceTimersByTime(30);

    expect(actions).toContainEqual(expect.objectContaining({
      type: "activity_start",
      item: expect.objectContaining({ kind: "reasoning", summary: "thinking…" }),
    }));
    expect(actions).toContainEqual(expect.objectContaining({ type: "activity_progress", text: "checking files" }));
    expect(actions).toContainEqual(expect.objectContaining({
      type: "activity_start",
      item: expect.objectContaining({ kind: "tool", summary: 'running list_files(path="src/", depth=1)' }),
    }));
    expect(actions).toContainEqual(expect.objectContaining({
      type: "activity_end",
      summary: "list_files: 23 files",
    }));
  });
});
