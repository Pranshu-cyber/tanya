import { describe, expect, it } from "vitest";
import { buildRunContextBlock, normalizeRunContext } from "../src/context/runContext";

describe("run context", () => {
  it("normalizes generic caller context", () => {
    const context = normalizeRunContext({
      task: { kind: "coding", title: "Patch README" },
      artifacts: [{ path: ".tanya/artifacts/example.md", sourcePath: "artifacts/example.md", role: "source-pattern", status: "available" }],
      instructions: ["Read artifacts first."],
      verification: { commands: ["npm test"] },
      languages: ["swift"],
      frameworks: ["swiftdata"],
      stack: "ios-reference",
      expected_report: { modified_files: true },
      metadata: { caller: "opaque" },
    });

    expect(context.task?.kind).toBe("coding");
    expect(context.artifacts?.[0]?.path).toBe(".tanya/artifacts/example.md");
    expect(context.artifacts?.[0]?.sourcePath).toBe("artifacts/example.md");
    expect(context.verification?.commands).toEqual(["npm test"]);
    expect(context.languages).toEqual(["swift"]);
    expect(context.frameworks).toEqual(["swiftdata"]);
    expect(context.stack).toBe("ios-reference");
  });

  it("renders without product-specific assumptions", () => {
    const block = buildRunContextBlock({
      task: { kind: "coding", title: "Patch README" },
      artifacts: [{ path: "artifacts/example.md", reason: "Use this pattern." }],
      instructions: ["Use apply_patch."],
    });

    expect(block).toContain("## Caller Context");
    expect(block).toContain("artifacts/example.md");
    expect(block).toContain("Treat caller metadata as opaque labels");
    expect(block).not.toContain("CosmoHQ");
  });

  it("renders skill-pack hints when supplied by the caller", () => {
    const block = buildRunContextBlock({
      languages: ["go"],
      frameworks: ["huma-sqlc"],
      stack: "backend-go-huma",
    });

    expect(block).toContain("Skill-pack hints:");
    expect(block).toContain("Languages: go");
    expect(block).toContain("Frameworks: huma-sqlc");
    expect(block).toContain("Stack: backend-go-huma");
  });

  it("renders automatic task briefs as generic context", () => {
    const block = buildRunContextBlock({
      metadata: {
        autoBrief: {
          signals: { platforms: ["android"], domains: ["setup"] },
          contextFiles: [{ path: "README.md", role: "instruction" }],
          artifacts: [{ path: "artifacts/android/RoomSetup.kt", description: "Room setup pattern" }],
          capabilityPacks: [{ id: "mobile-android", reason: "Android project work" }],
          recommendedTools: ["inspect_project_context", "create_android_foundation"],
          verification: ["./gradlew assembleDebug --no-daemon"],
          cautions: ["Read project contracts before editing."],
        },
      },
    });

    expect(block).toContain("Auto task brief:");
    expect(block).toContain("Platforms: android");
    expect(block).toContain("artifacts/android/RoomSetup.kt");
    expect(block).toContain("mobile-android");
    expect(block).not.toContain("CosmoHQ");
  });
});
