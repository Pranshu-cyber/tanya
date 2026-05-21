import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/systemPrompt";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-system-prompt-"));
}

describe("buildSystemPrompt", () => {
  it("injects project-level .tania instructions when present", () => {
    const root = makeProject();
    mkdirSync(join(root, ".tania"), { recursive: true });
    writeFileSync(join(root, ".tania", "INSTRUCTIONS.md"), "Always prefer deterministic project helpers.\n");

    const prompt = buildSystemPrompt(root);

    expect(prompt).toContain("## Project Instructions");
    expect(prompt).toContain("Always prefer deterministic project helpers.");
  });

  it("skips missing project-level instructions silently", () => {
    const prompt = buildSystemPrompt(makeProject());

    expect(prompt).not.toContain("## Project Instructions");
  });

  it("injects the artifact index between export map and workspace context using the task hint", () => {
    const root = makeProject();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "artifacts", "android"), { recursive: true });
    mkdirSync(join(root, "artifacts", "backend"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const ok = true;\n");
    writeFileSync(join(root, "artifacts", "RULES.md"), "Read artifacts first.\n");
    writeFileSync(join(root, "artifacts", "android", "RoomSetup.kt"), "package demo\n");
    writeFileSync(join(root, "artifacts", "backend", "HealthRoute.ts"), "export const GET = () => null;\n");

    const prompt = buildSystemPrompt(root, undefined, undefined, "Android Room setup");
    const exportIndex = prompt.indexOf("## Workspace export map");
    const artifactIndex = prompt.indexOf("## Artifact Index");
    const contextIndex = prompt.indexOf("## Workspace Context");

    expect(exportIndex).toBeGreaterThan(-1);
    expect(artifactIndex).toBeGreaterThan(exportIndex);
    expect(contextIndex).toBeGreaterThan(artifactIndex);
    expect(prompt).toContain("Task relevance hint: Android Room setup");
    expect(prompt).toContain("If pre-read artifact files appear in the system prompt under 'Pre-read artifact files'");
    const ranked = prompt.slice(prompt.indexOf("### Ranked Artifact Directories"));
    expect(ranked.indexOf("artifacts/android/")).toBeLessThan(ranked.indexOf("artifacts/backend/"));
  });
});
