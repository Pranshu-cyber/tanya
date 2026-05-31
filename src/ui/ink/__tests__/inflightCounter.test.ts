import { describe, expect, it } from "vitest";
import { createInitialInkState, inkReducer } from "../state";

function freshState() {
  return createInitialInkState({ provider: "deepseek", model: "deepseek-v4-pro", now: 1_000 });
}

describe("live in-flight token/cost counter (reducer)", () => {
  it("starts empty and resets on turn_start", () => {
    let state = freshState();
    expect(state.inflight).toEqual({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 });
    state = inkReducer(state, { type: "turn_progress", completionTokens: 100 });
    state = inkReducer(state, { type: "turn_start", startedAt: 2_000 });
    expect(state.inflight.completionTokens).toBe(0);
  });

  it("accumulates prompt/completion/reasoning and prices them via the configured model", () => {
    let state = freshState();
    state = inkReducer(state, { type: "turn_progress", promptTokens: 1_000_000 });
    state = inkReducer(state, { type: "turn_progress", completionTokens: 500_000, reasoningTokens: 500_000 });
    expect(state.inflight.promptTokens).toBe(1_000_000);
    expect(state.inflight.completionTokens).toBe(500_000);
    expect(state.inflight.reasoningTokens).toBe(500_000);
    // v4-pro: 1M*0.435 input + 1M*0.87 output = 1.305
    expect(state.inflight.costUsd).toBeCloseTo(1.305, 5);
  });

  it("partial updates keep prior fields (a completion tick doesn't wipe prompt tokens)", () => {
    let state = freshState();
    state = inkReducer(state, { type: "turn_progress", promptTokens: 4_000 });
    state = inkReducer(state, { type: "turn_progress", completionTokens: 40 });
    expect(state.inflight.promptTokens).toBe(4_000);
    expect(state.inflight.completionTokens).toBe(40);
  });

  it("resets the live estimate on turn_complete (exact metrics take over)", () => {
    let state = freshState();
    state = inkReducer(state, { type: "turn_progress", promptTokens: 1_000, completionTokens: 100 });
    state = inkReducer(state, { type: "turn_complete", elapsedMs: 500, promptTokens: 1_000, completionTokens: 120, costUsd: 0.01 });
    expect(state.inflight).toEqual({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 });
    expect(state.stats.costUsd).toBeCloseTo(0.01, 5);
  });
});
