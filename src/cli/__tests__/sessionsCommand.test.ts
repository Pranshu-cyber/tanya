import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSessionList, parseDurationMs } from "../sessionsCommand";
import type { SessionSummary } from "../../sessions/types";

describe("sessions command formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats list output in fixed readable columns", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T22:00:00.000Z"));
    const sessions: SessionSummary[] = [
      {
        id: "20260517-214851-abc123",
        createdAt: "2026-05-17T21:48:51.234Z",
        lastUpdatedAt: "2026-05-17T21:57:00.000Z",
        cwd: "/tmp/project",
        provider: "deepseek",
        model: "deepseek-chat",
        label: "Add a /search endpoint to the notes API and run the tests",
        turnCount: 12,
        path: "/tmp/project/.tania/sessions/20260517-214851-abc123.json",
        scope: "project",
      },
    ];

    expect(formatSessionList(sessions, 100)).toMatchInlineSnapshot(`
      "ID                       AGE        TURNS  LABEL
      20260517-214851-abc123   3 min ago     12 Add a /search endpoint to the notes API and run the tests
      "
    `);
  });

  it("parses prune durations", () => {
    expect(parseDurationMs("30d")).toBe(30 * 86_400_000);
    expect(parseDurationMs("12h")).toBe(12 * 3_600_000);
  });
});
