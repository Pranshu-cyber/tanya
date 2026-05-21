import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTaskBriefTool,
  findReusableArtifactsTool,
  inspectProjectContextTool,
} from "../src/tools/projectContextTools";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-project-context-tools-"));
}

describe("project context tools", () => {
  it("finds reusable artifacts from an artifacts description index", async () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts/backend"), { recursive: true });
    mkdirSync(join(root, "artifacts/ios"), { recursive: true });
    writeFileSync(join(root, "artifacts/backend/HealthRoute.ts"), "export const GET = () => null;\n");
    writeFileSync(join(root, "artifacts/ios/SplashScreenPattern.swift"), "import SwiftUI\n");
    writeFileSync(join(root, "artifacts/description.md"), [
      "# Artifacts",
      "## Backend (`artifacts/backend/`)",
      "| File | What it solves | Use when |",
      "|------|----------------|----------|",
      "| `HealthRoute.ts` | Health endpoint with database readiness | Creating backend health checks |",
      "## iOS (`artifacts/ios/`)",
      "| File | What it solves | Use when |",
      "| `SplashScreenPattern.swift` | SwiftUI splash screen | Adding launch splash UI |",
      "",
    ].join("\n"));

    const result = await findReusableArtifactsTool.run(
      { query: "backend health endpoint", platform: "backend" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    const artifacts = (result.output as { artifacts: Array<{ path: string; description?: string }> }).artifacts;
    expect(artifacts[0]?.path).toBe("artifacts/backend/HealthRoute.ts");
    expect(artifacts[0]?.description).toContain("Health endpoint");
  });

  it("inspects project contracts, artifact indexes, scripts, and platform hints", async () => {
    const root = makeProject();
    mkdirSync(join(root, "brand"), { recursive: true });
    mkdirSync(join(root, "backend"), { recursive: true });
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# Demo\n");
    writeFileSync(join(root, "brand/api_features.md"), "- `GET /cases`\n");
    writeFileSync(join(root, "backend/API_FEATURES.md"), "- `GET /cases`\n");
    writeFileSync(join(root, "artifacts/description.md"), "# Artifact index\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "next build" } }));

    const result = await inspectProjectContextTool.run({}, { workspace: root });
    const output = result.output as {
      platforms: string[];
      packageScripts: Record<string, string>;
      contextFiles: Array<{ path: string; role: string; excerpt?: string | null }>;
      verification: string[];
    };

    expect(result.ok).toBe(true);
    expect(output.platforms).toContain("node");
    expect(output.packageScripts.typecheck).toBe("tsc --noEmit");
    expect(output.contextFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", role: "instruction" }),
      expect.objectContaining({ path: "brand/api_features.md", role: "project-contract" }),
      expect.objectContaining({ path: "backend/API_FEATURES.md", role: "api-contract" }),
      expect.objectContaining({ path: "artifacts/description.md", role: "artifact-index" }),
    ]));
    expect(output.verification).toContain("npm run typecheck");
  });

  it("builds a task brief with signals, artifacts, tools, and verification hints", async () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts/android"), { recursive: true });
    writeFileSync(join(root, "gradlew"), "#!/bin/sh\n");
    writeFileSync(join(root, "settings.gradle.kts"), "pluginManagement {}\n");
    writeFileSync(join(root, "artifacts/android/RoomSetup.kt"), "package demo\n");
    writeFileSync(join(root, "artifacts/android/NavigationSetup.kt"), "package demo\n");
    writeFileSync(join(root, "artifacts/description.md"), [
      "# Artifacts",
      "## Android (`artifacts/android/`)",
      "| File | What it solves | Use when |",
      "| `RoomSetup.kt` | Room database foundation | Local persistence setup |",
      "| `NavigationSetup.kt` | Navigation Compose scaffold | App navigation setup |",
      "",
    ].join("\n"));

    const result = await buildTaskBriefTool.run(
      { task: "Set up Android foundation with Room and Navigation Compose" },
      { workspace: root },
    );
    const output = result.output as {
      signals: { platforms: string[]; domains: string[] };
      artifacts: Array<{ path: string }>;
      recommendedTools: string[];
      verification: string[];
    };

    expect(output.signals.platforms).toContain("android");
    expect(output.signals.domains).toContain("setup");
    expect(output.artifacts.map((artifact) => artifact.path)).toContain("artifacts/android/RoomSetup.kt");
    expect(output.recommendedTools).toContain("create_android_foundation");
    expect(output.verification).toContain("./gradlew assembleDebug --no-daemon");
  });

  it("does NOT recommend npm run prisma:generate for an iOS workspace just because the task mentions session/database/sync", async () => {
    // Regression: 2026-05-01 setup/1 incident — auth/setup prompts mention
    // "session", "database", or "sync" for context, which triggered the data
    // domain in inferTaskSignals. The brief then auto-recommended
    // `npm run prisma:generate` even though the iOS workspace has no
    // package.json. The agent ran it, failed, fell into a verify-blocker loop.
    // Now: prisma:generate is only recommended when the workspace actually has
    // that npm script.
    const root = makeProject();
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version:5.9\n");
    mkdirSync(join(root, "ios"), { recursive: true });
    writeFileSync(join(root, "ios/Project.xcodeproj"), ""); // sentinel for ios platform inference

    const result = await buildTaskBriefTool.run(
      { task: "Wire up sign-in with Apple session storage and database sync" },
      { workspace: root },
    );
    const output = result.output as { verification: string[] };
    expect(output.verification).not.toContain("npm run prisma:generate");
  });

  it("DOES recommend npm run prisma:generate when the workspace has that script", async () => {
    const root = makeProject();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { "prisma:generate": "prisma generate" } }),
    );
    const result = await buildTaskBriefTool.run(
      { task: "Add a Prisma model for orders" },
      { workspace: root },
    );
    const output = result.output as { verification: string[] };
    expect(output.verification).toContain("npm run prisma:generate");
  });

  it("recommends cargo build/test for a Rust CLI workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, "script/src"), { recursive: true });
    writeFileSync(join(root, "script/Cargo.toml"), "[package]\nname = \"demo-cli\"\nversion = \"0.1.0\"\n");
    writeFileSync(join(root, "script/src/main.rs"), "fn main() {}\n");
    const result = await buildTaskBriefTool.run(
      { task: "Bootstrap a CLI scaffold with clap" },
      { workspace: join(root, "script") },
    );
    const output = result.output as { verification: string[]; signals: { platforms: string[] } };
    expect(output.signals.platforms).toContain("script");
    expect(output.verification).toContain("cargo build --release");
    expect(output.verification).toContain("cargo test");
    expect(output.verification).not.toContain("npm run build");
  });

  it("recommends pytest + python -m build for a Python CLI workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, "script"), { recursive: true });
    writeFileSync(join(root, "script/pyproject.toml"), "[project]\nname = \"demo-cli\"\n");
    const result = await buildTaskBriefTool.run(
      { task: "Bootstrap a Python CLI scaffold with click" },
      { workspace: join(root, "script") },
    );
    const output = result.output as { verification: string[] };
    expect(output.verification).toContain("python -m pytest");
    expect(output.verification).toContain("python -m build");
  });

  it("recommends go build/test for a Go CLI workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, "script"), { recursive: true });
    writeFileSync(join(root, "script/go.mod"), "module demo\ngo 1.22\n");
    const result = await buildTaskBriefTool.run(
      { task: "Bootstrap a Go CLI scaffold with cobra" },
      { workspace: join(root, "script") },
    );
    const output = result.output as { verification: string[] };
    expect(output.verification).toContain("go build ./...");
    expect(output.verification).toContain("go test ./...");
  });

  it("keeps artifact candidates diverse for multi-platform tasks", async () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts/android"), { recursive: true });
    mkdirSync(join(root, "artifacts/backend"), { recursive: true });
    writeFileSync(join(root, "gradlew"), "#!/bin/sh\n");
    writeFileSync(join(root, "settings.gradle.kts"), "pluginManagement {}\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    writeFileSync(join(root, "artifacts/android/RoomSetup.kt"), "package demo\n");
    writeFileSync(join(root, "artifacts/android/NavigationSetup.kt"), "package demo\n");
    writeFileSync(join(root, "artifacts/backend/HealthRoute.ts"), "export async function GET() {}\n");
    writeFileSync(join(root, "artifacts/backend/PrismaBase.prisma"), "model User { id String @id }\n");
    writeFileSync(join(root, "artifacts/description.md"), [
      "# Artifacts",
      "## Android (`artifacts/android/`)",
      "| File | What it solves | Use when |",
      "| `RoomSetup.kt` | Room database foundation | Android local persistence setup |",
      "| `NavigationSetup.kt` | Navigation Compose scaffold | Android navigation setup |",
      "## Backend (`artifacts/backend/`)",
      "| File | What it solves | Use when |",
      "| `HealthRoute.ts` | Backend health endpoint | Backend API health route setup |",
      "| `PrismaBase.prisma` | Prisma database schema | Backend database setup |",
    ].join("\n"));

    const result = await buildTaskBriefTool.run(
      { task: "App Creator task: Android foundation with Room and backend API health route", maxArtifacts: 4 },
      { workspace: root },
    );
    const output = result.output as {
      signals: { platforms: string[] };
      artifacts: Array<{ path: string }>;
      capabilityPacks: Array<{ id: string }>;
    };
    const paths = output.artifacts.map((artifact) => artifact.path);

    expect(output.signals.platforms).toEqual(expect.arrayContaining(["android", "backend"]));
    expect(paths.some((path) => path.startsWith("artifacts/android/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("artifacts/backend/"))).toBe(true);
    expect(output.capabilityPacks.map((pack) => pack.id)).toEqual(expect.arrayContaining(["backend-api", "mobile-android"]));
  });
});
