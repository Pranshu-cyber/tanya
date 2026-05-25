import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAutoFixPrompt,
  DispatchCorruptedStateError,
  inferTestCommand,
  parseVerifyFailureJSONL,
  runPlanAndDispatch,
  type DispatchCommandResult,
  type DispatchRunTurn,
} from "../src/agent/dispatch";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-dispatch-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function planJSON(count = 3): string {
  const subtasks = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    title: `Task ${i + 1}`,
    files: [`file${i + 1}.ts`],
    depends_on: i === 0 ? [] : [String(i)],
  }));
  return `\`\`\`json\n${JSON.stringify({ plan: "Build it in focused slices.", subtasks })}\n\`\`\``;
}

function tddPlanJSON(count = 3, extra: Record<string, unknown> = {}): string {
  const subtasks = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    title: `Task ${i + 1}`,
    files: [`file${i + 1}.ts`],
    depends_on: i === 0 ? [] : [String(i)],
    ...extra,
  }));
  return `\`\`\`json\n${JSON.stringify({ plan: "TDD it in slices.", default_test_cmd: "npm test", subtasks })}\n\`\`\``;
}

function redJSON(cmd = "npm test"): string {
  return `\`\`\`json\n${JSON.stringify({ phase: "red_written", test_files: ["feature.test.ts"], test_cmd: cmd })}\n\`\`\``;
}

function greenJSON(): string {
  return `\`\`\`json\n${JSON.stringify({ phase: "green_written", impl_files: ["feature.ts"] })}\n\`\`\``;
}

const pass: DispatchCommandResult = { exitCode: 0, stdout: "ok", stderr: "" };
const fail: DispatchCommandResult = { exitCode: 1, stdout: "", stderr: "expected failure" };

