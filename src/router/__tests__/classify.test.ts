import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../../providers/types";
import { classifyStep, type RunnerStepState } from "../classify";
import type { StepType } from "../types";

function assistant(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "assistant", content: "", ...partial };
}

function toolCall(name: string): ToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

function tool(content = "ok"): ChatMessage {
  return { role: "tool", content, tool_call_id: "call-1" };
}

describe("classifyStep", () => {
  it.each([
    ["empty state starts as planning", {}, "planning"],
    ["explicit first turn is planning", { turnIndex: 0, lastAssistantMessage: assistant({ content: "hello" }) }, "planning"],
    ["message history without assistant starts as planning", { messages: [{ role: "user", content: "build it" }] }, "planning"],
    ["sub-agent first turn classifies independently as planning", { depth: 1, messages: [{ role: "user", content: "inspect module" }] }, "planning"],
    ["assistant with tool calls and no text is tool_call", { lastAssistantMessage: assistant({ content: "", tool_calls: [toolCall("read_file")] }) }, "tool_call"],
    ["assistant with whitespace and tool calls is tool_call", { lastAssistantMessage: assistant({ content: " \n", tool_calls: [toolCall("glob")] }) }, "tool_call"],
    ["pending tool calls are enough for tool_call", { lastAssistantMessage: assistant({ content: "" }), pendingToolCalls: [toolCall("run_shell")] }, "tool_call"],
    ["assistant prose plus a tool call is ambiguous", { lastAssistantMessage: assistant({ content: "I will inspect", tool_calls: [toolCall("read_file")] }) }, "unknown"],
    ["two explicit tool results plus assistant prose is synthesis", { lastAssistantMessage: assistant({ content: "Here is the result." }), lastToolResults: [tool(), tool()] }, "synthesis"],
    ["one tool result plus assistant prose is unknown", { lastAssistantMessage: assistant({ content: "partial" }), lastToolResults: [tool()] }, "unknown"],
    ["history-derived two tool results since user is synthesis", {
      messages: [
        { role: "user", content: "inspect" },
        assistant({ content: "", tool_calls: [toolCall("read_file")] }),
        tool("a"),
        tool("b"),
        assistant({ content: "Summary" }),
      ],
    }, "synthesis"],
    ["old tool results before latest user do not count", {
      messages: [
        { role: "user", content: "old" },
        tool("a"),
        tool("b"),
        { role: "user", content: "new" },
        assistant({ content: "No tools yet" }),
      ],
    }, "unknown"],
    ["verify tool is verification", { pendingToolCalls: [toolCall("verify")] }, "verification"],
    ["finalize tool is verification", { pendingToolCalls: [toolCall("finalize")] }, "verification"],
    ["validate-prefixed tool is verification", { pendingToolCalls: [toolCall("validate_manifest")] }, "verification"],
    ["preferred verifier tool is verification", { pendingToolCalls: [{ name: "custom_check", preferredModel: { match: "verification" } }] }, "verification"],
    ["non-verifier preferred tool is not verification", { lastAssistantMessage: assistant({ content: "" }), pendingToolCalls: [{ name: "custom_check", preferredModel: { match: "tool_call" } }] }, "tool_call"],
    ["open think block is reasoning", { lastAssistantMessage: assistant({ content: "<think>still working" }) }, "reasoning"],
    ["closed think block is not reasoning", { lastAssistantMessage: assistant({ content: "<think>done</think> final" }) }, "unknown"],
    ["provider reasoning flag is reasoning", { providerReasoningActive: true, lastAssistantMessage: assistant({ content: "working" }) }, "reasoning"],
    ["verification beats reasoning when a verifier tool is pending", { providerReasoningActive: true, pendingToolCalls: [toolCall("verify")] }, "verification"],
    ["reasoning beats plain tool_call when active think remains open", { lastAssistantMessage: assistant({ content: "<think>", tool_calls: [toolCall("read_file")] }) }, "reasoning"],
    ["plain assistant prose is unknown", { lastAssistantMessage: assistant({ content: "hello" }) }, "unknown"],
  ] satisfies Array<[string, RunnerStepState, StepType]>)("%s", (_name, state, expected) => {
    expect(classifyStep(state)).toBe(expected);
  });

  it("recognizes go-backend coding prompts as tool-call work after provider prose", () => {
    const prompt = [
      `Template id: "go-backend-favorites"`,
      "EXISTING CODE DETECTED",
      "EXECUTE mode",
      "Add favorites endpoints to the existing Go backend.",
    ].join("\n\n");

    expect(classifyStep({
      prompt,
      turnIndex: 1,
      lastAssistantMessage: assistant({ content: "← ok — Read .env.example\n→ read_file" }),
      runContext: { task: { title: "go-backend-favorites" } },
    })).toBe("tool_call");
  });

  it("treats a substantial prompt in a Go module as code-editing work", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-classify-go-"));
    writeFileSync(join(cwd, "go.mod"), "module example.com/app\n");
    mkdirSync(join(cwd, "cmd"), { recursive: true });

    expect(classifyStep({
      cwd,
      prompt: "Update the existing API implementation.\n".repeat(80),
      turnIndex: 1,
      lastAssistantMessage: assistant({ content: "I will inspect the code." }),
    })).toBe("tool_call");
  });
});
