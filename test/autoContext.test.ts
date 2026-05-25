import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAutoRunContext } from "../src/context/autoContext";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "tanya-auto-context-"));
}

describe("automatic run context", () => {
  it("injects a generic coding brief with verification, artifacts, and Obsidian context", async () => {
    const root = makeWorkspace();
    const vault = mkdtempSync(join(tmpdir(), "tanya-auto-context-vault-"));
    mkdirSync(join(root, "artifacts/backend"), { recursive: true });
    mkdirSync(join(root, "brand"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "next build" } }));
    writeFileSync(join(root, "brand/api_features.md"), "- `GET /api/health`\n");
    writeFileSync(join(root, "artifacts/backend/HealthRoute.ts"), "export async function GET() {}\n");
    writeFileSync(join(root, "artifacts/description.md"), [
      "# Artifacts",
      "## Backend (`artifacts/backend/`)",
      "| File | What it solves | Use when |",
      "|------|----------------|----------|",
      "| `HealthRoute.ts` | Backend health API route | Creating backend API health endpoints |",
    ].join("\n"));
    writeFileSync(join(vault, "Backend Decisions.md"), "# Backend Decisions\nHealth endpoints should verify database readiness.\n");

    const context = await buildAutoRunContext({
      cwd: root,
      prompt: "Build backend API health route with database readiness",
      obsidianVault: vault,
    });

    expect(context?.task?.kind).toBe("coding");
    expect(context?.expected_report?.verification).toBe(true);
    expect(context?.expected_report?.artifact_reuse).toBe(true);
    expect(context?.expected_report?.context_review).toBe(true);
    expect(context?.verification?.commands).toContain("npm run typecheck");
    expect(context?.metadata?.autoBrief).toEqual(expect.objectContaining({
      signals: expect.objectContaining({
        platforms: expect.arrayContaining(["backend"]),
        domains: expect.arrayContaining(["api-contract", "data"]),
      }),
    }));
    expect(context?.metadata?.autoBriefEnforceArtifacts).toBe(true);
    expect(context?.metadata?.tanyaMaterializedContext).toBe(true);
    expect(context?.contextFiles?.some((file) => file.path.startsWith(".tanya/context/obsidian/"))).toBe(true);
  });

  it("keeps non-coding prompts out of coding validation when only a brief is generated", async () => {
    const root = makeWorkspace();
    writeFileSync(join(root, "README.md"), "# Demo\n");

    const context = await buildAutoRunContext({
      cwd: root,
      prompt: "Refresh the README wording",
    });

    expect(context?.task?.kind).toBeUndefined();
    expect(context?.expected_report).toBeUndefined();
    expect(context?.metadata?.autoBrief).toBeDefined();
    expect(context?.metadata?.tanyaMaterializedContext).toBe(false);
  });

  it("returns the original context when automatic sources are disabled", async () => {
    const root = makeWorkspace();

    const context = await buildAutoRunContext({
      cwd: root,
      prompt: "Say hello",
      enableBrief: false,
      enableObsidian: false,
    });

    expect(context).toBeUndefined();
  });
});
