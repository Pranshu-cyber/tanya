import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";
import { CACHE_MISS_ESTIMATE_TAG, formatUsdWithCacheNote } from "../../memory/runLogs";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/cost command", () => {
  it("prints tokens, known pricing, unknown pricing, and a session total", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-cost-command-"));
    const runsDir = join(workspace, ".tanya", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "2026-05-15T12-00-00.json"), JSON.stringify({
      ts: "2026-05-15T12:00:00.000Z",
      provider: "deepseek",
      model: "deepseek-chat",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      reasoningTokens: 100_000,
      durationMs: 1_000,
      prompt: "known",
      changedFiles: [],
      blockers: [],
    }));
    writeFileSync(join(runsDir, "2026-05-15T13-00-00.json"), JSON.stringify({
      ts: "2026-05-15T13:00:00.000Z",
      provider: "custom",
      model: "custom-model",
      promptTokens: 123,
      completionTokens: 456,
      durationMs: 1_000,
      prompt: "unknown",
      changedFiles: [],
      blockers: [],
    }));
    const output = new MemoryStream();

    await expect(runCommand("/cost", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("deepseek:deepseek-chat");
    expect(text).toContain("1,000,000 in / 1,000,000 out / 100,000 reasoning");
    expect(text).toContain("custom:custom-model");
    expect(text).toContain("pricing unknown");
    expect(text).toContain(`$1.480 ${CACHE_MISS_ESTIMATE_TAG}`);
    expect(text).toContain(`Session total: $1.480 ${CACHE_MISS_ESTIMATE_TAG}`);
  });

  it("omits the cache-miss label when cache pricing is modeled", () => {
    expect(formatUsdWithCacheNote(1.37, true)).toBe("$1.370");
  });

  it("labels cache-miss estimates explicitly", () => {
    expect(formatUsdWithCacheNote(1.37)).toBe(`$1.370 ${CACHE_MISS_ESTIMATE_TAG}`);
  });

  it("writes an enforced session spend rule", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-cost-enforce-"));
    const output = new MemoryStream();

    await expect(runCommand("/cost --enforce --max-usd 0.05 --max-tokens 1000", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const parsed = JSON.parse(readFileSync(join(workspace, ".tanya", "permissions.json"), "utf8")) as {
      spendRules?: Array<{ scope?: string; max_usd?: number; max_tokens?: number; action?: string }>;
    };
    expect(parsed.spendRules?.[0]).toMatchObject({
      scope: "session",
      max_usd: 0.05,
      max_tokens: 1000,
      action: "deny",
    });
    expect(output.chunks.join("")).toContain("Session spend rule written");
  });
});
