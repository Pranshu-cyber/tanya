import { describe, expect, it } from "vitest";
import { phaseAwareMaxTurns } from "../phaseBudget";

describe("phaseAwareMaxTurns", () => {
  it("returns 300 for foundation-phase coding work", () => {
    expect(phaseAwareMaxTurns({ task: { kind: "coding", title: "go-backend-foundation" } }, "")).toBe(300);
    expect(phaseAwareMaxTurns({ task: { kind: "coding", title: "Backend foundation" } }, "")).toBe(300);
  });

  it("keeps other phase budgets unchanged", () => {
    expect(phaseAwareMaxTurns({ task: { kind: "coding", title: "go-backend-init setup" } }, "")).toBe(200);
    expect(phaseAwareMaxTurns({ task: { kind: "coding", title: "go-backend-auth" } }, "")).toBe(200);
    expect(phaseAwareMaxTurns({ task: { kind: "coding", title: "go-backend-feature-crud" } }, "")).toBe(100);
    expect(phaseAwareMaxTurns({ task: { kind: "coding", title: "go-backend-verify" } }, "")).toBe(50);
  });
});
