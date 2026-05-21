import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import { CompactionExhaustedError } from "../compact";
import { readArchive } from "../../memory/runArchive";
import { ContextWindowExceededError, type ChatProvider, type ChatRequest } from "../../providers/types";

describe("runner context-window handling", () => {
  it("auto-compacts and retries after a typed context-window error", async () => {
    const events: unknown[] = [];
    const requests: ChatRequest[] = [];
    let mainAttempts = 0;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        const prompt = input.messages[0]?.content ?? "";
        if (input.tools?.length === 0 && prompt.includes("Summarize these older Tanya conversation turns")) {
          yield { content: "Older turn summary." };
          return;
        }
        mainAttempts += 1;
        if (mainAttempts === 1) {
          throw new ContextWindowExceededError({
            provider: "test",
            status: 413,
            rawMessage: "context_length_exceeded",
          });
        }
        yield { content: "Recovered after compaction." };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-context-window-"));
    const result = await runAgent({
      provider,
      prompt: "Keep going.",
      cwd,
      history: [
        { role: "user", content: "old request" },
        { role: "assistant", content: "old response" },
      ],
      sink: (event) => { events.push(event); },
      maxTurns: 1,
    });

    expect(result.message).toContain("Recovered after compaction.");
    expect(mainAttempts).toBe(2);
    expect(requests.some((request) => request.messages.some((message) => message.content?.includes("[compaction summary: Older turn summary.]")))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "compact_event",
      compactType: "auto",
      aggression: "normal",
    }));
    const archiveRoot = join(cwd, ".tanya", "runs");
    const runId = readdirSync(archiveRoot)[0] ?? "";
    const archive = await readArchive(runId, { workspace: cwd });
    expect(JSON.stringify(archive)).toContain("old request");
  });

  it("throws a clear exhausted error after normal and heavy compaction both fail", async () => {
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const prompt = input.messages[0]?.content ?? "";
        if (input.tools?.length === 0 && prompt.includes("Summarize these older Tanya conversation turns")) {
          yield { content: "Still too large." };
          return;
        }
        throw new ContextWindowExceededError({
          provider: "test",
          status: 413,
          rawMessage: "context_length_exceeded",
        });
      },
    };

    await expect(runAgent({
      provider,
      prompt: "Keep going.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-context-window-exhausted-")),
      history: [
        { role: "user", content: "old request" },
        { role: "assistant", content: "old response" },
        { role: "user", content: "older request" },
        { role: "assistant", content: "older response" },
      ],
      sink: () => {},
      maxTurns: 1,
    })).rejects.toBeInstanceOf(CompactionExhaustedError);
  });
});
