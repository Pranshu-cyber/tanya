import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";
import { buildBudgetSummary } from "../builtin/budget";
import { CACHE_MISS_ESTIMATE_TAG, type RunLog } from "../../memory/runLogs";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function writeRun(workspace: string, name: string, log: Partial<RunLog>): void {
  const runsDir = join(workspace, ".tanya", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${name}.json`), JSON.stringify({
    ts: "2026-05-16T12:00:00.000Z",
    prompt: "test run",
    provider: "deepseek",
    model: "deepseek-chat",
    durationMs: 1000,
    promptTokens: 10_000,
    completionTokens: 1_000,
    reasoningTokens: 100,
    systemPromptTokens: 3_000,
    historyTokens: 500,
    toolResultTokens: 5_000,
    changedFiles: [],
    blockers: [],
    ...log,
  }, null, 2));
}

describe("/budget command", () => {
  it("reports totals, per-turn breakdown, and deterministic suggestions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-budget-command-"));
    writeRun(cwd, "run-1", {});
    writeRun(cwd, "run-2", {
      ts: "2026-05-16T12:10:00.000Z",
      promptTokens: 4_000,
      completionTokens: 500,
      systemPromptTokens: 2_000,
      toolResultTokens: 100,
    });
    const output = new MemoryStream();

    await expect(runCommand("/budget", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("Session budget:");
    expect(text).toContain("Input tokens: 14,000");
    expect(text).toContain("Output tokens: 1,500");
    expect(text).toContain("Reasoning tokens: 200");
    expect(text).toContain("tool results: 5,000 tokens");
    expect(text).toContain(`Known spend: $0.006 ${CACHE_MISS_ESTIMATE_TAG}`);
    expect(text).toContain(`deepseek:deepseek-chat 11,100 tokens $0.004 ${CACHE_MISS_ESTIMATE_TAG}`);
    expect(text).toContain("Suggestion: Tool results dominate recent input tokens");
  });

  it("supports --json output for automation consumers", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-budget-json-"));
    writeRun(cwd, "run-1", {});
    const output = new MemoryStream();

    await expect(runCommand("/budget --json", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const parsed = JSON.parse(output.chunks.join("")) as ReturnType<typeof buildBudgetSummary>;
    expect(parsed.inputTokens).toBe(10_000);
    expect(parsed.expensiveTurns[0]?.sections.map((section) => section.name)).toEqual([
      "system prompt",
      "repo map",
      "history",
      "tool results",
      "model output",
      "reasoning",
    ]);
  });

  it("persists a session-scoped spend rule with --enforce", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-budget-enforce-"));
    const output = new MemoryStream();

    await expect(runCommand("/budget --enforce --max-usd 0.05 --max-tokens 25000", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const path = join(cwd, ".tanya", "permissions.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { spendRules?: unknown[] };
    expect(parsed.spendRules).toEqual([
      {
        type: "spend",
        scope: "session",
        max_usd: 0.05,
        max_tokens: 25000,
        action: "ask",
      },
    ]);
  });
});
