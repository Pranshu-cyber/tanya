import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEditBlockInput, editBlockTool } from "../editBlock";
import { searchReplaceTool } from "../fsTools";
import type { PermissionContext } from "../../safety/permissions/engine";
import type { PermissionRulesConfig } from "../../safety/permissions/schema";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-edit-block-"));
  writeFileSync(join(root, "file.ts"), "export const value = 1;\n");
  return root;
}

function rules(overrides: Partial<PermissionRulesConfig> = {}): PermissionRulesConfig {
  return {
    version: 1,
    mode: "default",
    alwaysAllow: [],
    alwaysDeny: [],
    alwaysAsk: [],
    pathRules: [],
    spendRules: [],
    ...overrides,
  };
}

function context(root: string, overrides: Partial<PermissionRulesConfig> = {}): PermissionContext {
  return {
    mode: "default",
    rules: rules(overrides),
    runId: "r-test",
    cwd: root,
  };
}

describe("edit_block schema and permission gate", () => {
  it("rejects malformed inputs before applying", () => {
    const root = workspace();
    expect(() => parseEditBlockInput({ search: "a", replace: "b" }, root)).toThrow("path");
    expect(() => parseEditBlockInput({ path: "file.ts", replace: "b" }, root)).toThrow("search");
    expect(() => parseEditBlockInput({ path: "file.ts", search: "a", replace: "a" }, root)).toThrow("must differ");
    expect(() => parseEditBlockInput({ path: "../outside.ts", search: "a", replace: "b" }, root)).toThrow("escapes workspace");
    expect(() => parseEditBlockInput({ path: "image.png", search: "a", replace: "b" }, root)).toThrow("binary");
    expect(() => parseEditBlockInput({ path: "file.ts", search: "a", replace: "b", expectedCount: 0 }, root)).toThrow("expectedCount");
    expect(() => parseEditBlockInput({ path: "file.ts", search: "a", replace: "b", matchPolicy: "loose" }, root)).toThrow("matchPolicy");
  });

  it("defaults exact policy and expected count", () => {
    const root = workspace();
    expect(parseEditBlockInput({ path: "file.ts", search: "value", replace: "answer" }, root)).toEqual({
      path: "file.ts",
      search: "value",
      replace: "answer",
      expectedCount: 1,
      matchPolicy: "exact",
    });
  });

  it("denies fuzzy policy unless an edit_block alwaysAllow rule explicitly matches", async () => {
    const root = workspace();
    const input = { path: "file.ts", search: "value", replace: "answer", matchPolicy: "fuzzy" };

    await expect(editBlockTool.canRun?.(input, context(root))).resolves.toEqual(expect.objectContaining({
      decision: "deny",
      reason: "fuzzy edit blocks require explicit permission",
    }));

    await expect(editBlockTool.canRun?.(input, context(root, {
      alwaysAllow: ["edit_block:.*\"matchPolicy\":\"fuzzy\".*"],
    }))).resolves.toEqual(expect.objectContaining({
      decision: "allow",
      matchedRule: "edit_block:.*\"matchPolicy\":\"fuzzy\".*",
    }));
  });

  it("applies exact replacements with diff metadata and changed-file output", async () => {
    const root = workspace();
    const result = await editBlockTool.run({
      path: "file.ts",
      search: "export const value = 1;",
      replace: "export const value = 2;",
    }, { workspace: root });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["file.ts"]);
    expect(readFileSync(join(root, "file.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(result.output).toEqual(expect.objectContaining({
      path: "file.ts",
      count: 1,
      matchPolicy: "exact",
      diff: expect.stringContaining("--- a/file.ts"),
      beforeHash: expect.any(String),
      afterHash: expect.any(String),
    }));
  });

  it("matches search_replace behavior on exact replacement fixtures", async () => {
    const editRoot = workspace();
    const searchRoot = workspace();

    const editResult = await editBlockTool.run({
      path: "file.ts",
      search: "value",
      replace: "answer",
    }, { workspace: editRoot });
    const searchResult = await searchReplaceTool.run({
      path: "file.ts",
      old_string: "value",
      new_string: "answer",
    }, { workspace: searchRoot });

    expect(editResult.ok).toBe(searchResult.ok);
    expect(readFileSync(join(editRoot, "file.ts"), "utf8")).toBe(readFileSync(join(searchRoot, "file.ts"), "utf8"));
  });

  it("fails closed on exact mismatch reasons", async () => {
    const root = workspace();
    const noMatch = await editBlockTool.run({
      path: "file.ts",
      search: "missing",
      replace: "answer",
    }, { workspace: root });
    expect(noMatch.ok).toBe(false);
    expect(noMatch.output).toEqual(expect.objectContaining({ reason: "no_match", expected: 1, found: 0 }));

    writeFileSync(join(root, "dupe.ts"), "item\nitem\n");
    const tooMany = await editBlockTool.run({
      path: "dupe.ts",
      search: "item",
      replace: "entry",
    }, { workspace: root });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.output).toEqual(expect.objectContaining({ reason: "too_many_matches", expected: 1, found: 2 }));

    const countMismatch = await editBlockTool.run({
      path: "dupe.ts",
      search: "item",
      replace: "entry",
      expectedCount: 3,
    }, { workspace: root });
    expect(countMismatch.ok).toBe(false);
    expect(countMismatch.output).toEqual(expect.objectContaining({ reason: "count_mismatch", expected: 3, found: 2 }));
    expect(readFileSync(join(root, "dupe.ts"), "utf8")).toBe("item\nitem\n");
  });

  it("recovers whitespace drift with fuzzy matching", async () => {
    const root = workspace();
    writeFileSync(join(root, "file.ts"), [
      "function greet() {",
      "  const name = \"Ada\";",
      "  return name;",
      "}",
      "",
    ].join("\n"));

    const result = await editBlockTool.run({
      path: "file.ts",
      search: "function greet() { const name = \"Ada\"; return name; }",
      replace: "function greet() {\n  return \"Ada\";\n}",
      matchPolicy: "fuzzy",
    }, { workspace: root });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      matchPolicy: "fuzzy",
      recoveredVia: "whitespace",
      confidence: 1,
    }));
    expect(readFileSync(join(root, "file.ts"), "utf8")).toContain("return \"Ada\";");
  });

  it("recovers nearby-context drift with high confidence", async () => {
    const root = workspace();
    writeFileSync(join(root, "file.ts"), [
      "function renderCard() {",
      "  const title = getTitle();",
      "  const subtitle = getSubtitle();",
      "  const theme = \"dark\";",
      "  const status = \"active\";",
      "  return { title, subtitle, theme, status };",
      "}",
      "",
    ].join("\n"));

    const result = await editBlockTool.run({
      path: "file.ts",
      search: [
        "function renderCard() {",
        "  const title = getTitle();",
        "  const subtitle = getSubtitle();",
        "  const theme = \"light\";",
        "  const status = \"active\";",
        "  return { title, subtitle, theme, status };",
        "}",
      ].join("\n"),
      replace: "function renderCard() {\n  return { title: getTitle(), subtitle: getSubtitle(), theme: \"light\", status: \"active\" };\n}",
      matchPolicy: "fuzzy",
    }, { workspace: root });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      matchPolicy: "fuzzy",
      recoveredVia: "nearby-context",
    }));
    expect(readFileSync(join(root, "file.ts"), "utf8")).toContain("theme: \"light\"");
  });

  it("fails closed on fuzzy multi-match, low-confidence, and binary targets", async () => {
    const root = workspace();
    writeFileSync(join(root, "multi.ts"), [
      "function same() { return 1; }",
      "function same() { return 1; }",
    ].join("\n"));
    const multi = await editBlockTool.run({
      path: "multi.ts",
      search: "function same() { return 1; }",
      replace: "function same() { return 2; }",
      matchPolicy: "fuzzy",
    }, { workspace: root });
    expect(multi.ok).toBe(false);
    expect(multi.output).toEqual(expect.objectContaining({ reason: "too_many_matches" }));

    writeFileSync(join(root, "low.ts"), [
      "function renderCard() {",
      "  const title = getTitle();",
      "  const subtitle = getSubtitle();",
      `  const payload = "${"x".repeat(240)}";`,
      "  const status = \"active\";",
      "  return { title, subtitle, payload, status };",
      "}",
    ].join("\n"));
    const low = await editBlockTool.run({
      path: "low.ts",
      search: [
        "function renderCard() {",
        "  const title = getTitle();",
        "  const subtitle = getSubtitle();",
        `  const payload = "${"y".repeat(240)}";`,
        "  const status = \"active\";",
        "  return { title, subtitle, payload, status };",
        "}",
      ].join("\n"),
      replace: "function renderCard() { return null; }",
      matchPolicy: "fuzzy",
    }, { workspace: root });
    expect(low.ok).toBe(false);
    expect(low.output).toEqual(expect.objectContaining({ reason: "low_confidence", candidateExcerpt: expect.any(String) }));

    expect(() => parseEditBlockInput({ path: "asset.pdf", search: "a", replace: "b", matchPolicy: "fuzzy" }, root)).toThrow("binary");
  });
});
