import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInsideWorkspace, resolveWorkspace } from "../src/safety/workspace";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "tanya-workspace-safety-"));
}

describe("workspace safety", () => {
  it("rejects targets that traverse an existing symlinked parent outside the workspace", () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    try {
      mkdirSync(join(outside, "nested"), { recursive: true });
      symlinkSync(join(outside, "nested"), join(workspace, "linked-parent"));

      expect(() =>
        resolveInsideWorkspace(resolveWorkspace(workspace), "linked-parent/new-file.ts"),
      ).toThrow("Path escapes workspace via symlink");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows normal paths inside the workspace", () => {
    const workspace = makeWorkspace();
    try {
      writeFileSync(join(workspace, "local.ts"), "export const ok = true;\n");
      const resolvedWorkspace = resolveWorkspace(workspace);
      expect(resolveInsideWorkspace(resolvedWorkspace, "local.ts")).toBe(join(resolvedWorkspace, "local.ts"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
