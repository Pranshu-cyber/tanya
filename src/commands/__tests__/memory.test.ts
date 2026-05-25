import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";
import { appendReasoningChunk } from "../../memory/reasoningArchive";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function record(signature: string, recordedAt: string, title: string) {
  return {
    schemaVersion: 1,
    recordedAt,
    signature,
    task: { title, kind: "coding" },
    caller: null,
    outcome: "passed",
    changedFiles: ["src/index.ts"],
    artifactsRead: [],
    artifactsCreated: [],
    verificationCount: 1,
    toolErrors: 0,
    blockers: [],
    validation: null,
  };
}

describe("/memory command", () => {
  it("lists recent golden tasks and honors --limit", async () => {
    const { workspace, output } = makeWorkspace();

    await expect(runCommand("/memory --limit 1", ctx(workspace, output))).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("second task");
    expect(text).not.toContain("first task");
  });

  it("prints the full record for --full <id>", async () => {
    const { workspace, output } = makeWorkspace();

    await expect(runCommand("/memory --full task-1", ctx(workspace, output))).resolves.toBe(true);

    const parsed = JSON.parse(output.chunks.join("")) as { signature: string; task: { title: string } };
    expect(parsed.signature).toBe("task-1");
    expect(parsed.task.title).toBe("first task");
  });

  it("prints archived reasoning for a run and supports --turn", async () => {
    const { workspace, output } = makeWorkspace();
    await appendReasoningChunk({
      workspace,
      runId: "r-reason",
      turn: 1,
      provider: "deepseek",
      model: "deepseek-reasoner",
      content: "first turn reasoning",
      tokens: 5,
    });
    await appendReasoningChunk({
      workspace,
      runId: "r-reason",
      turn: 2,
      provider: "deepseek",
      model: "deepseek-reasoner",
      content: "second turn reasoning",
      tokens: 5,
    });

    await expect(runCommand("/memory --reasoning r-reason --turn 2", ctx(workspace, output))).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("Reasoning archive for r-reason");
    expect(text).toContain("second turn reasoning");
    expect(text).not.toContain("first turn reasoning");
  });
});

function makeWorkspace(): { workspace: string; output: MemoryStream } {
  const workspace = mkdtempSync(join(tmpdir(), "tanya-memory-command-"));
  const memoryDir = join(workspace, ".tanya", "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "golden-tasks.jsonl"), [
    JSON.stringify(record("task-1", "2026-05-15T12:00:00.000Z", "first task")),
    JSON.stringify(record("task-2", "2026-05-15T13:00:00.000Z", "second task")),
  ].join("\n"));
  return { workspace, output: new MemoryStream() };
}

function ctx(workspace: string, output: MemoryStream) {
  return {
    cwd: workspace,
    output: output as unknown as NodeJS.WritableStream,
    sink: () => {},
  };
}
