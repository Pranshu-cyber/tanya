import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updatePlanTool } from "../planTool";
import { loadLedger } from "../../agent/taskLedger";
import type { ToolContext } from "../types";

describe("update_plan tool", () => {
  let workspace: string;
  const ctx = (): ToolContext => ({ workspace });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tanya-plan-tool-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("persists the plan and reports remaining count", async () => {
    const result = await updatePlanTool.run(
      {
        steps: [
          { text: "create Xcode project", status: "done" },
          { text: "wire calculator logic", status: "in_progress" },
          { text: "verify in simulator", status: "pending" },
        ],
      },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("3 steps");
    expect(result.summary).toContain("2 remaining");

    const ledger = await loadLedger(workspace);
    expect(ledger?.steps.map((s) => s.status)).toEqual(["done", "in_progress", "pending"]);
  });

  it("rejects a missing steps array", async () => {
    const result = await updatePlanTool.run({}, ctx());
    expect(result.ok).toBe(false);
  });

  it("rejects an all-empty plan", async () => {
    const result = await updatePlanTool.run({ steps: [{ text: "   " }] }, ctx());
    expect(result.ok).toBe(false);
  });

  it("is exposed in the default tool set", async () => {
    const { defaultTools } = await import("../fsTools");
    expect(defaultTools().some((t) => t.name === "update_plan")).toBe(true);
  });
});
