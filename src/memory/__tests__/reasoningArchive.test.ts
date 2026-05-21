import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendReasoningChunk,
  evictReasoningFromArchive,
  readReasoningArchive,
  reasoningArchivePath,
} from "../reasoningArchive";

describe("reasoning archive", () => {
  it("appends and reads reasoning chunks by run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-reasoning-archive-"));
    await appendReasoningChunk({
      workspace,
      runId: "r-test",
      turn: 2,
      provider: "deepseek",
      model: "deepseek-reasoner",
      content: "inspect options",
      tokens: 4,
    });

    expect(readReasoningArchive(workspace, "r-test")).toEqual([
      expect.objectContaining({
        runId: "r-test",
        turn: 2,
        provider: "deepseek",
        model: "deepseek-reasoner",
        content: "inspect options",
        tokens: 4,
      }),
    ]);
  });

  it("evicts reasoning archive content to a tombstone before regular history needs dropping", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-reasoning-evict-"));
    await appendReasoningChunk({
      workspace,
      runId: "r-test",
      provider: "qwen",
      model: "qwen3-thinking-32b",
      content: "x".repeat(4_000),
    });
    const before = statSync(reasoningArchivePath(workspace, "r-test")).size;
    const removed = evictReasoningFromArchive(workspace, "r-test", 1);
    const entries = readReasoningArchive(workspace, "r-test");

    expect(removed).toBeGreaterThan(0);
    expect(statSync(reasoningArchivePath(workspace, "r-test")).size).toBeLessThan(before);
    expect(entries).toEqual([
      expect.objectContaining({
        evicted: true,
        content: expect.stringContaining("reasoning archive evicted"),
      }),
    ]);
  });
});
