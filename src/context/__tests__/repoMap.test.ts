import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRepoMap, repoMapCachePath, repoMapMetaPath } from "../repoMap";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-repo-map-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "pkg"), { recursive: true });
  mkdirSync(join(root, "ios"), { recursive: true });
  mkdirSync(join(root, "android"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), [
    "import { helper } from './helper';",
    "export function main() { return helper(); }",
    "export type Config = { enabled: boolean };",
  ].join("\n"));
  writeFileSync(join(root, "src/helper.js"), [
    "const fs = require('fs');",
    "export class Helper {}",
    "export const helper = () => fs.existsSync('.');",
  ].join("\n"));
  writeFileSync(join(root, "pkg/app.py"), [
    "from pathlib import Path",
    "class Service:",
    "    def run(self):",
    "        return Path('.')",
    "def build_service():",
    "    return Service()",
  ].join("\n"));
  writeFileSync(join(root, "pkg/main.go"), [
    "package pkg",
    "import \"fmt\"",
    "type Runner struct{}",
    "func Execute() { fmt.Println(\"ok\") }",
  ].join("\n"));
  writeFileSync(join(root, "ios/App.swift"), [
    "import SwiftUI",
    "struct RootView {",
    "  func render() {}",
    "}",
  ].join("\n"));
  writeFileSync(join(root, "android/Main.kt"), [
    "package app",
    "import kotlin.String",
    "class MainActivity",
    "fun launch() = Unit",
  ].join("\n"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/generated.ts"), "export function shouldSkip() {}\n");
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/index.js"), "export function shouldSkipToo() {}\n");
  writeFileSync(join(root, "src/huge.ts"), "x".repeat(1024));
  return root;
}

describe("repo-map indexer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds stable ripgrep-backed maps across supported languages", async () => {
    const root = fixture();
    const map = await buildRepoMap(root, {
      now: new Date("2026-05-16T12:00:00.000Z"),
      maxFileBytes: 500,
    });

    expect(map.files.map((file) => file.path)).toEqual([
      "android/Main.kt",
      "ios/App.swift",
      "pkg/app.py",
      "pkg/main.go",
      "src/helper.js",
      "src/index.ts",
    ]);
    expect(map.files.every((file) => file.parser === "ripgrep")).toBe(true);
    expect(map.files.find((file) => file.lang === "ts")?.symbols.map((symbol) => symbol.name)).toEqual(["main", "Config"]);
    expect(map.files.find((file) => file.lang === "py")?.symbols.map((symbol) => symbol.name)).toEqual(["Service", "run", "build_service"]);
    expect(map.files.find((file) => file.lang === "go")?.imports).toEqual([{ from: "fmt" }]);
    expect(map.files.find((file) => file.lang === "swift")?.imports).toEqual([{ from: "SwiftUI" }]);
    expect(map.files.find((file) => file.lang === "kt")?.symbols.map((symbol) => symbol.name)).toEqual(["MainActivity", "launch"]);
  });

  it("honors the max file bytes env with TANYA env", async () => {
    const root = fixture();
    vi.stubEnv("TANYA_REPO_MAP_MAX_FILE_BYTES", "10");
    const map = await buildRepoMap(root, { now: new Date("2026-05-16T12:00:00.000Z") });

    expect(map.files).toEqual([]);
  });

  it("reuses unchanged cached entries and re-indexes changed files only", async () => {
    const root = fixture();
    const first = await buildRepoMap(root, {
      writeCache: true,
      headSha: "same-head",
      now: new Date("2026-05-16T12:00:00.000Z"),
      maxFileBytes: 500,
    });
    const originalHelper = first.files.find((file) => file.path === "src/helper.js");
    expect(originalHelper).toBeDefined();

    const changedPath = join(root, "src", "index.ts");
    writeFileSync(changedPath, [
      "import { helper } from './helper';",
      "export function renamedMain() { return helper(); }",
    ].join("\n"));
    const future = new Date("2026-05-16T12:10:00.000Z");
    utimesSync(changedPath, future, future);

    const second = await buildRepoMap(root, {
      writeCache: true,
      headSha: "same-head",
      now: new Date("2026-05-16T12:10:00.000Z"),
      maxFileBytes: 500,
    });

    expect(second.files.find((file) => file.path === "src/helper.js")).toEqual(originalHelper);
    expect(second.files.find((file) => file.path === "src/index.ts")?.symbols.map((symbol) => symbol.name)).toEqual(["renamedMain"]);
  });

  it("fully rebuilds on branch changes and schema-version mismatches", async () => {
    const root = fixture();
    const first = await buildRepoMap(root, {
      writeCache: true,
      headSha: "head-a",
      now: new Date("2026-05-16T12:00:00.000Z"),
      maxFileBytes: 500,
    });
    const corrupt = {
      ...first,
      files: first.files.map((file) => file.path === "src/index.ts"
        ? { ...file, symbols: [{ name: "staleBranchSymbol", kind: "function", line: 1 }] }
        : file),
    };
    writeFileSync(repoMapCachePath(root), `${JSON.stringify(corrupt, null, 2)}\n`);
    writeFileSync(repoMapMetaPath(root), `${JSON.stringify({ headSha: "head-a", schemaVersion: first.schemaVersion, generatedAt: first.generatedAt }, null, 2)}\n`);

    const branchChanged = await buildRepoMap(root, {
      writeCache: true,
      headSha: "head-b",
      now: new Date("2026-05-16T12:05:00.000Z"),
      maxFileBytes: 500,
    });
    expect(JSON.stringify(branchChanged)).not.toContain("staleBranchSymbol");

    const staleSchema = JSON.parse(readFileSync(repoMapCachePath(root), "utf8"));
    staleSchema.schemaVersion = 999;
    staleSchema.files[0].symbols = [{ name: "staleSchemaSymbol", kind: "function", line: 1 }];
    writeFileSync(repoMapCachePath(root), `${JSON.stringify(staleSchema, null, 2)}\n`);
    writeFileSync(repoMapMetaPath(root), `${JSON.stringify({ headSha: "head-b", schemaVersion: 999, generatedAt: first.generatedAt }, null, 2)}\n`);

    const schemaChanged = await buildRepoMap(root, {
      writeCache: true,
      headSha: "head-b",
      now: new Date("2026-05-16T12:06:00.000Z"),
      maxFileBytes: 500,
    });
    expect(JSON.stringify(schemaChanged)).not.toContain("staleSchemaSymbol");
  });
});
