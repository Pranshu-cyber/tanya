import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFinalManifest, failedVerificationBlockers } from "../src/agent/report";
import { runAgent } from "../src/agent/runner";
import { verifyFinalState, type Verifier, type VerifierShell } from "../src/agent/verifier";
import type { ChatProvider, ChatRequest } from "../src/providers/types";

type FakeShellCall = { cwd: string; command: string; args: string[] };

function makeFakeShell(
  responder: (call: FakeShellCall) => { exit?: number; stdout?: string; stderr?: string; binaryMissing?: boolean },
): VerifierShell & { calls: FakeShellCall[] } {
  const calls: FakeShellCall[] = [];
  const shell: VerifierShell = async (cwd, command, args) => {
    calls.push({ cwd, command, args });
    const out = responder({ cwd, command, args });
    return {
      exit: out.exit ?? 0,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
      ...(out.binaryMissing ? { binaryMissing: true } : {}),
    };
  };
  return Object.assign(shell, { calls });
}

function writeGoBackend(workspace: string, options: { withMain?: boolean; withTest?: boolean; goMod?: string } = {}) {
  writeFileSync(join(workspace, "go.mod"), options.goMod ?? "module example.com/svc\n\ngo 1.22\n");
  mkdirSync(join(workspace, "internal", "config"), { recursive: true });
  writeFileSync(join(workspace, "internal", "config", "config.go"), "package config\n\nfunc OK() bool { return true }\n");
  if (options.withMain ?? true) {
    mkdirSync(join(workspace, "cmd", "server"), { recursive: true });
    writeFileSync(join(workspace, "cmd", "server", "main.go"), "package main\n\nfunc main() {}\n");
  }
  if (options.withTest) {
    writeFileSync(join(workspace, "internal", "config", "config_test.go"), "package config\n\nimport \"testing\"\n\nfunc TestOK(t *testing.T) { if !OK() { t.Fail() } }\n");
  }
}

