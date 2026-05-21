import { describe, expect, it } from "vitest";
import { parsePermissionsJson, validatePermissionsConfig } from "../schema";

describe("permissions schema", () => {
  it("normalizes a valid permissions config", () => {
    const result = validatePermissionsConfig({
      version: 1,
      mode: "ask",
      alwaysDeny: ["run_shell:.*rm -rf.*"],
      alwaysAllow: ["read_file:.*"],
      alwaysAsk: ["write_file:.*\\.production\\.ts"],
      pathRules: [{ glob: "src/**", action: "ask" }],
      spendRules: [{ type: "spend", scope: "turn", max_usd: 0.05, action: "deny" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("ask");
      expect(result.value.alwaysDeny).toEqual(["run_shell:.*rm -rf.*"]);
      expect(result.value.spendRules[0]).toEqual({ type: "spend", scope: "turn", max_usd: 0.05, action: "deny" });
    }
  });

  it("defaults optional arrays and mode for minimal configs", () => {
    const result = validatePermissionsConfig({ version: 1 });

    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        mode: "bypass",
        alwaysAllow: [],
        alwaysDeny: [],
        alwaysAsk: [],
        pathRules: [],
        spendRules: [],
      },
      issues: [],
    });
  });

  it("rejects malformed fields with JSON-pointer-style paths", () => {
    const result = validatePermissionsConfig({
      version: 2,
      mode: "strict",
      alwaysDeny: ["missing-colon", "run_shell:["],
      pathRules: [{ glob: "", action: "block" }],
      spendRules: [{ type: "spend", scope: "day", action: "allow" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "$.version",
        "$.mode",
        "$.alwaysDeny[0]",
        "$.alwaysDeny[1]",
        "$.pathRules[0].glob",
        "$.pathRules[0].action",
        "$.spendRules[0].scope",
        "$.spendRules[0].action",
        "$.spendRules[0]",
      ]));
    }
  });

  it("reports JSON parse failures at the document root", () => {
    const result = parsePermissionsJson("{");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("$");
      expect(result.issues[0]?.message).toContain("Invalid JSON");
    }
  });
});
