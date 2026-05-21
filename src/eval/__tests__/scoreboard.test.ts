import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateEvalResult } from "../schemas";

describe("public benchmark snapshots", () => {
  it("keeps checked-in scoreboard JSON valid", () => {
    for (const file of ["docs/benchmarks/tanya-native-latest.json", "docs/benchmarks/swe-bench-lite-latest.json", "docs/benchmarks/eco-30-latest.json"]) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(validateEvalResult(parsed).ok).toBe(true);
    }
  });
});
