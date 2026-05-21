import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPostRunBlockers } from "../src/agent/postCheck";
import type { TanyaFinalManifest } from "../src/agent/runner";

function makeManifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
  return {
    schemaVersion: 1,
    changedFiles: [],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: [],
    git: { root: null, head: null },
    toolErrors: 0,
    blockers: [],
    ...overrides,
  };
}

function makeProject(): string {
  return mkdtempSync(join(process.cwd(), ".tmp-postcheck-"));
}

describe("detectPostRunBlockers", () => {
  it("detects TypeScript errors when no passing typecheck was reported", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, types: [] },
        files: ["src/bad.ts"],
      }));
      writeFileSync(join(root, "src", "bad.ts"), "export const value: string = 123;\n");

      const blockers = await detectPostRunBlockers(root, makeManifest());

      expect(blockers.some((blocker) => blocker.includes("TypeScript errors after run"))).toBe(true);
      expect(blockers.join("\n")).toContain("TS2322");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips TypeScript checks when a passing typecheck was already reported", async () => {
    const root = makeProject();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, types: [] },
        files: ["src/bad.ts"],
      }));
      writeFileSync(join(root, "src", "bad.ts"), "export const value: string = 123;\n");

      const blockers = await detectPostRunBlockers(root, makeManifest({
        verification: ["Verification: npm run typecheck -> passed"],
      }));

      expect(blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects failing npm test scripts when no passing test was reported", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        scripts: { test: "node -e \"process.exit(1)\"" },
      }));

      const blockers = await detectPostRunBlockers(root, makeManifest());

      expect(blockers).toContain("Tests failed after run (post-run check)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the workspace typecheck script over a raw tsc fallback", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: {
          typecheck: "node -e \"console.error('script typecheck failed'); process.exit(1)\"",
        },
      }));
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, types: [] },
        files: [],
      }));

      const blockers = await detectPostRunBlockers(root, makeManifest());

      expect(blockers).toContain("TypeScript compilation failed (post-run check)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
