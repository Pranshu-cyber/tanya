import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTaskToVault } from "../src/obsidian/vaultAppender";
import { materializeObsidianContext, searchObsidianNotes } from "../src/obsidian/search";
import type { TanyaFinalManifest } from "../src/agent/runner";

function todayNoteName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}.md`;
}

function manifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
  return {
    schemaVersion: 1,
    changedFiles: ["src/App.swift"],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: ["Verification: npm test -> passed"],
    git: {
      root: "/tmp/project",
      head: "abc1234",
    },
    toolErrors: 0,
    blockers: [],
    ...overrides,
  };
}

describe("appendTaskToVault", () => {
  it("creates today's daily note and appends a task section", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tanya-obsidian-"));

    await appendTaskToVault(vault, manifest(), {
      task: {
        title: "Build splash screen",
      },
    });

    const content = readFileSync(join(vault, todayNoteName()), "utf8");
    expect(content).toContain("## Build splash screen");
    expect(content).toContain("- Outcome: passed");
    expect(content).toContain("- Git HEAD: abc1234");
    expect(content).toContain("- src/App.swift");
    expect(content).toContain("- Verification: npm test -> passed");
  });

  it("marks blocked outcomes when blockers are present", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tanya-obsidian-"));

    await appendTaskToVault(vault, manifest({ blockers: ["xcodebuild failed"] }));

    const content = readFileSync(join(vault, todayNoteName()), "utf8");
    expect(content).toContain("## Tanya task");
    expect(content).toContain("- Outcome: blocked");
  });
});

describe("Obsidian search", () => {
  it("searches notes, redacts likely secrets, and materializes excerpts", async () => {
    const vault = mkdtempSync(join(tmpdir(), "tanya-obsidian-vault-"));
    const workspace = mkdtempSync(join(tmpdir(), "tanya-obsidian-workspace-"));
    mkdirSync(join(vault, "CosmoHQ"), { recursive: true });
    writeFileSync(join(vault, "CosmoHQ/App Creator V2.md"), [
      "# App Creator V2 daily context",
      "Use Android foundation artifacts for Room and Navigation tasks.",
      "API_TOKEN=sk_live_1234567890abcdef1234567890",
    ].join("\n"));
    writeFileSync(join(vault, "Unrelated.md"), "# Garden notes\nNothing about coding.\n");

    const results = await searchObsidianNotes({
      vaultPath: vault,
      query: "App Creator V2 Android foundation",
      maxResults: 3,
    });

    expect(results[0]?.path).toBe("CosmoHQ/App Creator V2.md");
    expect(results[0]?.excerpt).toContain("[redacted possible secret]");
    expect(results[0]?.excerpt).not.toContain("sk_live_1234567890abcdef1234567890");

    const materialized = await materializeObsidianContext({
      workspace,
      vaultPath: vault,
      query: "App Creator V2 Android foundation",
      maxResults: 1,
    });

    expect(materialized.contextFiles[0]?.path).toBe(".tanya/context/obsidian/CosmoHQ/App_Creator_V2.md");
    const content = readFileSync(join(workspace, materialized.contextFiles[0]?.path ?? ""), "utf8");
    expect(content).toContain("Source: CosmoHQ/App Creator V2.md");
    expect(content).toContain("[redacted possible secret]");
  });
});
