import { describe, expect, it } from "vitest";
import { clampToLastLines } from "../clampLines";

describe("clampToLastLines", () => {
  it("returns text unchanged when within the limit", () => {
    expect(clampToLastLines("a\nb\nc", 14)).toBe("a\nb\nc");
  });

  it("keeps only the last N lines of long text", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const clamped = clampToLastLines(text, 14);
    expect(clamped.split("\n")).toHaveLength(14);
    expect(clamped.split("\n").at(-1)).toBe("line 39");
    expect(clamped.split("\n")[0]).toBe("line 26");
  });

  it("returns empty for a non-positive limit", () => {
    expect(clampToLastLines("a\nb", 0)).toBe("");
  });
});