describe("verifyFinalState — result aggregation", () => {
  it("passes with warnings when only non-authoritative checks fail", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-warn-pass-"));
    try {
      const verifier: Verifier = {
        id: "aggregate-test",
        platform: "generic",
        appliesTo: () => true,
        run: async () => [
          { id: "auth-1", description: "authoritative one", passed: true, authoritative: true },
          { id: "auth-2", description: "authoritative two", passed: true, authoritative: true },
          { id: "auth-3", description: "authoritative three", passed: true, authoritative: true },
          { id: "soft-1", description: "soft one", passed: true, authoritative: false },
          { id: "soft-2", description: "soft two", passed: true, authoritative: false },
          { id: "soft-fail", description: "soft failed", passed: false, authoritative: false, error: "advisory only" },
        ],
      };

      const result = await verifyFinalState({ workspace, verifiers: [verifier] });

      expect(result.authoritativePassed).toBe(true);
      expect(result.newBlockers).toEqual([]);
      expect(result.warnings).toEqual([
        "final-state check failed: soft failed (advisory only)",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails with blockers when an authoritative check fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-auth-fail-"));
    try {
      const verifier: Verifier = {
        id: "aggregate-test",
        platform: "generic",
        appliesTo: () => true,
        run: async () => [
          { id: "auth-pass", description: "authoritative pass", passed: true, authoritative: true },
          { id: "auth-fail", description: "authoritative failed", passed: false, authoritative: true, error: "must fix" },
          { id: "soft-fail", description: "soft failed", passed: false, authoritative: false, error: "advisory only" },
        ],
      };

      const result = await verifyFinalState({ workspace, verifiers: [verifier] });

      expect(result.authoritativePassed).toBe(false);
      expect(result.newBlockers).toEqual([
        "final-state check failed: authoritative failed (must fix)",
      ]);
      expect(result.warnings).toEqual([
        "final-state check failed: soft failed (advisory only)",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("buildFinalManifest — probe failures at turn-budget termination", () => {
  it("does not keep the last failed probe command as a blocker when final-state Verify passed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-probe-termination-pass-"));
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const verificationLines = [
        "Verification: go vet ./... -> failed (unused import)",
      ];
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot: null,
        changed: [],
        verificationLines,
        toolErrorCount: 1,
        readArtifactPaths: [],
        readContextPaths: [],
        createdArtifactPaths: [],
        blockers: failedVerificationBlockers(verificationLines),
        runContext: { task: { kind: "coding", title: "go-backend-foundation" } },
        prompt: "Initialize Go backend foundation",
        terminationReason: "turn_budget_exhausted",
        verifierShell: makeFakeShell(({ command }) => command === "go" ? { exit: 0 } : { exit: 0 }),
      });

      expect(manifest.finalStateVerification?.authoritativePassed).toBe(true);
      expect(manifest.blockers).not.toContain("failed verification: go vet ./... -> failed (unused import)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the last failed probe command as a blocker when final-state Verify failed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-probe-termination-fail-"));
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const verificationLines = [
        "Verification: go vet ./... -> failed (unused import)",
      ];
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot: null,
        changed: [],
        verificationLines,
        toolErrorCount: 1,
        readArtifactPaths: [],
        readContextPaths: [],
        createdArtifactPaths: [],
        blockers: failedVerificationBlockers(verificationLines),
        runContext: { task: { kind: "coding", title: "go-backend-foundation" } },
        prompt: "Initialize Go backend foundation",
        terminationReason: "turn_budget_exhausted",
        verifierShell: makeFakeShell(({ command, args }) => {
          if (command === "go" && args[0] === "build") return { exit: 1, stderr: "still broken" };
          return { exit: 0 };
        }),
      });

      expect(manifest.finalStateVerification?.authoritativePassed).toBe(false);
      expect(manifest.blockers).toContain("failed verification: go vet ./... -> failed (unused import)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps non-probe failures as blockers even when final-state Verify passed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-probe-termination-nonprobe-"));
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const verificationLines = [
        "Verification: rm -rf important/ -> failed (permission denied)",
      ];
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot: null,
        changed: [],
        verificationLines,
        toolErrorCount: 1,
        readArtifactPaths: [],
        readContextPaths: [],
        createdArtifactPaths: [],
        blockers: failedVerificationBlockers(verificationLines),
        runContext: { task: { kind: "coding", title: "go-backend-foundation" } },
        prompt: "Initialize Go backend foundation",
        terminationReason: "turn_budget_exhausted",
        verifierShell: makeFakeShell(({ command }) => command === "go" ? { exit: 0 } : { exit: 0 }),
      });

      expect(manifest.finalStateVerification?.authoritativePassed).toBe(true);
      expect(manifest.blockers).toContain("failed verification: rm -rf important/ -> failed (permission denied)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("verifyFinalState — go-backend platform", () => {
  it("passes when go.mod, entrypoint, build and test all hold", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-pass-"));
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        if (command === "go" && args[0] === "test") return { exit: 0 };
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Build a Go REST server using Huma, chi router, pgx",
        shell,
      });

      expect(result.ranVerifiers).toContain("go-backend");
      expect(result.authoritativePassed).toBe(true);
      expect(result.newBlockers).toEqual([]);
      expect(result.warnings).toEqual([
        "final-state check failed: go.mod declares huma/v2 (expected huma/v2 dependency in go.mod)",
        "final-state check failed: go.mod declares chi/v5 (expected chi/v5 dependency in go.mod)",
        "final-state check failed: go.mod declares pgx/v5 (expected pgx/v5 dependency in go.mod)",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("authoritativePassed=true when build+test pass even without dep hints", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-clean-pass-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Initialize Go module",
        shell,
      });

      expect(result.authoritativePassed).toBe(true);
      expect(result.newBlockers).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("authoritativePassed=false when go test fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-test-fail-"));
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "test") {
          return { exit: 1, stdout: "FAIL example.com/svc/internal/config", stderr: "" };
        }
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Initialize Go REST server",
        shell,
      });

      expect(result.authoritativePassed).toBe(false);
      expect(result.newBlockers.some((b) => b.includes("go test"))).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("flags missing cmd/server/main.go when prompt asks for REST server", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-no-main-"));
    try {
      writeGoBackend(workspace, { withMain: false });
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Set up a Go REST server in cmd/server",
        shell,
      });

      expect(result.newBlockers).toEqual([]);
      expect(result.warnings).toContain(
        "final-state check failed: cmd/server/main.go exists (expected entrypoint at cmd/server/main.go)",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("flags missing huma/v2 dep when prompt mentions huma", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-missing-huma-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Use Huma for the OpenAPI router",
        shell,
      });

      expect(result.newBlockers).toEqual([]);
      expect(result.warnings).toContain(
        "final-state check failed: go.mod declares huma/v2 (expected huma/v2 dependency in go.mod)",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("warns about missing sqlc-generated dirs when referenced query files exist", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-sqlc-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      writeFileSync(join(workspace, "queries.sql"), "-- name: ListWidgets :many\nSELECT 1;\n");
      writeFileSync(
        join(workspace, "sqlc.yaml"),
        "version: 2\nsql:\n  - schema: schema.sql\n    queries: queries.sql\n    out: internal/db/queries\n",
      );
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Wire up sqlc-generated repositories",
        shell,
      });

      expect(result.newBlockers).toEqual([]);
      expect(result.warnings.some((b) => b.includes("sqlc generated code"))).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("skips sqlc output checks when sqlc.yaml references no existing query files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-sqlc-skipped-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      writeFileSync(
        join(workspace, "sqlc.yaml"),
        "version: 2\nsql:\n  - schema: schema.sql\n    queries: sql/queries/*.sql\n    out: internal/store/gen\n",
      );
      const shell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const result = await verifyFinalState({
        workspace,
        prompt: "Initialize Go backend with sqlc",
        shell,
      });

      const check = result.checks.find((c) => c.id === "sqlc-out-internal/store/gen");
      expect(check).toMatchObject({
        passed: true,
        authoritative: false,
        skipped: true,
      });
      expect(result.newBlockers).toEqual([]);
      expect(result.warnings.some((b) => b.includes("sqlc generated code"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("skips toolchain checks when go binary is missing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-verifier-go-no-toolchain-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      const shell = makeFakeShell(() => ({ binaryMissing: true }));

      const result = await verifyFinalState({
        workspace,
        prompt: "Initialize Go module",
        shell,
      });

      expect(result.checks.some((c) => c.id === "go-toolchain-missing")).toBe(true);
      expect(result.authoritativePassed).toBe(false);
      expect(result.newBlockers).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function makeProvider(responses: string[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "test",
    model: "test-model",
    requests,
    async *streamChat(input: ChatRequest) {
      requests.push({ ...input, messages: [...input.messages] });
      yield { content: responses[Math.min(requests.length - 1, responses.length - 1)] ?? "" };
    },
  };
}

describe("runAgent final-state recovery", () => {
  it("downgrades probe + bootstrap + generator failures to recovered when verifier authoritatively passes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-runner-recover-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      const provider: ChatProvider & { requests: ChatRequest[] } = {
        id: "test",
        model: "test-model",
        requests: [],
        async *streamChat(input: ChatRequest) {
          provider.requests.push({ ...input, messages: [...input.messages] });
          if (provider.requests.length === 1) {
            yield {
              content: "Probing.",
              toolCalls: [
                {
                  id: "probe-cat",
                  type: "function",
                  function: {
                    name: "run_shell",
                    arguments: JSON.stringify({ command: `cd ${workspace} && cat MISSING_README.md 2>&1` }),
                  },
                },
                {
                  id: "broad-rm",
                  type: "function",
                  function: {
                    name: "run_shell",
                    arguments: JSON.stringify({ command: `cd ${workspace} && git rm -r legacy/ 2>&1` }),
                  },
                },
                {
                  id: "sqlc-attempt",
                  type: "function",
                  function: {
                    name: "run_shell",
                    arguments: JSON.stringify({ command: `cd ${workspace} && sqlc generate 2>&1` }),
                  },
                },
              ],
            };
            return;
          }
          yield {
            content: [
              "Modified: go.mod",
              "Artifact reused: none",
              "Artifact created: none",
              "Blocked: none",
            ].join("\n"),
          };
        },
      };
      const verifierShell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const { message, manifest } = await runAgent({
        provider,
        prompt: "Bootstrap a Go REST server.",
        cwd: workspace,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Generic Go bootstrap" },
          expected_report: { verification: true },
        },
        verifierShell,
      });

      expect(manifest.finalStateVerification?.authoritativePassed).toBe(true);
      expect(manifest.blockers).toEqual([]);
      expect(manifest.verification.join("\n")).toMatch(/recovered \(final-state verifier authoritative checks passed\)/);
      expect(message.trim()).toMatch(/TANYA RESULT: PASSED$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not keep stale blockers when the same check later passes with exit echo", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-runner-exit-echo-recover-"));
    const check = `cd ${workspace} && test "$(cat marker 2>/dev/null)" = ok`;
    const checkWithExitEcho = `${check} 2>&1; echo "EXIT=$?"`;
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const provider: ChatProvider & { requests: ChatRequest[] } = {
        id: "test",
        model: "test-model",
        requests: [],
        async *streamChat(input: ChatRequest) {
          provider.requests.push({ ...input, messages: [...input.messages] });
          if (provider.requests.length === 1) {
            yield {
              content: "Run initial verification.",
              toolCalls: [
                {
                  id: "initial-check-fails",
                  type: "function",
                  function: {
                    name: "run_shell",
                    arguments: JSON.stringify({ command: check }),
                  },
                },
              ],
            };
            return;
          }
          if (provider.requests.length === 2) {
            yield {
              content: "Repair and rerun.",
              toolCalls: [
                {
                  id: "write-marker",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "marker", content: "ok\n" }),
                  },
                },
                {
                  id: "rerun-check-passes",
                  type: "function",
                  function: {
                    name: "run_shell",
                    arguments: JSON.stringify({ command: checkWithExitEcho }),
                  },
                },
              ],
            };
            return;
          }
          yield {
            content: [
              "Modified: marker",
              "Artifact reused: none",
              "Artifact created: none",
              `Verification: ${checkWithExitEcho} -> passed`,
              "Blocked: none",
            ].join("\n"),
          };
        },
      };
      const verifierShell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        if (command === "go" && args[0] === "test") return { exit: 0 };
        return { exit: 0 };
      });

      const { message, manifest } = await runAgent({
        provider,
        prompt: "Bootstrap a Go REST server.",
        cwd: workspace,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Generic Go bootstrap" },
          expected_report: { verification: true },
        },
        verifierShell,
      });

      expect(manifest.blockers).toEqual([]);
      expect(manifest.verification.join("\n")).not.toMatch(/->\s*failed\b/i);
      expect(message).not.toContain("failed verification:");
      expect(message.trim()).toMatch(/TANYA RESULT: PASSED$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits FAIL when go test fails on the final state", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-runner-go-test-fail-"));
    try {
      writeGoBackend(workspace, { withMain: true, withTest: true });
      const provider = makeProvider([
        [
          "Modified: go.mod",
          "Artifact reused: none",
          "Artifact created: none",
          `Verification: cd ${workspace} && go test ./... -count=1 2>&1 -> passed`,
          "Blocked: none",
        ].join("\n"),
      ]);
      const verifierShell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "test") {
          return { exit: 1, stdout: "FAIL example.com/svc", stderr: "" };
        }
        return { exit: 0 };
      });

      const { message, manifest } = await runAgent({
        provider,
        prompt: "Bootstrap a Go REST server.",
        cwd: workspace,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Generic Go bootstrap" },
          expected_report: { verification: true },
        },
        verifierShell,
      });

      expect(manifest.finalStateVerification?.authoritativePassed).toBe(false);
      expect(manifest.blockers.some((b) => b.includes("go test"))).toBe(true);
      expect(message.trim()).toMatch(/TANYA RESULT: FAIL$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits PASS with a warning when a non-authoritative dependency check fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-runner-missing-dep-"));
    try {
      writeGoBackend(workspace, { withMain: true });
      const provider = makeProvider([
        [
          "Modified: go.mod",
          "Artifact reused: none",
          "Artifact created: none",
          `Verification: cd ${workspace} && go build ./... -> passed`,
          "Blocked: none",
        ].join("\n"),
      ]);
      const verifierShell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const { message, manifest } = await runAgent({
        provider,
        prompt: "Use Huma to expose REST endpoints in cmd/server.",
        cwd: workspace,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Bootstrap Go Huma server" },
          expected_report: { verification: true },
        },
        verifierShell,
      });

      expect(manifest.blockers).toEqual([]);
      expect(manifest.finalStateVerification?.warnings.some((b) => b.includes("huma/v2"))).toBe(true);
      expect(message.trim()).toMatch(/TANYA RESULT: PASSED$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits PASS with a warning when a non-authoritative file check fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-runner-missing-main-"));
    try {
      writeGoBackend(workspace, { withMain: false });
      const provider = makeProvider([
        [
          "Modified: go.mod",
          "Artifact reused: none",
          "Artifact created: none",
          `Verification: cd ${workspace} && go build ./... -> passed`,
          "Blocked: none",
        ].join("\n"),
      ]);
      const verifierShell = makeFakeShell(({ command, args }) => {
        if (command === "go" && args[0] === "build") return { exit: 0 };
        if (command === "go" && args[0] === "vet") return { exit: 0 };
        return { exit: 0 };
      });

      const { message, manifest } = await runAgent({
        provider,
        prompt: "Set up the REST server in cmd/server.",
        cwd: workspace,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Generic Go REST bootstrap" },
          expected_report: { verification: true },
        },
        verifierShell,
      });

      expect(manifest.blockers).toEqual([]);
      expect(manifest.finalStateVerification?.warnings.some((b) => b.includes("cmd/server/main.go"))).toBe(true);
      expect(message.trim()).toMatch(/TANYA RESULT: PASSED$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
