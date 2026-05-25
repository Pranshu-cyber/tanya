import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI retry recovery safety", () => {
  it("does not discard the working tree after a stash-pop conflict", () => {
    const source = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");

    expect(source).not.toContain('["checkout", "."]');
    expect(source).not.toContain("git checkout .");
    expect(source).toContain("leaving the conflicted files in place for manual recovery");
  });
});
