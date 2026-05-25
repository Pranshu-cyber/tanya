import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ToolCall } from "../../providers/types";
import { readAuditDecisions } from "../../memory/auditLog";

const originalTanyaMode = process.env.TANYA_MODE;

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

function providerFor(call: ToolCall): ChatProvider {
  let requests = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat() {
      requests += 1;
      if (requests === 1) {
        yield { toolCalls: [call] };
        return;
      }
      yield { content: "Done." };
    },
  };
}

function providerForCalls(calls: ToolCall[]): ChatProvider {
  let requests = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat() {
      if (requests < calls.length) {
        const call = calls[requests];
        requests += 1;
        yield { toolCalls: call ? [call] : [] };
        return;
      }
      yield { content: "Done." };
    },
  };
}

afterEach(() => {
  if (originalTanyaMode === undefined) delete process.env.TANYA_MODE;
  else process.env.TANYA_MODE = originalTanyaMode;
});

describe("runner permissions", () => {
  it("requests permission and does not execute unmatched tools in ask mode", async () => {
    process.env.TANYA_MODE = "ask";
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permission-ask-"));
    const events: TanyaEvent[] = [];

    await runAgent({
      provider: providerFor(toolCall("call-write", "write_file", { path: "blocked.txt", content: "nope" })),
      prompt: "write a file",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    expect(existsSync(join(cwd, "blocked.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_request",
      id: "call-write",
      tool: "write_file",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_decision",
      id: "call-write",
      decision: "deny",
      source: "engine",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      id: "call-write",
      ok: false,
    }));
  });

  it("denies matched project rules before tool execution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permission-deny-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "default",
      alwaysDeny: ["write_file:.*blocked\\.txt.*"],
    }));
    const events: TanyaEvent[] = [];

    await runAgent({
      provider: providerFor(toolCall("call-write", "write_file", { path: "blocked.txt", content: "nope" })),
      prompt: "write a file",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    expect(existsSync(join(cwd, "blocked.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_decision",
      id: "call-write",
      decision: "deny",
      source: "rule",
      matchedRule: "write_file:.*blocked\\.txt.*",
    }));
  });

  it("allows ask-mode tool execution when the host approves and caches identical requests", async () => {
    process.env.TANYA_MODE = "ask";
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permission-allow-"));
    const events: TanyaEvent[] = [];
    let prompts = 0;

    await runAgent({
      provider: providerForCalls([
        toolCall("call-write-1", "write_file", { path: "allowed.txt", content: "yes" }),
        toolCall("call-write-2", "write_file", { path: "allowed.txt", content: "yes" }),
      ]),
      prompt: "write a file twice",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
      onPermissionRequest: async () => {
        prompts += 1;
        return { decision: "allow" };
      },
    });

    expect(existsSync(join(cwd, "allowed.txt"))).toBe(true);
    expect(prompts).toBe(1);
    expect(events.filter((event) => event.type === "permission_request")).toHaveLength(1);
    expect(events.filter((event) => event.type === "permission_decision" && event.decision === "allow")).toHaveLength(2);
  });

  it("keeps bypass as the default mode", async () => {
    delete process.env.TANYA_MODE;
    delete process.env.TANYA_MODE;
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permission-bypass-"));
    const events: TanyaEvent[] = [];

    await runAgent({
      provider: providerFor(toolCall("call-write", "write_file", { path: "allowed.txt", content: "yes" })),
      prompt: "write a file",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    expect(existsSync(join(cwd, "allowed.txt"))).toBe(true);
    expect(events.some((event) => event.type === "permission_request" || event.type === "permission_decision")).toBe(false);
    expect(readAuditDecisions(cwd).at(-1)).toMatchObject({
      tool: "write_file",
      decision: "allow",
      source: "bypass",
      mode: "bypass",
    });
  });

  it("honors legacy TANYA_MODE and plan mode denies every tool call", async () => {
    delete process.env.TANYA_MODE;
    process.env.TANYA_MODE = "plan";
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permission-plan-"));
    const events: TanyaEvent[] = [];

    await runAgent({
      provider: providerFor(toolCall("call-write", "write_file", { path: "planned.txt", content: "nope" })),
      prompt: "write a file",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    expect(existsSync(join(cwd, "planned.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_decision",
      id: "call-write",
      decision: "deny",
      source: "engine",
    }));
    expect(readAuditDecisions(cwd).at(-1)).toMatchObject({
      decision: "deny",
      mode: "plan",
    });
  });

  it("blocks tool calls that would exceed spend rules and audits thresholds", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-permission-spend-"));
    mkdirSync(join(cwd, ".tanya"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "default",
      spendRules: [{ type: "spend", scope: "turn", max_usd: 0.05, action: "deny" }],
    }));
    const events: TanyaEvent[] = [];

    await runAgent({
      provider: providerFor(toolCall("call-shell", "run_shell", {
        script: "printf should-not-run > blocked.txt",
        projectedCostUsd: 0.10,
      })),
      prompt: "run an expensive shell command",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 2,
    });

    expect(existsSync(join(cwd, "blocked.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_decision",
      id: "call-shell",
      decision: "deny",
      source: "rule",
      projectedCostUsd: 0.10,
      thresholdUsd: 0.05,
    }));
    expect(readAuditDecisions(cwd).at(-1)).toMatchObject({
      tool: "run_shell",
      decision: "deny",
      projectedCostUsd: 0.10,
      thresholdUsd: 0.05,
    });
  });
});
