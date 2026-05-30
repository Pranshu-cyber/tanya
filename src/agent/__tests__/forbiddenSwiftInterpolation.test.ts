import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanForbiddenPatterns } from "../forbiddenPatterns";

describe("swift-escaped-string-interpolation forbidden pattern", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tanya-swift-interp-"));
    await mkdir(join(workspace, "Sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function write(rel: string, content: string): Promise<void> {
    await writeFile(join(workspace, rel), content, "utf8");
  }

  it("flags a doubled-backslash interpolation (renders literal \\(n))", async () => {
    // Two real backslashes on disk before (n) — the calculator bug.
    await write("Sources/Keypad.swift", 'Button("\\\\(n)") { tap(n) }');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Keypad.swift"]);
    expect(issues.map((i) => i.id)).toContain("swift-escaped-string-interpolation");
  });

  it("does NOT flag correct single-backslash interpolation", async () => {
    await write("Sources/Keypad.swift", 'Button("\\(n)") { tap(n) }');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Keypad.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-string-interpolation");
  });

  it("does NOT flag unrelated escapes like \\\\d regexes", async () => {
    await write("Sources/Regex.swift", 'let digits = "\\\\d+"');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/Regex.swift"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-string-interpolation");
  });

  it("ignores non-swift files", async () => {
    await write("Sources/notes.txt", 'Button("\\\\(n)")');
    const issues = await scanForbiddenPatterns(workspace, ["Sources/notes.txt"]);
    expect(issues.map((i) => i.id)).not.toContain("swift-escaped-string-interpolation");
  });
});
