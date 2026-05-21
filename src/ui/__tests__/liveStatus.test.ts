import { describe, expect, it } from "vitest";
import type { TanyaEvent } from "../../events/types";
import { createHumanSink } from "../humanSink";
import { createLiveStatus, createLiveStatusRenderer, formatLiveStatus } from "../liveStatus";

class MemoryStream {
  chunks: string[] = [];
  isTTY: boolean | undefined;
  columns: number | undefined;

  constructor(options: { isTTY?: boolean; columns?: number } = {}) {
    this.isTTY = options.isTTY;
    this.columns = options.columns;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

function clock(start = Date.parse("2026-05-16T12:00:00.000Z")): { now: () => Date; tick: (ms: number) => void } {
  let current = start;
  return {
    now: () => new Date(current),
    tick: (ms) => {
      current += ms;
    },
  };
}

describe("live status model", () => {
  it("derives deterministic snapshots from ordered EventSink events", () => {
    const time = clock();
    const status = createLiveStatus({
      now: time.now,
      estimateUsd: (_provider, _model, input, output) => (input + output) / 1_000_000,
    });

    const events: TanyaEvent[] = [
      { type: "model_routed", stepType: "tool_call", provider: "deepseek", model: "deepseek-chat", reason: "route" },
      { type: "tool_call", id: "tool-1", tool: "read_file", input: { path: "a.ts" } },
      { type: "tool_call", id: "tool-2", tool: "run_shell", input: { script: "npm test" } },
      { type: "subtask_started", subRunId: "r-abc.t-1", parentRunId: "r-abc", prompt: "map auth", workspace: "src/auth" },
      { type: "permission_request", id: "tool-3", tool: "write_file", input: { path: "README.md" }, matchedRule: "write_file:.*" },
      { type: "permission_decision", id: "tool-3", decision: "allow", source: "user" },
      { type: "tool_result", id: "tool-1", tool: "read_file", ok: true, summary: "read" },
      { type: "escalation_event", from: { provider: "deepseek", model: "deepseek-chat" }, to: { provider: "openai", model: "gpt-4.1-mini" }, reason: "parse_failure", stepType: "tool_call" },
      { type: "compact_event", compactType: "auto", removedTokens: 12_345 },
      { type: "prompt_budget_exceeded", droppedSections: ["repo-map", "artifact index"], totalTokens: 9_000, cap: 8_000 },
      { type: "subtask_completed", subRunId: "r-abc.t-1", parentRunId: "r-abc", verdict: "passed", summary: "ok", tokensUsed: { in: 10, out: 5 } },
      { type: "final", message: "done", metrics: { durationMs: 1, toolCallCount: 2, toolErrorCount: 0, changedFileCount: 1, promptTokens: 1_000, completionTokens: 250 } },
    ];

    for (const event of events) {
      status.consume(event);
      time.tick(1_000);
    }

    expect(status.snapshot()).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      routeStep: "tool_call",
      spend: { usd: 0.00125, inputTokens: 1_000, outputTokens: 250 },
      contextPressure: { used: 9_000, cap: 8_000 },
      activeTools: [{ id: "tool-2", tool: "run_shell", startedAt: "2026-05-16T12:00:02.000Z" }],
      activeChildren: [],
      lastEscalation: {
        from: "deepseek:deepseek-chat",
        to: "openai:gpt-4.1-mini",
        reason: "parse_failure",
        at: "2026-05-16T12:00:07.000Z",
      },
      lastCompaction: { type: "auto", removedTokens: 12_345, at: "2026-05-16T12:00:08.000Z" },
      promptBudgetWarning: {
        droppedSections: ["repo-map", "artifact index"],
        at: "2026-05-16T12:00:09.000Z",
      },
    });
  });

  it("clears transient permission and prompt-budget state on the matching lifecycle events", () => {
    const status = createLiveStatus({ now: () => new Date("2026-05-16T12:00:00.000Z") });

    status.consume({ type: "permission_request", id: "p1", tool: "run_shell", input: {}, matchedRule: "run_shell:.*" });
    expect(status.snapshot().pendingPermission).toEqual({ tool: "run_shell", matchedRule: "run_shell:.*" });

    status.consume({ type: "permission_decision", id: "p1", decision: "deny", source: "rule", matchedRule: "run_shell:.*" });
    expect(status.snapshot().pendingPermission).toBeUndefined();

    status.consume({ type: "prompt_budget_exceeded", droppedSections: ["repo-map"], totalTokens: 10_000, cap: 8_000 });
    expect(status.snapshot().promptBudgetWarning?.droppedSections).toEqual(["repo-map"]);

    status.consume({ type: "message_start" });
    expect(status.snapshot().promptBudgetWarning).toBeUndefined();
    expect(status.snapshot().contextPressure).toEqual({ used: 10_000, cap: 8_000 });
  });

  it("formats compact status lines and bounds them to terminal width", () => {
    const line = formatLiveStatus({
      provider: "deepseek",
      model: "deepseek-chat",
      routeStep: "tool_call",
      spend: { usd: 0.04, inputTokens: 1_000, outputTokens: 200 },
      activeTools: [
        { id: "a", tool: "read_file", startedAt: "2026-05-16T12:00:00.000Z" },
        { id: "b", tool: "run_shell", startedAt: "2026-05-16T12:00:01.000Z" },
      ],
      activeChildren: [{ subRunId: "r-1.t-1", workspace: "src", startedAt: "2026-05-16T12:00:02.000Z" }],
    }, { columns: 80 });

    expect(line).toBe("[deepseek:deepseek-chat | tool_call | $0.040 | 2 tools | 1 child]");
    expect(formatLiveStatus({
      provider: "very-long-provider",
      model: "very-long-model",
      routeStep: "planning",
      spend: { usd: 0, inputTokens: 0, outputTokens: 0 },
      activeTools: [],
      activeChildren: [],
    }, { columns: 32 }).length).toBeLessThanOrEqual(32);
  });

  it("renders ANSI status only for TTY streams and never for non-TTY streams", () => {
    const tty = new MemoryStream({ isTTY: true, columns: 80 });
    const nonTty = new MemoryStream({ isTTY: false, columns: 80 });
    const event: TanyaEvent = { type: "model_routed", stepType: "planning", provider: "deepseek", model: "deepseek-chat", reason: "route" };

    createLiveStatusRenderer({ stream: tty as unknown as NodeJS.WritableStream, now: () => new Date("2026-05-16T12:00:00.000Z") }).consume(event);
    createLiveStatusRenderer({ stream: nonTty as unknown as NodeJS.WritableStream, now: () => new Date("2026-05-16T12:00:00.000Z") }).consume(event);

    expect(tty.text()).toContain("\x1b7\r\x1b[2K[deepseek:deepseek-chat | planning");
    expect(nonTty.text()).toBe("");
  });

  it("keeps streamed tool progress byte-identical while live status is active", async () => {
    const events: TanyaEvent[] = [
      { type: "tool_progress", toolCallId: "shell", chunk: "line one\n", timestamp: "2026-05-16T12:00:00.000Z", stream: "stdout" },
      { type: "tool_progress", toolCallId: "shell", chunk: "line two\n", timestamp: "2026-05-16T12:00:01.000Z", stream: "stdout" },
    ];
    const baseline = new MemoryStream({ isTTY: true, columns: 80 });
    const live = new MemoryStream({ isTTY: true, columns: 80 });
    const baselineSink = createHumanSink(baseline as unknown as NodeJS.WritableStream);
    const liveSink = createHumanSink(live as unknown as NodeJS.WritableStream, {
      liveStatus: true,
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });

    for (const event of events) {
      await baselineSink(event);
      await liveSink(event);
    }

    expect(live.text()).toBe(baseline.text());
    expect(live.text()).not.toContain("\x1b");
  });

  it("honors TANYA_LIVE_STATUS=0 even for TTY streams", () => {
    const stream = new MemoryStream({ isTTY: true, columns: 80 });
    createLiveStatusRenderer({
      stream: stream as unknown as NodeJS.WritableStream,
      env: { TANYA_LIVE_STATUS: "0" },
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    }).consume({ type: "model_routed", stepType: "planning", provider: "deepseek", model: "deepseek-chat", reason: "route" });

    expect(stream.text()).toBe("");
  });

  it("prioritizes permission, escalation, compaction, and prompt-budget affordances", () => {
    const base = {
      provider: "deepseek",
      model: "deepseek-chat",
      routeStep: "tool_call" as const,
      spend: { usd: 0.04, inputTokens: 1_000, outputTokens: 200 },
      activeTools: [],
      activeChildren: [],
    };
    const now = new Date("2026-05-16T12:00:04.000Z");

    expect(formatLiveStatus({
      ...base,
      pendingPermission: { tool: "write_file", matchedRule: "write_file:.*" },
      lastEscalation: {
        from: "deepseek:deepseek-chat",
        to: "openai:gpt-4.1-mini",
        reason: "parse_failure",
        at: "2026-05-16T12:00:00.000Z",
      },
    }, { now })).toBe("[awaiting permission: write_file (write_file:.*)]");

    expect(formatLiveStatus({
      ...base,
      promptBudgetWarning: { droppedSections: ["repo-map", "artifact index"], at: "2026-05-16T12:00:00.000Z" },
      lastEscalation: {
        from: "deepseek:deepseek-chat",
        to: "openai:gpt-4.1-mini",
        reason: "parse_failure",
        at: "2026-05-16T12:00:00.000Z",
      },
    }, { now })).toBe("[prompt budget: dropped repo-map, artifact index]");

    expect(formatLiveStatus({
      ...base,
      lastEscalation: {
        from: "deepseek:deepseek-chat",
        to: "openai:gpt-4.1-mini",
        reason: "parse_failure",
        at: "2026-05-16T12:00:00.000Z",
      },
    }, { now })).toBe("[escalated deepseek:deepseek-chat->openai:gpt-4.1-mini: parse_failure]");

    expect(formatLiveStatus({
      ...base,
      lastCompaction: { type: "auto", removedTokens: 12_345, at: "2026-05-16T12:00:00.000Z" },
    }, { now })).toBe("[compacted ~12.3k tokens via auto]");
  });

  it("fades escalation and compaction affordances after five seconds", () => {
    const base = {
      provider: "deepseek",
      model: "deepseek-chat",
      routeStep: "tool_call" as const,
      spend: { usd: 0, inputTokens: 0, outputTokens: 0 },
      activeTools: [],
      activeChildren: [],
    };

    expect(formatLiveStatus({
      ...base,
      lastEscalation: {
        from: "deepseek:deepseek-chat",
        to: "openai:gpt-4.1-mini",
        reason: "parse_failure",
        at: "2026-05-16T12:00:00.000Z",
      },
    }, { now: new Date("2026-05-16T12:00:06.000Z") })).toBe("[deepseek:deepseek-chat | tool_call | $0.000 | 0 tools | 0 children]");

    expect(formatLiveStatus({
      ...base,
      lastCompaction: { type: "snip", removedTokens: 2_000, at: "2026-05-16T12:00:00.000Z" },
    }, { now: new Date("2026-05-16T12:00:06.000Z") })).toBe("[deepseek:deepseek-chat | tool_call | $0.000 | 0 tools | 0 children]");
  });
});
