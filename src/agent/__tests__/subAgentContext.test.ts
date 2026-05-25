import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditDecisions } from "../../memory/auditLog";
import type { ChatProvider, ToolCall } from "../../providers/types";
import { DEFAULT_PERMISSION_RULES } from "../../safety/permissions/schema";
import { runAgent } from "../runner";

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

describe("sub-agent run context propagation", () => {
  it("uses dotted child run ids and audits parentRunId for inherited permission decisions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-m4-child-run-"));
    writeFileSync(join(cwd, "package.json"), "{}");
    let requestCount = 0;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        requestCount += 1;
        if (requestCount === 1) {
          yield { toolCalls: [toolCall("call-read", "read_file", { path: "package.json" })] };
          return;
        }
        yield { content: "Child done." };
      },
    };

    await runAgent({
      provider,
      prompt: "Inspect package metadata.",
      cwd,
      sink: async () => {},
      maxTurns: 3,
      parentContext: {
        runId: "r-parent",
        workspace: cwd,
        permissionContext: {
          mode: "bypass",
          rules: DEFAULT_PERMISSION_RULES,
          runId: "r-parent",
          cwd,
        },
        childIndex: 1,
      },
    });

    const audit = readAuditDecisions(cwd);
    expect(audit).toContainEqual(expect.objectContaining({
      runId: "r-parent.t-1",
      parentRunId: "r-parent",
      tool: "read_file",
    }));
    expect(existsSync(join(cwd, ".tanya", "runs", "r-parent", "r-parent.t-1.json"))).toBe(true);
  });
});
