import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTaskHistory, buildHistoryBlock, readRecentTaskHistory } from "../src/memory/taskHistory";
import type { TanyaFinalManifest } from "../src/agent/runner";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-history-"));
}

function manifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
  return {
    schemaVersion: 1,
    changedFiles: ["src/index.ts"],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: [],
    git: {
      root: "/tmp/project",
      head: "abc1234",
    },
    toolErrors: 0,
    blockers: [],
    ...overrides,
  };
}

describe("task history memory", () => {
  it("appends compact history entries and reads the latest entries", async () => {
    const root = makeProject();

    await appendTaskHistory(root, "first task", manifest({ changedFiles: ["a.ts"] }));
    await appendTaskHistory(root, "second task", manifest({ changedFiles: ["b.ts"], blockers: ["failed"] }));
    await appendTaskHistory(root, "third task", manifest({ changedFiles: [] }));
    await appendTaskHistory(root, "fourth task", manifest({ changedFiles: ["d.ts"] }));

    const recent = await readRecentTaskHistory(root, 3);

    expect(recent.map((entry) => entry.prompt)).toEqual(["second task", "third task", "fourth task"]);
    expect(recent[0]?.outcome).toBe("blocked");
    expect(recent[2]?.gitHead).toBe("abc1234");
  });

  it("renders a prompt block for recent task history", () => {
    const block = buildHistoryBlock([
      {
        timestamp: "2026-04-29T00:00:00.000Z",
        prompt: "Fix auth route",
        outcome: "passed",
        changedFiles: ["src/lib/auth.ts"],
        gitHead: "abc1234",
      },
    ]);

    expect(block).toContain("## Recent task history");
    expect(block).toContain("[2026-04-29] PASSED");
    expect(block).toContain("src/lib/auth.ts");
  });
});
