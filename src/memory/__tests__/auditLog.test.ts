import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAuditDecision, auditPath, readAuditDecisions, type AuditDecisionEntry } from "../auditLog";

function entry(partial: Partial<AuditDecisionEntry> = {}): AuditDecisionEntry {
  return {
    ts: "2026-05-16T12:00:00.000Z",
    runId: "run-1",
    tool: "write_file",
    input: { path: "README.md" },
    decision: "allow",
    source: "engine",
    mode: "default",
    ...partial,
  };
}

describe("permission audit log", () => {
  it("appends and reads structured decisions with filters", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-audit-log-"));
    for (let index = 0; index < 10; index += 1) {
      appendAuditDecision(workspace, entry({
        ts: `2026-05-16T12:00:0${index}.000Z`,
        tool: index % 2 === 0 ? "write_file" : "run_shell",
        decision: index % 3 === 0 ? "deny" : "allow",
      }));
    }

    const raw = readFileSync(auditPath(workspace), "utf8").trim().split("\n").map((line) => JSON.parse(line) as AuditDecisionEntry);
    expect(raw).toHaveLength(10);
    expect(readAuditDecisions(workspace, { limit: 3 })).toHaveLength(3);
    expect(readAuditDecisions(workspace, { denyOnly: true }).every((item) => item.decision === "deny")).toBe(true);
    expect(readAuditDecisions(workspace, { tool: "run_shell" }).every((item) => item.tool === "run_shell")).toBe(true);
  });

  it("rotates oversized or stale logs into gzip archives", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-audit-rotate-"));
    appendAuditDecision(workspace, entry());
    writeFileSync(auditPath(workspace), "x".repeat(20), "utf8");
    appendAuditDecision(workspace, entry({ runId: "run-2" }), { maxBytes: 10, now: new Date("2026-05-16T13:00:00.000Z") });

    const archiveDir = join(workspace, ".tanya", "audit", "archive");
    expect(readdirSync(archiveDir).some((name) => name.endsWith(".gz"))).toBe(true);
    expect(readFileSync(auditPath(workspace), "utf8")).toContain("\"runId\":\"run-2\"");

    const oldWorkspace = mkdtempSync(join(tmpdir(), "tanya-audit-stale-"));
    appendAuditDecision(oldWorkspace, entry());
    const old = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(auditPath(oldWorkspace), old, old);
    appendAuditDecision(oldWorkspace, entry({ runId: "run-3" }), {
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:02.000Z"),
    });
    expect(existsSync(join(oldWorkspace, ".tanya", "audit", "archive"))).toBe(true);
  });
});
