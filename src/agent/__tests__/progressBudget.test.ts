import { describe, expect, it } from "vitest";
import { resolveProgressBudget, shouldStopAfterBudget } from "../progressBudget";

describe("resolveProgressBudget", () => {
  it("is disabled (exact cap) unless the caller opts in", () => {
    // eval harness / sub-agents / explicit --max-turns pass no extendOnProgress
    expect(resolveProgressBudget(40).enabled).toBe(false);
    expect(resolveProgressBudget(40).hardCeiling).toBe(40); // exact cap preserved
    expect(resolveProgressBudget(300).hardCeiling).toBe(300);
  });

  it("extends to a hard ceiling only when opted in", () => {
    expect(resolveProgressBudget(40, { extendOnProgress: true }).enabled).toBe(true);
    expect(resolveProgressBudget(40, { extendOnProgress: true }).hardCeiling).toBe(300);
    expect(resolveProgressBudget(100, { extendOnProgress: true }).hardCeiling).toBe(300);
    // a budget already above the ceiling keeps its own value
    expect(resolveProgressBudget(500, { extendOnProgress: true }).hardCeiling).toBe(500);
  });
});

describe("shouldStopAfterBudget", () => {
  const off = resolveProgressBudget(100); // not opted in
  const on = resolveProgressBudget(100, { extendOnProgress: true });

  it("never stops when extension is disabled (loop bound enforces the cap)", () => {
    expect(shouldStopAfterBudget(99, 100, 0, off)).toBe(false);
    expect(shouldStopAfterBudget(150, 100, 0, off)).toBe(false);
  });

  it("never early-stops WITHIN the soft budget, even with no progress (cold start safe)", () => {
    // turn 8, no progress since turn 0 -> within budget -> must NOT stop
    expect(shouldStopAfterBudget(8, 100, 0, on)).toBe(false);
    expect(shouldStopAfterBudget(99, 100, 0, on)).toBe(false);
  });

  it("keeps a productive run going past the soft budget", () => {
    // turn 150, last progress on turn 149 -> turnsSinceProgress === 1 (healthy)
    expect(shouldStopAfterBudget(150, 100, 149, on)).toBe(false);
  });

  it("stops past the soft budget once the previous turn made no progress", () => {
    // turn 150, last progress on turn 148 -> turnsSinceProgress === 2
    expect(shouldStopAfterBudget(150, 100, 148, on)).toBe(true);
  });
});
