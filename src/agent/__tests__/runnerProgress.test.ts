import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

describe("runner tool progress", () => {
  it("forwards shell progress to EventSink without adding progress events to provider history", async () => {
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("call-shell", "run_shell", {
                script: "printf runner-progress",
                timeoutMs: 5_000,
              }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Run a shell command.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-progress-")),
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    const progressIndex = events.findIndex((event) => event.type === "tool_progress");
    const resultIndex = events.findIndex((event) => event.type === "tool_result");
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(progressIndex);
    expect(events[progressIndex]).toMatchObject({
      type: "tool_progress",
      toolCallId: "call-shell",
      chunk: "runner-progress",
      stream: "stdout",
    });

    expect(requests.length).toBe(2);
    const secondRequestMessages = JSON.stringify(requests[1]?.messages ?? []);
    expect(secondRequestMessages).not.toContain("tool_progress");
    expect(secondRequestMessages).not.toContain("toolCallId");
    expect(secondRequestMessages).not.toContain("\"stream\":\"stdout\"");
    expect(secondRequestMessages).toContain("runner-progress");
  });

  it("emits cancellation events and sends an explicit cancelled tool result to the provider", async () => {
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push({ ...input, messages: [...input.messages] });
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("call-cancel", "run_shell", {
                script: "printf start; touch .tanya-started; sleep 10; printf never",
                timeoutMs: 20_000,
              }),
            ],
          };
          return;
        }
        yield { content: "Cancelled." };
      },
    };
    const events: TanyaEvent[] = [];
    const controller = new AbortController();
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-cancel-"));
    const runPromise = runAgent({
      provider,
      prompt: "Run a cancellable shell command.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
      signal: controller.signal,
    });

    await expect(waitFor(() => existsSync(join(cwd, ".tanya-started")), 2_000)).resolves.toBe(true);
    controller.abort();
    await runPromise;

    const cancelRequestedIndex = events.findIndex((event) => event.type === "tool_cancel_requested");
    const cancelledIndex = events.findIndex((event) => event.type === "tool_cancelled");
    const resultIndex = events.findIndex((event) => event.type === "tool_result");
    expect(cancelRequestedIndex).toBeGreaterThanOrEqual(0);
    expect(cancelledIndex).toBeGreaterThan(cancelRequestedIndex);
    expect(resultIndex).toBeGreaterThan(cancelledIndex);
    expect(events[cancelRequestedIndex]).toMatchObject({
      type: "tool_cancel_requested",
      toolCallId: "call-cancel",
      tool: "run_shell",
    });
    expect(events[cancelledIndex]).toMatchObject({
      type: "tool_cancelled",
      toolCallId: "call-cancel",
      tool: "run_shell",
      partialOutput: "start",
    });

    const secondRequestMessages = requests[1]?.messages ?? [];
    const toolMessage = secondRequestMessages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("\"cancelled\":true");
    expect(toolMessage?.content).toContain("\"partial_output\":\"start\"");
    const serializedSecondRequest = JSON.stringify(secondRequestMessages);
    expect(serializedSecondRequest).not.toContain("tool_cancel_requested");
    expect(serializedSecondRequest).not.toContain("tool_cancelled");
  });
});
