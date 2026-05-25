import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArtifactIndexBlock, buildContextBlock, buildExportMap, loadWorkspaceSummary } from "../src/context/loader";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-context-"));
}

describe("workspace context bootstrap", () => {
  it("detects node projects, package scripts, instructions, and bounded tree", () => {
    const root = makeProject();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", build: "tsup" } }, null, 2),
    );
    writeFileSync(join(root, "README.md"), "# Demo\n\nUse carefully.");
    writeFileSync(join(root, "src", "index.ts"), "export const ok = true;\n");
    writeFileSync(join(root, "node_modules", "ignored.js"), "ignored\n");

    const summary = loadWorkspaceSummary(root);

    expect(summary.projectTypes).toEqual(["node"]);
    expect(summary.packageScripts).toEqual({ test: "vitest run", build: "tsup" });
    expect(summary.instructionReads.map((item) => item.path)).toContain("README.md");
    expect(summary.tree).toContain("src/");
    expect(summary.tree).toContain("src/index.ts");
    expect(summary.tree.some((entry) => entry.includes("node_modules"))).toBe(false);
  });

  it("loads .tanya/INSTRUCTIONS.md as an instruction source", () => {
    const root = makeProject();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }));
    mkdirSync(join(root, ".tanya"));
    writeFileSync(join(root, ".tanya", "INSTRUCTIONS.md"), "Always run the verifier.\n");

    const summary = loadWorkspaceSummary(root);

    expect(summary.instructionReads.map((item) => item.path)).toContain(".tanya/INSTRUCTIONS.md");
  });

  it("renders a useful context block for non-git folders", () => {
    const root = makeProject();
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"demo\"\n");
    writeFileSync(join(root, "TANYA.md"), "Prefer small changes.\n");

    const block = buildContextBlock(root);

    expect(block).toContain("## Workspace Context");
    expect(block).toContain("Git repo: no");
    expect(block).toContain("Project type: python");
    expect(block).toContain("--- TANYA.md ---");
    expect(block).toContain("Prefer small changes.");
  });

  it("detects mobile verification profiles", () => {
    const ios = makeProject();
    mkdirSync(join(ios, "Demo.xcodeproj"));
    const iosBlock = buildContextBlock(ios);
    expect(iosBlock).toContain("Project type: ios");
    expect(iosBlock).toContain("xcodebuild -list");

    const android = makeProject();
    writeFileSync(join(android, "gradlew"), "#!/bin/sh\n");
    writeFileSync(join(android, "settings.gradle.kts"), "pluginManagement {}\n");
    const androidBlock = buildContextBlock(android);
    expect(androidBlock).toContain("Project type: android");
    expect(androidBlock).toContain("./gradlew test");
  });

  it("builds a bounded TypeScript export map", () => {
    const root = makeProject();
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    mkdirSync(join(root, "src", "app", "api", "users"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "auth.ts"), [
      "export function verifyJwt() {}",
      "export class AuthError extends Error {}",
      "export default prisma",
    ].join("\n"));
    writeFileSync(join(root, "src", "app", "api", "users", "route.ts"), [
      "export const GET = () => null",
      "export default function handler() {}",
    ].join("\n"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "ignored.ts"), "export const ignored = true;\n");

    const block = buildExportMap(root);

    expect(block).toContain("## Workspace export map");
    expect(block).toContain("src/lib/auth.ts: verifyJwt, AuthError, prisma (default)");
    expect(block).toContain("src/app/api/users/route.ts: GET, handler (default)");
    expect(block).not.toContain("ignored");
  });

  it("builds a task-ranked artifact index with mandatory rules", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "android"), { recursive: true });
    mkdirSync(join(root, "artifacts", "backend"), { recursive: true });
    writeFileSync(join(root, "artifacts", "RULES.md"), "Always read the selected artifact before adapting it.\n");
    writeFileSync(join(root, "artifacts", "description.md"), "# Artifact catalog\nUse reusable patterns.\n");
    writeFileSync(join(root, "artifacts", "android", "RoomSetup.kt"), "package demo\n");
    writeFileSync(join(root, "artifacts", "backend", "HealthRoute.ts"), "export const GET = () => null;\n");

    const block = buildArtifactIndexBlock(root, "Android Room foundation setup");
    const androidIndex = block.indexOf("artifacts/android/");
    const backendIndex = block.indexOf("artifacts/backend/");

    expect(block).toContain("## Artifact Index");
    expect(block).toContain("### Mandatory Artifact Rules (artifacts/RULES.md)");
    expect(block).toContain("Always read the selected artifact before adapting it.");
    expect(block).toContain("### artifacts/description.md");
    expect(block).toContain("artifacts/android/RoomSetup.kt");
    expect(androidIndex).toBeGreaterThan(-1);
    expect(backendIndex).toBeGreaterThan(-1);
    expect(androidIndex).toBeLessThan(backendIndex);
  });

  it("prefers mandatory rules from artifacts/prompts/RULES.md when present", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "prompts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "prompts", "RULES.md"), "Prompts rules are mandatory.\n");
    writeFileSync(join(root, "artifacts", "RULES.md"), "Root rules fallback.\n");

    const block = buildArtifactIndexBlock(root, "prompt setup");

    expect(block).toContain("### Mandatory Artifact Rules (artifacts/prompts/RULES.md)");
    expect(block).toContain("Prompts rules are mandatory.");
    expect(block).not.toContain("Root rules fallback.");
  });

  it("pre-reads markdown artifact content only when the task hint matches", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "ios"), { recursive: true });
    mkdirSync(join(root, "artifacts", "backend"), { recursive: true });
    writeFileSync(join(root, "artifacts", "ios", "FastlaneSetup.md"), "ios fastlane lane pattern\n");
    writeFileSync(join(root, "artifacts", "backend", "PrismaBase.md"), "backend prisma pattern\n");

    const matchedBlock = buildArtifactIndexBlock(root, "add fastlane ios deploy lane");
    const unmatchedBlock = buildArtifactIndexBlock(root);

    expect(matchedBlock).toContain("### Pre-read artifact files (apply these patterns before implementing)");
    expect(matchedBlock).toContain("#### artifacts/ios/FastlaneSetup.md");
    expect(matchedBlock).toContain("ios fastlane lane pattern");
    expect(matchedBlock).not.toContain("backend prisma pattern");
    expect(unmatchedBlock).not.toContain("### Pre-read artifact files");
    expect(unmatchedBlock).not.toContain("ios fastlane lane pattern");
  });
});