describe("plan-and-dispatch", () => {
  it("TestPlanAndDispatch_HappyPath_Sequential", async () => {
    const cwd = tempRoot();
    const prompts: string[] = [];
    const runTurn: DispatchRunTurn = async (prompt, meta) => {
      prompts.push(prompt);
      if (meta.phase === "plan") return planJSON();
      if (meta.phase === "complete") return "complete";
      return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: meta.subtask?.files ?? [], summary: `finished ${meta.subtask?.id}` })}\n\`\`\``;
    };

    const result = await runPlanAndDispatch({ cwd, prompt: "build feature", runTurn });

    expect(result.completed).toHaveLength(3);
    expect(prompts).toHaveLength(5);
    expect(prompts[2]).toContain("finished 1");
    expect(readFileSync(join(cwd, ".tanya", "dispatch", result.runID, "plan.json"), "utf8")).toContain("Build it");
  });

  it("TestPlanAndDispatch_JSONParseFailure_LogsAndStops", async () => {
    const cwd = tempRoot();
    await expect(runPlanAndDispatch({
      cwd,
      prompt: "build",
      runTurn: async () => "not json",
    })).rejects.toThrow();
  });

  it("TestPlanAndDispatch_SubtaskFailure_StopsBeforeLater", async () => {
    const cwd = tempRoot();
    const phases: string[] = [];
    await expect(runPlanAndDispatch({
      cwd,
      prompt: "build",
      runTurn: async (_prompt, meta) => {
        phases.push(meta.phase === "subtask" ? meta.subtask?.id ?? "" : meta.phase);
        if (meta.phase === "plan") return planJSON();
        if (meta.subtask?.id === "2") throw new Error("boom");
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: [], summary: "ok" })}\n\`\`\``;
      },
    })).rejects.toThrow("boom");
    expect(phases).toEqual(["plan", "1", "2"]);
  });

  it("TestPlanAndDispatch_Resume_SkipsCompletedSubtasks", async () => {
    const cwd = tempRoot();
    await expect(runPlanAndDispatch({
      cwd,
      prompt: "build",
      runTurn: async (_prompt, meta) => {
        if (meta.phase === "plan") return planJSON();
        if (meta.subtask?.id === "2") throw new Error("stop");
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["file1.ts"], summary: "first done" })}\n\`\`\``;
      },
    })).rejects.toThrow("stop");

    const runID = readdirSync(join(cwd, ".tanya", "dispatch"))[0]!;
    const seen: string[] = [];
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "",
      resumeRunID: runID,
      runTurn: async (_prompt, meta) => {
        seen.push(meta.phase === "subtask" ? meta.subtask?.id ?? "" : meta.phase);
        if (meta.phase === "complete") return "complete";
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: meta.subtask?.files ?? [], summary: `done ${meta.subtask?.id}` })}\n\`\`\``;
      },
    });
    expect(seen).toEqual(["2", "3", "complete"]);
    expect(result.completed).toHaveLength(3);
  });

  it("TestPlanAndDispatch_Resume_CorruptedPlanJSON_RaisesTypedError", async () => {
    const cwd = tempRoot();
    await expect(runPlanAndDispatch({
      cwd,
      prompt: "build",
      runTurn: async (_prompt, meta) => {
        if (meta.phase === "plan") return planJSON();
        throw new Error("stop");
      },
    })).rejects.toThrow("stop");

    const runID = readdirSync(join(cwd, ".tanya", "dispatch"))[0]!;
    const planPath = join(cwd, ".tanya", "dispatch", runID, "plan.json");
    writeFileSync(planPath, "{not-json");

    await expect(runPlanAndDispatch({
      cwd,
      prompt: "",
      resumeRunID: runID,
      runTurn: async () => "unused",
    })).rejects.toBeInstanceOf(DispatchCorruptedStateError);
  });

  it("TestPlanAndDispatch_Resume_CorruptedSubtaskResult_RaisesTypedError", async () => {
    const cwd = tempRoot();
    await expect(runPlanAndDispatch({
      cwd,
      prompt: "build",
      runTurn: async (_prompt, meta) => {
        if (meta.phase === "plan") return planJSON();
        if (meta.subtask?.id === "2") throw new Error("stop");
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["file1.ts"], summary: "first done" })}\n\`\`\``;
      },
    })).rejects.toThrow("stop");

    const runID = readdirSync(join(cwd, ".tanya", "dispatch"))[0]!;
    const resultPath = join(cwd, ".tanya", "dispatch", runID, "subtask_1.json");
    writeFileSync(resultPath, "{not-json");

    await expect(runPlanAndDispatch({
      cwd,
      prompt: "",
      resumeRunID: runID,
      runTurn: async () => "unused",
    })).rejects.toBeInstanceOf(DispatchCorruptedStateError);
  });

  it("TestPlanAndDispatch_MaxSubtasksRespected", async () => {
    await expect(runPlanAndDispatch({
      cwd: tempRoot(),
      prompt: "build",
      maxSubtasks: 2,
      runTurn: async () => planJSON(3),
    })).rejects.toThrow(/exceeding max 2/);
  });

  it("TestPlanAndDispatch_ParallelMode_NotYetImplemented_Errors", async () => {
    await expect(runPlanAndDispatch({
      cwd: tempRoot(),
      prompt: "build",
      mode: "parallel",
      runTurn: async () => planJSON(),
    })).rejects.toThrow(/parallel is not implemented/);
  });
});

