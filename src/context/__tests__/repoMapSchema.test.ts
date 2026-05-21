import { describe, expect, it } from "vitest";
import { REPO_MAP_SCHEMA_VERSION, REPO_MAP_VERSION, assertRepoMap, validateRepoMap, type RepoMap } from "../repoMapSchema";

const validMap: RepoMap = {
  version: REPO_MAP_VERSION,
  workspace: "/tmp/workspace",
  generatedAt: "2026-05-16T12:00:00.000Z",
  schemaVersion: REPO_MAP_SCHEMA_VERSION,
  files: [{
    path: "src/index.ts",
    lang: "ts",
    parser: "tree-sitter",
    lastIndexed: "2026-05-16T12:00:00.000Z",
    size: 128,
    symbols: [
      { name: "main", kind: "function", line: 3 },
      { name: "Config", kind: "type", line: 8 },
    ],
    imports: [{ from: "./config", named: ["Config"] }],
    exports: ["main", "Config"],
  }],
};

describe("repo-map schema", () => {
  it("validates a complete repo-map", () => {
    const result = validateRepoMap(validMap);

    expect(result.ok).toBe(true);
    expect(assertRepoMap(validMap).files[0]?.symbols.map((symbol) => symbol.name)).toEqual(["main", "Config"]);
  });

  it("rejects missing required fields with pointer paths", () => {
    const result = validateRepoMap({
      version: REPO_MAP_VERSION,
      workspace: "/tmp/workspace",
      generatedAt: "2026-05-16T12:00:00.000Z",
      schemaVersion: REPO_MAP_SCHEMA_VERSION,
      files: [{ path: "src/index.ts", lang: "ts" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "/files/0/parser",
        "/files/0/lastIndexed",
        "/files/0/size",
        "/files/0/symbols",
        "/files/0/imports",
        "/files/0/exports",
      ]));
    }
  });

  it("rejects invalid lang and symbol kind values", () => {
    const result = validateRepoMap({
      ...validMap,
      files: [{
        ...validMap.files[0],
        lang: "ruby",
        symbols: [{ name: "main", kind: "module", line: 1 }],
      }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "/files/0/lang",
        "/files/0/symbols/0/kind",
      ]));
    }
  });

  it("keeps version and schemaVersion distinct", () => {
    const result = validateRepoMap({ ...validMap, version: 2, schemaVersion: 99 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain("/version");
  });
});
