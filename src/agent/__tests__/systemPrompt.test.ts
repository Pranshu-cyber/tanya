import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoMap } from "../../context/repoMap";
import { buildSystemPrompt, selectLiteSkillPacks } from "../systemPrompt";
import type { LoadedSkillPack } from "../../skills";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-lite-system-prompt-"));
}

function fakePack(slug: string): LoadedSkillPack {
  return {
    slug,
    title: slug,
    sourcePath: `/skills/${slug}.md`,
    content: `${slug} guidance`,
    tokens: 10,
    reason: slug.startsWith("failure-modes/") ? "always" : "workspace",
  };
}

describe("lite system prompt", () => {
  it("cuts representative coding prompt tokens by at least 60% while preserving workspace facts", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "backend"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    writeFileSync(join(root, "next.config.ts"), "export default {};\n");
    writeFileSync(join(root, "artifacts", "README.md"), "artifact guidance\n".repeat(900));
    writeFileSync(join(root, "artifacts", "backend", "ApiPattern.md"), "api pattern\n".repeat(900));
    const historyBlock = [
      "## Recent task history",
      ...Array.from({ length: 24 }, (_, index) => `- [2026-05-${String(index + 1).padStart(2, "0")}] PASSED: "${"history ".repeat(120)}" -> changed: src/file-${index}.ts`),
    ].join("\n");

    const full = buildSystemPrompt(root, {
      languages: ["typescript"],
      frameworks: ["nextjs"],
      stack: "nextjs-reference",
    }, historyBlock, "Refactor a Next.js page component");
    const lite = buildSystemPrompt(root, {
      languages: ["typescript"],
      frameworks: ["nextjs"],
      stack: "nextjs-reference",
    }, historyBlock, "Refactor a Next.js page component", { lite: true });

    expect(Math.ceil(lite.length / 4)).toBeLessThanOrEqual(Math.floor(Math.ceil(full.length / 4) * 0.4));
    expect(lite).toContain("## Workspace Context");
    expect(lite).toContain("package.json");
    expect(lite).not.toContain("## Artifact Index");
    expect((lite.match(/PASSED:/g) ?? [])).toHaveLength(1);
  });

  it("keeps artifact index in lite mode once artifact activity is recorded", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "README.md"), "artifact guidance\n");

    const lite = buildSystemPrompt(root, {
      metadata: { artifactsRead: ["artifacts/README.md"] },
    }, "", "Use the known artifact", { lite: true });

    expect(lite).toContain("## Artifact Index");
  });

  it("drops unmatched domain skill packs in lite mode but keeps failure, language, framework, and matched domain packs", () => {
    const selected = selectLiteSkillPacks([
      fakePack("failure-modes/verify-mode"),
      fakePack("lang/typescript"),
      fakePack("framework/nextjs-app-router"),
      fakePack("domain/auth-jwt"),
      fakePack("domain/stripe"),
      fakePack("domain/push-notifications"),
    ], "Fix auth token refresh in a Next.js route");

    expect(selected.map((pack) => pack.slug)).toEqual([
      "failure-modes/verify-mode",
      "lang/typescript",
      "framework/nextjs-app-router",
      "domain/auth-jwt",
    ]);
  });

  it("enforces provider prompt budgets by dropping optional sections in deterministic priority order", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "web"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    writeFileSync(join(root, "next.config.ts"), "export default {};\n");
    writeFileSync(join(root, "artifacts", "README.md"), "artifact guidance\n".repeat(1200));
    writeFileSync(join(root, "artifacts", "web", "Pattern.md"), "pattern\n".repeat(1200));
    const events: Array<{ droppedSections: string[]; totalTokens: number; cap: number }> = [];

    const prompt = buildSystemPrompt(root, {
      languages: ["typescript"],
      frameworks: ["nextjs"],
      stack: "nextjs-reference",
    }, "", "Build a Next.js settings page", {
      contextWindow: 32_000,
      promptBudgetRatio: 0.25,
      onPromptBudgetExceeded: (event) => events.push(event),
    });

    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(8_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.cap).toBe(8_000);
    expect(events[0]?.droppedSections.slice(0, 2)).toEqual(["failure-mode packs", "artifact index"]);
    expect(prompt).toContain("## Workspace Context");
  });

  it("adds cached repo-map context to lite prompts and drops it first under tight budgets", async () => {
    const root = makeProject();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "auth.ts"), [
      "export function verifySession() {",
      "  return true;",
      "}",
    ].join("\n"));
    await buildRepoMap(root, { writeCache: true });

    const lite = buildSystemPrompt(root, undefined, "", "Fix verifySession", { lite: true });
    expect(lite).toContain("## Repo Map (advisory)");
    expect(lite).toContain("src/auth.ts");

    const events: Array<{ droppedSections: string[]; totalTokens: number; cap: number }> = [];
    const tight = buildSystemPrompt(root, undefined, "", "Fix verifySession", {
      lite: true,
      contextWindow: 1_000,
      promptBudgetRatio: 0.1,
      onPromptBudgetExceeded: (event) => events.push(event),
    });

    expect(events[0]?.droppedSections[0]).toBe("repo-map");
    expect(tight).not.toContain("## Repo Map (advisory)");
  });
});
