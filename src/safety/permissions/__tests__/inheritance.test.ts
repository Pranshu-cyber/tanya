import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { childRunId, resolveSubAgentWorkspace, runIdDepth } from "../../../agent/subAgentContext";
import { decide, type PermissionContext } from "../engine";
import { mergeInheritedPermissionRules } from "../rules";
import type { PermissionRulesConfig } from "../schema";

function rules(partial: Partial<PermissionRulesConfig> = {}): PermissionRulesConfig {
  return {
    version: 1,
    mode: "default",
    alwaysAllow: [],
    alwaysDeny: [],
    alwaysAsk: [],
    pathRules: [],
    spendRules: [],
    ...partial,
  };
}

function ctx(partial: Partial<PermissionContext> = {}): PermissionContext {
  return {
    mode: "default",
    rules: rules(),
    runId: "r-parent.t-1",
    cwd: "/workspace",
    ...partial,
  };
}

describe("sub-agent permission inheritance", () => {
  it("lets children tighten by adding deny rules", () => {
    const inherited = mergeInheritedPermissionRules(
      rules({ alwaysAllow: ["read_file:.*"] }),
      rules({ alwaysDeny: ["run_shell:.*rm -rf.*"] }),
    );

    expect(inherited.warnings).toEqual([]);
    expect(decide("run_shell", { script: "rm -rf build" }, ctx({ rules: inherited.rules })).decision).toBe("deny");
    expect(decide("read_file", { path: "package.json" }, ctx({ rules: inherited.rules })).decision).toBe("allow");
  });

  it("silently demotes child allow rules that overlap inherited deny rules", () => {
    const inherited = mergeInheritedPermissionRules(
      rules({ alwaysDeny: ["run_shell:.*rm -rf.*"] }),
      rules({ alwaysAllow: ["run_shell:.*rm -rf.*"] }),
    );

    expect(inherited.rules.alwaysAllow).not.toContain("run_shell:.*rm -rf.*");
    expect(inherited.warnings).toContainEqual(expect.objectContaining({ field: "alwaysAllow" }));
    expect(decide("run_shell", { script: "rm -rf build" }, ctx({ rules: inherited.rules })).decision).toBe("deny");
  });

  it("silently demotes child allow rules that overlap inherited ask rules", () => {
    const inherited = mergeInheritedPermissionRules(
      rules({ alwaysAsk: ["write_file:.*secrets.*"] }),
      rules({ alwaysAllow: ["write_file:.*secrets.*"] }),
    );

    expect(inherited.rules.alwaysAllow).not.toContain("write_file:.*secrets.*");
    expect(decide("write_file", { path: "secrets.txt", content: "x" }, ctx({ rules: inherited.rules })).decision).toBe("ask");
  });

  it("keeps inherited path denials ahead of child path allows", () => {
    const inherited = mergeInheritedPermissionRules(
      rules({ pathRules: [{ glob: "src/private/**", action: "deny" }] }),
      rules({ pathRules: [{ glob: "src/private/**", action: "allow" }] }),
    );

    expect(inherited.rules.pathRules).toEqual([{ glob: "src/private/**", action: "deny" }]);
    expect(inherited.warnings).toContainEqual(expect.objectContaining({ field: "pathRules" }));
    expect(decide("write_file", { path: "src/private/key.ts", content: "x" }, ctx({ rules: inherited.rules })).decision).toBe("deny");
  });

  it("prevents child mode from loosening the parent mode", () => {
    const inherited = mergeInheritedPermissionRules(
      rules({ mode: "ask" }),
      rules({ mode: "bypass", alwaysAllow: ["run_shell:.*"] }),
    );

    expect(inherited.rules.mode).toBe("ask");
    expect(inherited.warnings).toContainEqual(expect.objectContaining({ field: "mode" }));
  });

  it("rejects child workspaces that escape the parent root and keeps dotted run depth sortable", () => {
    const parent = mkdtempSync(join(tmpdir(), "tanya-m4-parent-"));
    mkdirSync(join(parent, "pkg"));

    expect(resolveSubAgentWorkspace(parent, "pkg")).toBe(realpathSync(join(parent, "pkg")));
    expect(() => resolveSubAgentWorkspace(parent, "../outside")).toThrow(/escapes parent workspace/);
    expect(childRunId("r-root", 2)).toBe("r-root.t-2");
    expect(runIdDepth("r-root.t-1.t-1")).toBe(2);
  });
});
