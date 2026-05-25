import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../../agent/runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";
import { DEFAULT_PERMISSION_RULES } from "../../safety/permissions/schema";
import { taskTool } from "../task";

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

describe("task tool", () => {
  it("spawns a child run and returns a structured verifier-aware result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-task-tool-"));
    const requests: ChatRequest[] = [];
    let childWriteDone = false;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        const last = input.messages.at(-1);
        if (last?.role === "user" && last.content?.includes("Delegate child")) {
          yield {
            toolCalls: [toolCall("call-task", "task", {
              prompt: "child writes file",
              max_turns: 3,
            })],
          };
          return;
        }
        if (last?.role === "user" && last.content?.includes("child writes file")) {
          childWriteDone = true;
          yield { toolCalls: [toolCall("call-child-write", "write_file", { path: "child.txt", content: "child" })] };
          return;
        }
        if (childWriteDone && last?.role === "tool" && last.tool_call_id === "call-child-write") {
          yield { content: "Child done." };
          return;
        }
        yield { content: "Parent done." };
      },
    };
    const events: TanyaEvent[] = [];

    const result = await runAgent({
      provider,
      prompt: "Delegate child work.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const taskResult = events.find((event) => event.type === "tool_result" && event.id === "call-task");
    expect(taskResult).toMatchObject({
      type: "tool_result",
      tool: "task",
      ok: true,
    });
    if (taskResult?.type !== "tool_result") throw new Error("missing task result");
    expect(taskResult.output).toMatchObject({
      ok: true,
      verdict: "passed",
      changedFiles: ["child.txt"],
      tokensUsed: { in: 0, out: 0 },
    });
    expect(JSON.stringify(taskResult.output)).toContain("r-");
    const startedIndex = events.findIndex((event) => event.type === "subtask_started");
    const childToolIndex = events.findIndex((event) => event.type === "tool_call" && event.subRunId);
    const completedIndex = events.findIndex((event) => event.type === "subtask_completed");
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(childToolIndex).toBeGreaterThan(startedIndex);
    expect(completedIndex).toBeGreaterThan(childToolIndex);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call",
      tool: "write_file",
      subRunId: expect.stringMatching(/\.t-1$/),
    }));
    expect(result.manifest.changedFiles).toEqual(["child.txt"]);
    expect(requests.some((request) => request.messages.some((message) => message.role === "user" && message.content === "child writes file"))).toBe(true);
  });

  it("denies task calls that would exceed the default depth cap", async () => {
    await expect(taskTool.canRun?.({ prompt: "too deep" }, {
      mode: "default",
      rules: DEFAULT_PERMISSION_RULES,
      runId: "r-parent.t-1.t-1",
      cwd: "/workspace",
    })).resolves.toMatchObject({
      decision: "deny",
      reason: "subtask-depth-limit",
    });
  });

  it("returns a cancelled budget result when the child exceeds its cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-task-budget-"));
    let childSeen = false;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (!childSeen && last?.role === "user" && last.content?.includes("Delegate capped work")) {
          yield {
            toolCalls: [toolCall("call-task-budget", "task", {
              prompt: "summarize workspace health",
              token_budget: { max_tokens: 1 },
            })],
          };
          return;
        }
        if (last?.role === "user" && last.content === "summarize workspace health") {
          childSeen = true;
          yield { content: "Child used budget.", usage: { promptTokens: 4, completionTokens: 4 } };
          return;
        }
        yield { content: "Parent done." };
      },
    };
    const events: TanyaEvent[] = [];

    const result = await runAgent({
      provider,
      prompt: "Delegate capped work.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const taskResult = events.find((event) => event.type === "tool_result" && event.id === "call-task-budget");
    expect(taskResult).toMatchObject({
      type: "tool_result",
      ok: false,
      output: {
        ok: false,
        cancelled: true,
        reason: "budget",
      },
    });
    expect(result.manifest.blockers).toEqual([expect.stringMatching(/subtask .* failed: budget exceeded/)]);
    expect(result.manifest.childVerdicts).toEqual([
      expect.objectContaining({
        verdict: "failed",
        blockers: ["budget exceeded"],
        treatFailureAs: "blocker",
      }),
    ]);
  });

  it("records warning-only child failures without cascading blockers", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-task-warning-"));
    let childSeen = false;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (!childSeen && last?.role === "user" && last.content === "Delegate warning work.") {
          yield {
            toolCalls: [toolCall("call-task-warning", "task", {
              prompt: "summarize warning child",
              token_budget: { max_tokens: 1 },
              treat_failure_as: "warning",
            })],
          };
          return;
        }
        if (last?.role === "user" && last.content === "summarize warning child") {
          childSeen = true;
          yield { content: "Child used budget.", usage: { promptTokens: 4, completionTokens: 4 } };
          return;
        }
        yield { content: "Parent done." };
      },
    };

    const result = await runAgent({
      provider,
      prompt: "Delegate warning work.",
      cwd,
      sink: async () => {},
      maxTurns: 3,
    });

    expect(result.manifest.blockers).toEqual([]);
    expect(result.manifest.childWarnings).toEqual([expect.stringMatching(/subtask .* failed: budget exceeded/)]);
    expect(result.manifest.childVerdicts).toEqual([
      expect.objectContaining({ treatFailureAs: "warning", verdict: "failed" }),
    ]);
  });

  it("suppresses ignored child failures from the report but keeps the audit evidence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-task-ignore-"));
    let childSeen = false;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (!childSeen && last?.role === "user" && last.content === "Delegate ignored work.") {
          yield {
            toolCalls: [toolCall("call-task-ignore", "task", {
              prompt: "summarize ignored child",
              token_budget: { max_tokens: 1 },
              treat_failure_as: "ignore",
            })],
          };
          return;
        }
        if (last?.role === "user" && last.content === "summarize ignored child") {
          childSeen = true;
          yield { content: "Child used budget.", usage: { promptTokens: 4, completionTokens: 4 } };
          return;
        }
        yield { content: "Parent done." };
      },
    };

    const result = await runAgent({
      provider,
      prompt: "Delegate ignored work.",
      cwd,
      sink: async () => {},
      maxTurns: 3,
    });

    expect(result.manifest.blockers).toEqual([]);
    expect(result.manifest.childWarnings).toBeUndefined();
    expect(result.manifest.childVerdicts).toBeUndefined();
    const audit = readFileSync(join(cwd, ".tanya", "audit.jsonl"), "utf8");
    expect(audit).toContain("\"reason\":\"child-verdict\"");
    expect(audit).toContain("\"treatFailureAs\":\"ignore\"");
  });

  it("rejects child prompts that would loop the parent prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-task-cycle-"));
    const events: TanyaEvent[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user" && last.content === "Map the auth module.") {
          yield { toolCalls: [toolCall("call-task-cycle", "task", { prompt: "Map the auth module." })] };
          return;
        }
        yield { content: "Done." };
      },
    };

    await runAgent({
      provider,
      prompt: "Map the auth module.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    const taskResult = events.find((event) => event.type === "tool_result" && event.id === "call-task-cycle");
    expect(taskResult).toMatchObject({
      type: "tool_result",
      ok: false,
      error: expect.stringContaining("cycle_detected"),
    });
  });

  it("propagates parent cancellation into an active child tool", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-task-cancel-"));
    let childStarted = false;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user" && last.content === "Delegate cancellable child.") {
          yield { toolCalls: [toolCall("call-task-cancel", "task", { prompt: "child sleeps" })] };
          return;
        }
        if (last?.role === "user" && last.content === "child sleeps") {
          childStarted = true;
          yield {
            toolCalls: [toolCall("call-child-shell", "run_shell", {
              script: "printf child; touch .tanya-child-started; sleep 10",
              timeoutMs: 20_000,
            })],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];
    const controller = new AbortController();
    const runPromise = runAgent({
      provider,
      prompt: "Delegate cancellable child.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
      signal: controller.signal,
    });

    await waitFor(() => childStarted && existsSync(join(cwd, ".tanya-child-started")), 2_000);
    controller.abort();
    await runPromise;

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_cancelled",
      tool: "run_shell",
      subRunId: expect.stringMatching(/\.t-1$/),
    }));
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  expect(predicate()).toBe(true);
}
