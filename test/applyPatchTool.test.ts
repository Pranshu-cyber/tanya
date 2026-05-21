import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchTool } from "../src/tools/fsTools";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-patch-"));
}

describe("apply_patch tool", () => {
  it("applies a unified diff and reports changed files", async () => {
    const root = makeProject();
    writeFileSync(join(root, "README.md"), "before\n");

    const result = await applyPatchTool.run(
      {
        patch: [
          "--- README.md",
          "+++ README.md",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
      },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["README.md"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("after\n");
  });

  it("removes patch backup files created by platform patch implementations", async () => {
    const root = makeProject();
    writeFileSync(join(root, "README.md"), "before\n");
    writeFileSync(join(root, "README.md.orig"), "before\n");

    const result = await applyPatchTool.run(
      {
        patch: [
          "--- README.md",
          "+++ README.md",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
      },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Removed patch backup file");
    expect(existsSync(join(root, "README.md.orig"))).toBe(false);
  });

  it("rejects patches that escape the workspace", async () => {
    const root = makeProject();
    const result = await applyPatchTool.run(
      {
        patch: [
          "--- ../outside.txt",
          "+++ ../outside.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
        stripLevel: 0,
      },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("escapes workspace");
  });

  it("rejects patches that modify Android local.properties", async () => {
    const root = makeProject();
    writeFileSync(join(root, "local.properties"), "sdk.dir=/tmp/android\n");

    const result = await applyPatchTool.run(
      {
        patch: [
          "--- local.properties",
          "+++ local.properties",
          "@@ -1 +1 @@",
          "-sdk.dir=/tmp/android",
          "+sdk.dir=/Users/example/Library/Android/sdk",
          "",
        ].join("\n"),
      },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ANDROID_HOME");
  });
});
