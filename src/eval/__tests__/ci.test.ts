import { describe, expect, it } from "vitest";
import { evalCiShouldFail, evalCiSummary } from "../ci";

describe("eval CI regression decisions", () => {
  it("fails when the compare step reports a tracked regression", () => {
    const comparison = {
      baselineSuite: "tanya-native@1",
      newSuite: "tanya-native@1",
      costRegressionThreshold: 0.2,
      regressions: [{ taskId: "native-01", reason: "verdict drift: passed -> failed" }],
      improvements: [],
    };
    expect(evalCiShouldFail(comparison)).toBe(true);
    expect(evalCiSummary(comparison)).toContain("native-01");
  });

  it("passes when there are no regressions", () => {
    expect(evalCiShouldFail({
      baselineSuite: "tanya-native@1",
      newSuite: "tanya-native@1",
      costRegressionThreshold: 0.2,
      regressions: [],
      improvements: [],
    })).toBe(false);
  });
});
