import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, inputShape, type PermissionContext } from "../engine";
import { loadPermissionRules, mergePermissionRules } from "../rules";
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
    runId: "run-1",
    cwd: "/workspace",
    ...partial,
  };
}

describe("permission engine", () => {
  it("matches rules against stable JSON input shapes", () => {
    expect(inputShape({ z: 1, script: "git status" })).toBe("\"script\":\"git status\",\"z\":1");
    expect(decide("run_shell", { script: "git status" }, ctx({
      rules: rules({ alwaysDeny: ["run_shell:.*git status.*"] }),
    }))).toMatchObject({ decision: "deny", matchedRule: "run_shell:.*git status.*" });
  });

  it("matches MCP namespace rules against server and tool names", () => {
    expect(decide("mcp:github:list_issues", { owner: "acme" }, ctx({
      rules: rules({ alwaysDeny: ["mcp:github:.*"] }),
    }))).toMatchObject({ decision: "deny", matchedRule: "mcp:github:.*" });

    expect(decide("mcp:linear:create_issue", { title: "bug" }, ctx({
      rules: rules({ alwaysAsk: ["mcp:linear:create_.*title.*bug.*"] }),
    }))).toMatchObject({ decision: "ask", matchedRule: "mcp:linear:create_.*title.*bug.*" });
  });

  it("uses deny over allow over ask precedence", () => {
    const context = ctx({
      rules: rules({
        alwaysDeny: ["run_shell:.*danger.*"],
        alwaysAllow: ["run_shell:.*danger.*", "run_shell:.*safe.*"],
        alwaysAsk: ["run_shell:.*danger.*", "run_shell:.*safe.*", "run_shell:.*maybe.*"],
      }),
    });

    expect(decide("run_shell", { script: "danger" }, context).decision).toBe("deny");
    expect(decide("run_shell", { script: "safe" }, context).decision).toBe("allow");
    expect(decide("run_shell", { script: "maybe" }, context).decision).toBe("ask");
  });

  it("checks path rules after command regex rules", () => {
    const context = ctx({
      rules: rules({
        alwaysAllow: ["write_file:.*production.*"],
        pathRules: [{ glob: "src/**/*.production.ts", action: "deny" }],
      }),
    });

    expect(decide("write_file", { path: "src/config.production.ts" }, context).decision).toBe("allow");
    expect(decide("write_file", { path: "src/nested/config.production.ts" }, ctx({
      rules: rules({ pathRules: [{ glob: "src/**/*.production.ts", action: "deny" }] }),
    }))).toMatchObject({ decision: "deny", reason: "pathRule" });
  });

  it("checks spend rules after path rules", () => {
    const context = ctx({
      rules: rules({
        pathRules: [{ glob: "src/**", action: "allow" }],
        spendRules: [{ type: "spend", scope: "turn", max_usd: 0.05, action: "deny" }],
      }),
      spendState: {
        turnTokens: 0,
        runTokens: 0,
        sessionTokens: 0,
        projectedTokens: 10,
        turnUsd: 0,
        runUsd: 0,
        sessionUsd: 0,
        projectedUsd: 0.10,
      },
    });

    expect(decide("write_file", { path: "src/app.ts" }, context).decision).toBe("allow");
    expect(decide("run_shell", { script: "npm test" }, context)).toMatchObject({
      decision: "deny",
      reason: "spendRule",
      projectedCostUsd: 0.10,
      thresholdUsd: 0.05,
    });
  });

  it("applies session-scoped spend rules from in-memory spend state", () => {
    expect(decide("run_shell", { script: "npm test" }, ctx({
      rules: rules({ spendRules: [{ type: "spend", scope: "session", max_tokens: 100, action: "ask" }] }),
      spendState: {
        turnTokens: 0,
        runTokens: 20,
        sessionTokens: 90,
        projectedTokens: 20,
        turnUsd: 0,
        runUsd: 0,
        sessionUsd: 0,
        projectedUsd: 0,
      },
    }))).toMatchObject({
      decision: "ask",
      reason: "spendRule",
      projectedTokens: 110,
      thresholdTokens: 100,
    });
  });

  it("denies paths outside the workspace unless a path rule opts out", () => {
    expect(decide("write_file", { path: "../outside.txt" }, ctx())).toMatchObject({
      decision: "deny",
      matchedRule: "path:<outside-workspace>",
      reason: "outsideWorkspace",
    });

    expect(decide("write_file", { path: "../outside.txt" }, ctx({
      rules: rules({ pathRules: [{ glob: "**/*", action: "allow" }] }),
    }))).toMatchObject({
      decision: "allow",
      matchedRule: "path:**/*",
      reason: "pathRule",
    });
  });

  it("implements all mode defaults", () => {
    expect(decide("run_shell", {}, ctx({ mode: "bypass" })).decision).toBe("allow");
    expect(decide("run_shell", {}, ctx({ mode: "default" })).decision).toBe("allow");
    expect(decide("run_shell", {}, ctx({ mode: "ask" })).decision).toBe("ask");
    expect(decide("run_shell", {}, ctx({ mode: "plan" }))).toMatchObject({ decision: "deny", reason: "plan-mode" });
  });

  it("lets parent context keep stricter inherited decisions", () => {
    const parentContext = ctx({
      rules: rules({ alwaysDeny: ["run_shell:.*rm -rf.*"] }),
    });
    const childContext = ctx({
      parentContext,
      rules: rules({ alwaysAllow: ["run_shell:.*rm -rf.*"] }),
    });

    expect(decide("run_shell", { script: "rm -rf build" }, childContext).decision).toBe("deny");
    expect(decide("run_shell", { script: "touch file" }, ctx({
      parentContext: ctx({ mode: "ask" }),
      rules: rules({ alwaysAllow: ["run_shell:.*touch.*"] }),
    })).decision).toBe("ask");
  });
});

describe("permission rules loading", () => {
  it("merges user and project rules with project precedence", () => {
    const home = mkdtempSync(join(tmpdir(), "tanya-permissions-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permissions-cwd-"));
    mkdirSync(join(home, ".tanya"), { recursive: true });
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(home, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "ask",
      alwaysAllow: ["read_file:.*"],
      alwaysDeny: ["run_shell:.*rm -rf.*"],
    }));
    writeFileSync(join(cwd, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "plan",
      alwaysAsk: ["write_file:.*"],
    }));

    const loaded = loadPermissionRules({ cwd, home });

    expect(loaded.issues).toEqual([]);
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.rules.mode).toBe("plan");
    expect(loaded.rules.alwaysAllow).toEqual(["read_file:.*"]);
    expect(loaded.rules.alwaysDeny).toEqual(["run_shell:.*rm -rf.*"]);
    expect(loaded.rules.alwaysAsk).toEqual(["write_file:.*"]);
  });

  it("supports override replacement during merge", () => {
    const merged = mergePermissionRules(
      rules({ alwaysAllow: ["read_file:.*"], alwaysDeny: ["run_shell:.*"] }),
      rules({ override: true, mode: "ask", alwaysAsk: ["write_file:.*"] }),
    );

    expect(merged.alwaysAllow).toEqual([]);
    expect(merged.alwaysDeny).toEqual([]);
    expect(merged.alwaysAsk).toEqual(["write_file:.*"]);
    expect(merged.mode).toBe("ask");
  });
});
