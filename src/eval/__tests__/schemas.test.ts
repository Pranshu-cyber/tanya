import { describe, expect, it } from "vitest";
import { validateEvalResult } from "../schemas/EvalResult";
import { validateEvalSuite } from "../schemas/EvalSuite";

describe("eval schemas", () => {
  it("validates an eval suite and rejects malformed shapes with pointers", () => {
    const valid = validateEvalSuite({
      name: "tiny",
      version: "1",
      tasks: [{
        id: "task-1",
        repo_setup: { type: "local_fixture", path: "fixtures/tiny" },
        prompt: "Fix the fixture.",
        expected_files: ["src/index.ts"],
      }],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateEvalSuite({
      name: "broken",
      version: "1",
      tasks: [{ id: "", repo_setup: { type: "git_clone", url: "" }, prompt: 42 }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "/tasks/0/id",
        "/tasks/0/prompt",
        "/tasks/0/repo_setup/url",
        "/tasks/0/repo_setup/commit",
      ]));
    }
  });

  it("validates eval results and rejects malformed run/token shapes with pointers", () => {
    const valid = validateEvalResult({
      suite: "tiny",
      suiteVersion: "1",
      tanyaVersion: "0.15.0-beta.0",
      model: "deepseek-chat",
      totalCostUsd: 0.001,
      costPerPass: 0.001,
      tokensPerPass: 18,
      reasoningShare: 1 / 18,
      runs: [{
        taskId: "task-1",
        status: "passed",
        durationMs: 100,
        tokensUsed: { input: 10, output: 5, reasoning: 1, system_prompt: 2 },
        costUsd: 0.001,
        verifierVerdict: "passed",
      }],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateEvalResult({
      suite: "tiny",
      suiteVersion: "1",
      tanyaVersion: "0.15.0-beta.0",
      model: "deepseek-chat",
      totalCostUsd: 0,
      costPerPass: null,
      tokensPerPass: null,
      reasoningShare: 0,
      runs: [{
        taskId: "task-1",
        status: "maybe",
        durationMs: -1,
        tokensUsed: { input: "lots", output: 1 },
        costUsd: 0,
        verifierVerdict: "unknown",
      }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "/runs/0/status",
        "/runs/0/durationMs",
        "/runs/0/tokensUsed/input",
        "/runs/0/verifierVerdict",
      ]));
    }
  });
});
