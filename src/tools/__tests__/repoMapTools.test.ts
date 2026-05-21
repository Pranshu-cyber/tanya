import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoMap } from "../../context/repoMap";
import { inspectRepoMapTool } from "../repoMapTools";

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-repo-map-tool-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), [
    "export function verifySession() {",
    "  return true;",
    "}",
    "export class LoginController {}",
  ].join("\n"));
  writeFileSync(join(root, "src", "billing.py"), "def charge_card():\n    return True\n");
  return root;
}

describe("inspect_repo_map tool", () => {
  it("searches cached repo-map entries by symbol", async () => {
    const workspace = makeWorkspace();
    await buildRepoMap(workspace, { writeCache: true });

    const result = await inspectRepoMapTool.run({ symbol: "verifySession" }, { workspace });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("1 repo-map file entry");
    expect(JSON.stringify(result.output)).toContain("src/auth.ts");
    expect(JSON.stringify(result.output)).toContain("verifySession");
  });

  it("builds the cache on demand and filters by language", async () => {
    const workspace = makeWorkspace();

    const result = await inspectRepoMapTool.run({ lang: "py" }, { workspace });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("src/billing.py");
    expect(JSON.stringify(result.output)).not.toContain("src/auth.ts");
  });
});
