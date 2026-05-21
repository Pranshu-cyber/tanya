import { describe, expect, it } from "vitest";
import { isLikelySubtaskCycle, similarity } from "../cycleDetect";

describe("sub-agent cycle detection", () => {
  it("rejects near-duplicate prompts against the recent parent window", () => {
    expect(isLikelySubtaskCycle(
      "Map the auth module and list every route.",
      [
        "Ignore this older prompt.",
        "Map the auth module and list every route now.",
      ],
    )).toBe(true);
  });

  it("rejects substring loops and allows distinct work", () => {
    expect(isLikelySubtaskCycle("map the auth module", ["Please map the auth module before editing."])).toBe(true);
    expect(isLikelySubtaskCycle("write the billing unit tests", ["map the auth module"])).toBe(false);
  });

  it("uses normalized Levenshtein similarity for comparable prompts", () => {
    expect(similarity("inspect auth routes", "inspect auth route")).toBeGreaterThan(0.85);
  });
});