describe("plan-and-dispatch TDD", () => {
  it("TestTDD_HappyPath_RedThenGreenSingleAttempt", async () => {
    const cwd = tempRoot();
    const commands: string[] = [];
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (_prompt, meta) => {
        if (meta.phase === "plan") return tddPlanJSON(3);
        if (meta.phase === "complete") return "complete";
        return _prompt.includes("phase 3") ? greenJSON() : redJSON();
      },
      runCommand: async (cmd) => {
        commands.push(cmd);
        return commands.length % 2 === 1 ? fail : pass;
      },
    });
    expect(result.completed).toHaveLength(3);
    expect(commands).toHaveLength(6);
    for (const subtask of ["1", "2", "3"]) {
      expect(existsSync(join(cwd, ".tanya", "dispatch", result.runID, `subtask_${subtask}_phases.jsonl`))).toBe(true);
    }
  });

  it("TestTDD_RedPhase_TestPassesBeforeImpl_FailsAndRetries", async () => {
    const cwd = tempRoot();
    const prompts: string[] = [];
    let redWrites = 0;
    let commandCalls = 0;
    await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (prompt, meta) => {
        prompts.push(prompt);
        if (meta.phase === "plan") return tddPlanJSON(1);
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("phase 3")) return greenJSON();
        redWrites += 1;
        return redJSON();
      },
      runCommand: async () => {
        commandCalls += 1;
        if (commandCalls === 1) return pass;
        if (commandCalls === 2) return fail;
        return pass;
      },
    });
    expect(prompts.some((prompt) => prompt.includes("TDD violation: your test passed before the implementation existed"))).toBe(true);
    expect(redWrites).toBe(2);
  });

  it("TestTDD_RedPhase_ThirdRedFailure_AbandonsTDD", async () => {
    const cwd = tempRoot();
    const prompts: string[] = [];
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (prompt, meta) => {
        prompts.push(prompt);
        if (meta.phase === "plan") return tddPlanJSON(1);
        if (prompt.includes("Write the code. When done")) {
          return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["fallback.ts"], summary: "fallback" })}\n\`\`\``;
        }
        if (meta.phase === "complete") return "complete";
        return redJSON();
      },
      runCommand: async () => pass,
    });
    expect(result.completed[0]?.summary).toBe("fallback");
    expect(prompts.filter((prompt) => prompt.includes("TDD violation")).length).toBe(2);
    const phaseLog = readFileSync(join(cwd, ".tanya", "dispatch", result.runID, "subtask_1_phases.jsonl"), "utf8");
    expect(phaseLog).toContain("red_abandoned");
  });

  it("TestTDD_GreenPhase_TestFailsThenPassesAfterFix", async () => {
    const cwd = tempRoot();
    const prompts: string[] = [];
    let commandCalls = 0;
    await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (prompt, meta) => {
        prompts.push(prompt);
        if (meta.phase === "plan") return tddPlanJSON(1);
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("Test still failing")) return greenJSON();
        return prompt.includes("phase 3") ? greenJSON() : redJSON();
      },
      runCommand: async () => {
        commandCalls += 1;
        if (commandCalls === 1) return fail;
        if (commandCalls === 2) return { exitCode: 1, stdout: "", stderr: "still failing" };
        return pass;
      },
    });
    expect(prompts.some((prompt) => prompt.includes("Test still failing"))).toBe(true);
  });

  it("TestTDD_GreenPhase_FiveFailedFixAttempts_SubtaskFailed", async () => {
    const cwd = tempRoot();
    await expect(runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return tddPlanJSON(1);
        return prompt.includes("phase 1") ? redJSON() : greenJSON();
      },
      runCommand: async () => fail,
    })).rejects.toThrow(/failed TDD GREEN after 5 attempts/);
    const runID = readdirSync(join(cwd, ".tanya", "dispatch"))[0]!;
    expect(readFileSync(join(cwd, ".tanya", "dispatch", runID, "failures.log"), "utf8")).toContain("failed TDD GREEN");
  });

  it("TestTDD_SubtaskFlaggedTDDFalseInPlan_SkipsTDDWrapper", async () => {
    const cwd = tempRoot();
    const prompts: string[] = [];
    await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (prompt, meta) => {
        prompts.push(prompt);
        if (meta.phase === "plan") return tddPlanJSON(1, { tdd: false });
        if (meta.phase === "complete") return "complete";
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: [], summary: "plain" })}\n\`\`\``;
      },
      runCommand: async () => { throw new Error("should not run"); },
    });
    expect(prompts.some((prompt) => prompt.includes("TDD phase"))).toBe(false);
  });

  it("TestTDD_TestCmdAutoDetection_Go_Node_Rust_Python", () => {
    const cases = [
      ["go.mod", "go test ./... -count=1"],
      ["package.json", "npm test"],
      ["Cargo.toml", "cargo test"],
      ["pyproject.toml", "pytest"],
      ["requirements.txt", "pytest"],
    ] as const;
    for (const [file, expected] of cases) {
      const cwd = tempRoot();
      writeFileSync(join(cwd, file), "");
      expect(inferTestCommand(cwd)).toBe(expected);
    }
  });

  it("TestTDD_TestCmdAutoDetection_None_ErrorsWithClearMessage", async () => {
    await expect(runPlanAndDispatch({
      cwd: tempRoot(),
      prompt: "build",
      tdd: true,
      runTurn: async (_prompt, meta) => {
        if (meta.phase === "plan") return `\`\`\`json\n${JSON.stringify({ plan: "x", subtasks: [{ id: "1", title: "x", files: [], depends_on: [] }] })}\n\`\`\``;
        return redJSON("");
      },
      runCommand: async () => fail,
    })).rejects.toThrow(/cannot infer test_cmd/);
  });

  it("TestTDD_TestCmdCLIOverride_BeatsAllSources", async () => {
    const cwd = tempRoot();
    const commands: string[] = [];
    await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      testCmd: "custom test",
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return tddPlanJSON(1);
        if (meta.phase === "complete") return "complete";
        return prompt.includes("phase 3") ? greenJSON() : redJSON("npm test");
      },
      runCommand: async (cmd) => {
        commands.push(cmd);
        return commands.length === 1 ? fail : pass;
      },
    });
    expect(commands).toEqual(["custom test", "custom test"]);
  });

  it("TestTDD_PhaseLogJsonl_AppendOnly_OneLinePerPhase", async () => {
    const cwd = tempRoot();
    let commandCalls = 0;
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      tdd: true,
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return tddPlanJSON(1);
        if (meta.phase === "complete") return "complete";
        return prompt.includes("phase 3") ? greenJSON() : redJSON();
      },
      runCommand: async () => {
        commandCalls += 1;
        return commandCalls === 1 ? fail : pass;
      },
    });
    const lines = readFileSync(join(cwd, ".tanya", "dispatch", result.runID, "subtask_1_phases.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("auto-fix verify loop", () => {
  it("TestAutoFix_HappyPath_OneIterationFixesAll", async () => {
    const cwd = tempRoot();
    const batches = [
      [{ type: "verify_failure" as const, kind: "grep", severity: "error", path: "a.go", pattern: "Register", description: "missing register call" }],
      [],
    ];
    const prompts: string[] = [];
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      autoFixVerify: true,
      runTurn: async (prompt, meta) => {
        prompts.push(prompt);
        if (meta.phase === "plan") return planJSON(1);
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("The verify suite ran")) {
          return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "fixed: register" })}\n\`\`\``;
        }
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "initial" })}\n\`\`\``;
      },
      readVerifyFailures: async () => batches.shift() ?? [],
    });
    expect(result.completed[0]?.summary).toBe("fixed: register");
    expect(prompts.some((prompt) => prompt.includes("Failure 1/1: grep in a.go"))).toBe(true);
    const fixLog = readFileSync(join(cwd, ".tanya", "dispatch", result.runID, "subtask_1_fixes.jsonl"), "utf8").trim().split("\n");
    expect(fixLog).toHaveLength(1);
  });

  it("TestAutoFix_TwoIterationsToConverge", async () => {
    const cwd = tempRoot();
    const failure = { type: "verify_failure" as const, kind: "cmd", severity: "error", cmd: "go test ./...", output_excerpt: "first fail" };
    const second = { type: "verify_failure" as const, kind: "grep", severity: "error", path: "b.go", pattern: "Mount" };
    const batches = [[failure], [second], []];
    let fixes = 0;
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      autoFixVerify: true,
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return planJSON(1);
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("The verify suite ran")) {
          fixes += 1;
          return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: [`fix${fixes}.go`], summary: `fixed ${fixes}` })}\n\`\`\``;
        }
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "initial" })}\n\`\`\``;
      },
      readVerifyFailures: async () => batches.shift() ?? [],
    });
    expect(fixes).toBe(2);
    expect(result.completed[0]?.summary).toBe("fixed 2");
  });

  it("TestAutoFix_MaxIterationsReached_GivesUpGracefully", async () => {
    const cwd = tempRoot();
    const failure = { type: "verify_failure" as const, kind: "grep", severity: "error", path: "never.go", pattern: "Impossible" };
    let fixes = 0;
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      autoFixVerify: true,
      maxFixIterations: 2,
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return planJSON(1);
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("The verify suite ran")) {
          fixes += 1;
          return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["attempt.go"], summary: "attempted" })}\n\`\`\``;
        }
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "initial" })}\n\`\`\``;
      },
      readVerifyFailures: async () => [failure],
    });
    expect(fixes).toBe(1);
    expect(result.completed[0]?.summary).toContain("auto-fix entered a loop");
    expect(result.completed[0]?.unfixed_failures).toHaveLength(1);
  });

  it("TestAutoFix_MaxIterationsReached_WithChangingFailures_GivesUpGracefully", async () => {
    const cwd = tempRoot();
    let reads = 0;
    let fixes = 0;
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      autoFixVerify: true,
      maxFixIterations: 2,
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return planJSON(1);
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("The verify suite ran")) {
          fixes += 1;
          return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["attempt.go"], summary: "attempted" })}\n\`\`\``;
        }
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "initial" })}\n\`\`\``;
      },
      readVerifyFailures: async () => {
        reads += 1;
        return [{ type: "verify_failure", kind: "grep", severity: "error", path: `never${reads}.go`, pattern: "Impossible" }];
      },
    });
    expect(fixes).toBe(2);
    expect(result.completed[0]?.summary).toContain("auto-fix gave up after 2 iterations");
  });

  it("TestAutoFix_PerSubtaskOptOut_RespectsAutoFixFalse", async () => {
    const cwd = tempRoot();
    let reads = 0;
    const plan = `\`\`\`json\n${JSON.stringify({ plan: "x", subtasks: [{ id: "1", title: "x", files: ["a.go"], depends_on: [], auto_fix: false }] })}\n\`\`\``;
    const result = await runPlanAndDispatch({
      cwd,
      prompt: "build",
      autoFixVerify: true,
      runTurn: async (_prompt, meta) => {
        if (meta.phase === "plan") return plan;
        if (meta.phase === "complete") return "complete";
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "initial" })}\n\`\`\``;
      },
      readVerifyFailures: async () => {
        reads += 1;
        return [{ type: "verify_failure", kind: "grep", severity: "error" }];
      },
    });
    expect(result.completed[0]?.summary).toBe("initial");
    expect(reads).toBe(0);
  });

  it("TestAutoFix_OutOfScopeEdit_LogsWarn", async () => {
    const cwd = tempRoot();
    const events: unknown[] = [];
    let reads = 0;
    await runPlanAndDispatch({
      cwd,
      prompt: "build",
      autoFixVerify: true,
      sink: async (event) => { events.push(event); },
      runTurn: async (prompt, meta) => {
        if (meta.phase === "plan") return `\`\`\`json\n${JSON.stringify({ plan: "x", subtasks: [{ id: "1", title: "x", files: ["a.go"], depends_on: [] }] })}\n\`\`\``;
        if (meta.phase === "complete") return "complete";
        if (prompt.includes("The verify suite ran")) {
          return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go", "outside.go"], summary: "fixed" })}\n\`\`\``;
        }
        return `\`\`\`json\n${JSON.stringify({ done: true, files_changed: ["a.go"], summary: "initial" })}\n\`\`\``;
      },
      readVerifyFailures: async () => {
        reads += 1;
        if (reads > 1) return [];
        const failure = { type: "verify_failure" as const, kind: "grep", severity: "error", path: "a.go", pattern: "x" };
        return [failure];
      },
    });
    expect(events.some((event) => JSON.stringify(event).includes("outside its declared scope: outside.go"))).toBe(true);
  });

  it("TestAutoFix_WireFormat_StdinJSONLParsing", () => {
    const failures = parseVerifyFailureJSONL([
      "{\"type\":\"verify_failure\",\"kind\":\"grep\",\"severity\":\"error\",\"path\":\"internal/a.go\",\"pattern\":\"Mount\"}",
      "not json",
      "{\"type\":\"verify_failure\",\"kind\":\"cmd\",\"cmd\":\"go test ./...\",\"exit_code\":1,\"output_excerpt\":\"boom\"}",
      "{\"type\":\"verify_failure_eof\"}",
      "{\"type\":\"verify_failure\",\"kind\":\"grep\",\"path\":\"ignored\"}",
    ]);
    expect(failures).toHaveLength(2);
    expect(failures[0]?.path).toBe("internal/a.go");
    expect(failures[1]?.cmd).toBe("go test ./...");
  });

  it("TestAutoFix_BuildPrompt_TrimsCommandOutput", () => {
    const prompt = buildAutoFixPrompt([{ kind: "cmd", severity: "error", cmd: "go test ./...", output_excerpt: "x".repeat(3000) }]);
    expect(prompt).toContain("Failure 1/1: cmd");
    expect(prompt.length).toBeLessThan(2600);
  });
});
