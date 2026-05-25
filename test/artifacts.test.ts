import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeCliArtifacts } from "../src/context/artifacts";

describe("materializeCliArtifacts", () => {
  it("copies caller artifacts into the workspace and preserves source labels", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-artifacts-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-artifacts-workspace-"));
    try {
      await mkdir(join(root, "ios"), { recursive: true });
      writeFileSync(join(root, "ios", "FastlaneSetup.md"), "fastlane setup\n");

      const context = materializeCliArtifacts({
        cwd,
        root,
        artifacts: ["ios/FastlaneSetup.md"],
        baseContext: { task: { kind: "coding" } },
      });

      expect(readFileSync(join(cwd, ".tanya", "artifacts", "ios", "FastlaneSetup.md"), "utf8")).toBe("fastlane setup\n");
      expect(context?.artifacts).toEqual([
        expect.objectContaining({
          path: ".tanya/artifacts/ios/FastlaneSetup.md",
          sourcePath: "ios/FastlaneSetup.md",
          status: "available",
        }),
      ]);
      expect(context?.expected_report).toEqual(expect.objectContaining({ artifact_reuse: true }));
      expect(context?.metadata).toEqual(expect.objectContaining({
        tanyaMaterializedContext: true,
        keepMaterializedContext: false,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("marks materialized context as preserved when keepContext is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-artifacts-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-artifacts-workspace-"));
    try {
      await mkdir(join(root, "ios"), { recursive: true });
      writeFileSync(join(root, "ios", "FastlaneSetup.md"), "fastlane setup\n");

      const context = materializeCliArtifacts({
        cwd,
        root,
        artifacts: ["ios/FastlaneSetup.md"],
        keepContext: true,
      });

      expect(context?.metadata).toEqual(expect.objectContaining({
        tanyaMaterializedContext: true,
        keepMaterializedContext: true,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("labels artifacts under an artifacts root with artifacts/ provenance", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tanya-artifacts-parent-"));
    const root = join(parent, "artifacts");
    const cwd = mkdtempSync(join(tmpdir(), "tanya-artifacts-workspace-"));
    try {
      await mkdir(join(root, "ios"), { recursive: true });
      writeFileSync(join(root, "ios", "FastlaneSetup.md"), "fastlane setup\n");

      const context = materializeCliArtifacts({
        cwd,
        root,
        artifacts: ["ios/FastlaneSetup.md"],
      });

      expect(context?.artifacts?.[0]?.sourcePath).toBe("artifacts/ios/FastlaneSetup.md");
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("materializes caller context files inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-context-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-context-workspace-"));
    try {
      await mkdir(join(root, "brand"), { recursive: true });
      const safetyPath = join(root, "brand", "safety.md");
      writeFileSync(safetyPath, "safety rules\n");

      const context = materializeCliArtifacts({
        cwd,
        artifacts: [],
        contextPaths: [safetyPath],
        baseContext: { task: { kind: "coding" } },
      });

      expect(readFileSync(join(cwd, ".tanya", "context", "brand", "safety.md"), "utf8")).toBe("safety rules\n");
      expect(context?.contextFiles?.[0]).toEqual(expect.objectContaining({
        path: ".tanya/context/brand/safety.md",
        sourcePath: safetyPath,
        status: "available",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
