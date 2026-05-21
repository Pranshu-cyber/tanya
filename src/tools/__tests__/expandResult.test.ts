import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCachedToolResult } from "../../memory/resultCache";
import { expandResultTool } from "../expandResult";

describe("expand_result", () => {
  it("returns full cached output or a byte range for the active run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-expand-result-"));
    writeCachedToolResult(workspace, "run-1", "call-1", "abcdef");

    await expect(expandResultTool.run(
      { tool_call_id: "call-1" },
      { workspace, runId: "run-1" },
    )).resolves.toMatchObject({
      ok: true,
      output: "abcdef",
    });

    await expect(expandResultTool.run(
      { tool_call_id: "call-1", range: { startByte: 2, endByte: 5 } },
      { workspace, runId: "run-1" },
    )).resolves.toMatchObject({
      ok: true,
      output: "cde",
    });
  });

  it("fails clearly when no run id or cache entry is available", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-expand-missing-"));

    await expect(expandResultTool.run(
      { tool_call_id: "call-1" },
      { workspace },
    )).resolves.toMatchObject({ ok: false, summary: "No run id available for result expansion." });

    await expect(expandResultTool.run(
      { tool_call_id: "missing" },
      { workspace, runId: "run-1" },
    )).resolves.toMatchObject({ ok: false, summary: "No cached result found for missing." });
  });
});
