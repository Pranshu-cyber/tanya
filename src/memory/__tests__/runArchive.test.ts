import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendArchive,
  fileTouchPathsFromArchive,
  readArchive,
  safeAppendArchive,
  searchArchive,
  toArchivedMessages,
} from "../runArchive";
import type { ChatMessage } from "../../providers/types";

describe("run archive", () => {
  it("appends and reads archived messages as JSONL", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-archive-"));
    await appendArchive("run-1", [
      { archivedAt: "2026-05-16T00:00:00.000Z", role: "assistant", content: "first", tokens: 2 },
      { archivedAt: "2026-05-16T00:00:01.000Z", role: "tool", content: "second", toolName: "read_file" },
    ], { workspace });

    expect(await readArchive("run-1", { workspace })).toEqual([
      { archivedAt: "2026-05-16T00:00:00.000Z", role: "assistant", content: "first", tokens: 2 },
      { archivedAt: "2026-05-16T00:00:01.000Z", role: "tool", content: "second", toolName: "read_file" },
    ]);
  });

  it("searches archived content and tool names case-insensitively", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-archive-search-"));
    await appendArchive("run-1", [
      { archivedAt: "2026-05-16T00:00:00.000Z", role: "assistant", content: "Touched src/Auth.ts" },
      { archivedAt: "2026-05-16T00:00:01.000Z", role: "tool", content: "ok", toolName: "apply_patch" },
    ], { workspace });

    expect(await searchArchive("run-1", "auth", { workspace })).toHaveLength(1);
    expect(await searchArchive("run-1", "APPLY", { workspace })).toHaveLength(1);
  });

  it("serializes concurrent appends without interleaving lines", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-archive-concurrent-"));
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      appendArchive("run-1", [
        { archivedAt: `2026-05-16T00:00:0${index}.000Z`, role: "assistant", content: `entry-${index}` },
      ], { workspace }),
    ));

    const raw = readFileSync(join(workspace, ".tanya", "runs", "run-1", "archive.jsonl"), "utf8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(5);
    expect(await readArchive("run-1", { workspace })).toHaveLength(5);
  });

  it("safeAppendArchive routes append failures through onError without throwing", async () => {
    // Workspace points at /dev/null/... so mkdir + appendFile both fail with ENOTDIR.
    const captured: Error[] = [];
    await expect(safeAppendArchive(
      "run-1",
      [{ archivedAt: "2026-05-16T00:00:00.000Z", role: "assistant", content: "first" }],
      { workspace: "/dev/null/no-such-workspace" },
      (err) => {
        captured.push(err);
      },
    )).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
  });

  it("safeAppendArchive swallows errors when no onError is provided", async () => {
    await expect(safeAppendArchive(
      "run-1",
      [{ archivedAt: "2026-05-16T00:00:00.000Z", role: "assistant", content: "first" }],
      { workspace: "/dev/null/no-such-workspace" },
    )).resolves.toBeUndefined();
  });

  it("extracts file-touch paths from archived tool calls", () => {
    const messages: ChatMessage[] = [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "write-1",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "src/secret.ts", content: "token" }),
        },
      }],
    }];

    const archived = toArchivedMessages(messages, "2026-05-16T00:00:00.000Z");

    expect(fileTouchPathsFromArchive(archived)).toEqual(["src/secret.ts"]);
  });
});
