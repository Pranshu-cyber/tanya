import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

import { runShellTool, getProgressThrottleMs } from "../fsTools";
import type { ToolProgressEvent } from "../types";

// 500ms throttle = small enough that the streaming test sees "first" well
// before its 2.6s deadline even under load, big enough that the throttling
// test still batches the "a"+"b" (100ms apart) emits into one "ab" chunk.
beforeAll(() => {
  process.env.TANYA_PROGRESS_THROTTLE_MS = "500";
  if (getProgressThrottleMs() !== 500) {
    throw new Error(`expected getProgressThrottleMs()=500, got ${getProgressThrottleMs()}`);
  }
});

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

describe("run_shell streaming", () => {
  it("emits stdout progress before a long-running shell command completes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-progress-"));
    const events: ToolProgressEvent[] = [];

    const resultPromise = runShellTool.run(
      { script: "printf first; sleep 3; printf second", timeoutMs: 6_000 },
      { workspace, onProgress: (event) => { events.push(event); } },
    );

    await expect(waitFor(() => events.some((event) => event.chunk.includes("first")), 2_600)).resolves.toBe(true);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.output).toBe("firstsecond");
    expect(events.some((event) => event.stream === "stdout" && event.chunk.includes("first"))).toBe(true);
  });

  it("throttles stdout progress and flushes buffered output on completion", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-throttle-"));
    const events: ToolProgressEvent[] = [];

    const result = await runShellTool.run(
      { script: "printf a; sleep 0.1; printf b; sleep 2.2; printf c", timeoutMs: 6_000 },
      { workspace, onProgress: (event) => { events.push(event); } },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("abc");
    expect(events.map((event) => event.chunk)).toEqual(["ab", "c"]);
    expect(events.every((event) => event.stream === "stdout")).toBe(true);
  });

  it("cancels a long-running shell command and returns partial output quickly", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-cancel-"));
    const controller = new AbortController();

    const resultPromise = runShellTool.run(
      { script: "printf start; touch .tanya-cancel-started; sleep 10; printf never", timeoutMs: 20_000 },
      { workspace, signal: controller.signal },
    );

    await expect(waitFor(() => existsSync(join(workspace, ".tanya-cancel-started")), 2_000)).resolves.toBe(true);
    await wait(25);
    const cancelledAt = Date.now();
    controller.abort();
    const result = await resultPromise;

    expect(Date.now() - cancelledAt).toBeLessThan(700);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.partial_output).toBe("start");
    expect(result.output).toEqual({ cancelled: true, partial_output: "start" });
  });

  it("marks rejected destructive cleanup as a shell safety block", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-safety-"));

    const result = await runShellTool.run(
      { script: "rm -rf .mvp10", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toEqual(expect.objectContaining({ reason: "shell_safety_block" }));
  });
});
