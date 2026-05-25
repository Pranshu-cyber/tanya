import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditDecisions } from "../../memory/auditLog";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";
import type { TanyaEvent } from "../../events/types";
import { runAgent } from "../runner";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function scriptedProvider(turns: Array<{ content?: string; toolCalls?: ToolCall[] }>): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "test",
    model: "test-model",
    requests,
    async *streamChat(input) {
      requests.push({ ...input, messages: [...input.messages] });
      yield turns[Math.min(requests.length - 1, turns.length - 1)] ?? { content: "Done." };
    },
  };
}

describe("edit_block runner integration", () => {
  it("adds repair hints to failed edit_block tool results seen by the next model turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-edit-block-repair-"));
    writeFileSync(join(cwd, "file.ts"), "export const value = 1;\n");
    const provider = scriptedProvider([
      {
        toolCalls: [toolCall("bad-edit", "edit_block", {
          path: "file.ts",
          search: "export const missing = 1;",
          replace: "export const value = 2;",
        })],
      },
      { content: "Done." },
    ]);
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Apply a precise edit.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    const toolEvent = events.find((event) => event.type === "tool_result" && event.id === "bad-edit");
    expect(toolEvent).toEqual(expect.objectContaining({
      type: "tool_result",
      ok: false,
      error: expect.stringContaining("consider re-reading the file"),
    }));
    const secondRequest = provider.requests[1];
    const toolMessage = secondRequest?.messages.find((message) => message.role === "tool" && message.tool_call_id === "bad-edit");
    expect(toolMessage?.content).toContain("repairHint");
    expect(toolMessage?.content).toContain("consider re-reading the file and emitting a closer search block");
    expect(readFileSync(join(cwd, "file.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("audits fuzzy candidate metadata when edit_block recovers a bounded match", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-edit-block-audit-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "default",
      alwaysAllow: ["edit_block:.*\"matchPolicy\":\"fuzzy\".*"],
    }));
    writeFileSync(join(cwd, "file.ts"), [
      "function greet() {",
      "  const name = \"Ada\";",
      "  return name;",
      "}",
      "",
    ].join("\n"));
    const provider = scriptedProvider([
      {
        toolCalls: [toolCall("fuzzy-edit", "edit_block", {
          path: "file.ts",
          search: "function greet() { const name = \"Ada\"; return name; }",
          replace: "function greet() {\n  return \"Ada\";\n}",
          matchPolicy: "fuzzy",
        })],
      },
      { content: "Done." },
    ]);

    await runAgent({
      provider,
      prompt: "Apply a fuzzy edit.",
      cwd,
      sink: async () => {},
      maxTurns: 2,
    });

    const entries = readAuditDecisions(cwd, { tool: "edit_block" });
    expect(entries).toContainEqual(expect.objectContaining({
      decision: "allow",
      reason: "fuzzy-candidate-applied",
      input: expect.objectContaining({
        fuzzyCandidate: expect.objectContaining({
          recoveredVia: "whitespace",
          confidence: 1,
          candidateExcerpt: expect.stringContaining("function greet"),
        }),
      }),
    }));
  });
});
