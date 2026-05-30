import { describe, expect, it } from "vitest";
import { inferInteractiveRun, looksLikeInteractiveCoding } from "../interactiveBudget";

describe("looksLikeInteractiveCoding", () => {
  it("detects build/app intent", () => {
    expect(looksLikeInteractiveCoding("build an iOS calculator app from scratch")).toBe(true);
    expect(looksLikeInteractiveCoding("create a new React Native screen")).toBe(true);
    expect(looksLikeInteractiveCoding("implement a login endpoint")).toBe(true);
    expect(looksLikeInteractiveCoding("fix the SwiftUI view")).toBe(true);
    expect(looksLikeInteractiveCoding("scaffold a FastAPI project")).toBe(true);
  });

  it("ignores casual / non-coding chat", () => {
    expect(looksLikeInteractiveCoding("what's the weather like?")).toBe(false);
    expect(looksLikeInteractiveCoding("explain how promises work")).toBe(false);
    expect(looksLikeInteractiveCoding("hi")).toBe(false);
    expect(looksLikeInteractiveCoding("")).toBe(false);
  });

  it("does not false-positive on bare English that doubles as a stack word", () => {
    expect(looksLikeInteractiveCoding("who is Taylor Swift?")).toBe(false);
    expect(looksLikeInteractiveCoding("I want to express my thanks")).toBe(false);
    expect(looksLikeInteractiveCoding("there was a flutter of excitement")).toBe(false);
  });
});

describe("inferInteractiveRun", () => {
  it("returns a coding runContext and a phase-aware budget for build prompts", () => {
    const inferred = inferInteractiveRun("build an iOS calculator app from scratch");
    expect(inferred.runContext?.task?.kind).toBe("coding");
    expect(inferred.runContext?.task?.title).toBe("build an iOS calculator app from scratch");
    // generic coding work → phaseAwareMaxTurns default of 100
    expect(inferred.maxTurns).toBe(100);
  });

  it("uses the larger foundation budget when the prompt implies it", () => {
    const inferred = inferInteractiveRun("build the go-backend-foundation from scratch");
    expect(inferred.maxTurns).toBe(300);
  });

  it("returns nothing for non-coding prompts (falls back to the runner floor)", () => {
    expect(inferInteractiveRun("what is the capital of France?")).toEqual({});
  });

  it("truncates an overlong title", () => {
    const long = "build an app that does " + "x".repeat(200);
    const inferred = inferInteractiveRun(long);
    expect(inferred.runContext?.task?.title?.length).toBeLessThanOrEqual(80);
  });
});
