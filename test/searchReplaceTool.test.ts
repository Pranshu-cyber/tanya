import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchReplaceTool } from "../src/tools/fsTools";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-search-replace-"));
}

describe("search_replace tool", () => {
  it("replaces a unique exact string and reports the changed file", async () => {
    const root = makeProject();
    writeFileSync(join(root, "README.md"), "before\n");

    const result = await searchReplaceTool.run(
      { path: "README.md", old_string: "before", new_string: "after" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["README.md"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("after\n");
  });

  it("fails when old_string is not found", async () => {
    const root = makeProject();
    writeFileSync(join(root, "README.md"), "hello\n");

    const result = await searchReplaceTool.run(
      { path: "README.md", old_string: "missing", new_string: "after" },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("hello\n");
  });

  it("fails when old_string appears more times than expected_count", async () => {
    const root = makeProject();
    writeFileSync(join(root, "README.md"), "item\nitem\n");

    const result = await searchReplaceTool.run(
      { path: "README.md", old_string: "item", new_string: "entry" },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Found 2 occurrences");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("item\nitem\n");
  });

  it("replaces all matches when expected_count is greater than one", async () => {
    const root = makeProject();
    writeFileSync(join(root, "README.md"), "item\nitem\n");

    const result = await searchReplaceTool.run(
      { path: "README.md", old_string: "item", new_string: "entry", expected_count: 2 },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      path: "README.md",
      count: 2,
      lineCount: 3,
      context: "entry\nentry\n",
    });
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("entry\nentry\n");
  });

  it("rejects paths outside the workspace", async () => {
    const root = makeProject();

    const result = await searchReplaceTool.run(
      { path: "../outside.txt", old_string: "before", new_string: "after" },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("escapes workspace");
  });
});
