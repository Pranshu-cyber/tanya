import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalSuite } from "../schemas";
import { assertEvalResult } from "../schemas";
import { runEvalSuite } from "../runner";

const suite: EvalSuite = {
  name: "runner-fixture",
  version: "1",
  tasks: [
    {
      id: "ok",
      repo_setup: { type: "local_fixture", path: "fixture" },
      prompt: "Pass.",
    },
    {
      id: "slow",
      repo_setup: { type: "local_fixture", path: "fixture" },
      prompt: "Timeout.",
    },
  ],
};

describe("eval runner", () => {
  it("runs a suite end-to-end and produces valid EvalResult JSON", async () => {
    const cwd = await fixtureRoot();
    const result = await runEvalSuite(suite, {
      cwd,
      provider: "deepseek",
      model: "deepseek-chat",
      tanyaVersion: "test",
      taskIds: ["ok"],
      executor: async () => ({
        verifierVerdict: "passed",
        tokensUsed: { input: 100, output: 20, reasoning: 5, system_prompt: 10 },
        costUsd: 0.001,
        diff: "diff --git a/file b/file",
      }),
    });

    expect(assertEvalResult(result).runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      taskId: "ok",
      status: "passed",
      verifierVerdict: "passed",
    });
  });

  it("records timeout status and continues accounting for the task", async () => {
    const cwd = await fixtureRoot();
    const result = await runEvalSuite(suite, {
      cwd,
      provider: "deepseek",
      model: "deepseek-chat",
      tanyaVersion: "test",
      taskIds: ["slow"],
      timeoutMs: 10,
      executor: () => new Promise((resolve) => {
        setTimeout(() => resolve({
          verifierVerdict: "passed",
          tokensUsed: { input: 1, output: 1 },
          costUsd: 0,
        }), 100);
      }),
    });

    expect(result.runs[0]?.status).toBe("timeout");
    expect(result.runs[0]?.verifierVerdict).toBe("failed");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tanya-eval-runner-"));
  await mkdir(join(root, "fixture"));
  await writeFile(join(root, "fixture", "README.md"), "fixture file\n");
  return root;
}
