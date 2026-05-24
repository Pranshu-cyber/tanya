import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/runner";
import { readRepairRunMemory } from "../src/memory/repairRuns";
import type { ChatProvider, ChatRequest } from "../src/providers/types";
import type { TanyaEvent } from "../src/events/types";

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

describe("runAgent final report recovery", () => {
  it("emits token metrics and writes a run log", async () => {
    const provider: ChatProvider = {
      id: "deepseek",
      model: "deepseek-chat",
      async *streamChat() {
        yield { usage: { promptTokens: 123, completionTokens: 45 } };
        yield { content: "Done." };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-token-log-"));
    const events: TanyaEvent[] = [];

    try {
      await runAgent({
        provider,
        prompt: "Summarize setup.",
        cwd,
        sink: async (event) => {
          events.push(event);
        },
      });

      const finalEvent = events.find((event) => event.type === "final");
      expect(finalEvent?.type === "final" ? finalEvent.metrics?.promptTokens : undefined).toBe(123);
      expect(finalEvent?.type === "final" ? finalEvent.metrics?.completionTokens : undefined).toBe(45);
      const costUsd = finalEvent?.type === "final" ? finalEvent.metrics?.costUsd : undefined;
      expect(typeof costUsd).toBe("number");
      expect(costUsd).toBeCloseTo((123 / 1_000_000) * 0.27 + (45 / 1_000_000) * 1.10);
      const logs = readdirSync(join(cwd, ".tania", "runs")).filter((file) => file.endsWith(".json"));
      expect(logs.length).toBe(1);
      const log = JSON.parse(readFileSync(join(cwd, ".tania", "runs", logs[0] ?? ""), "utf8")) as {
        promptTokens: number;
        completionTokens: number;
        model: string;
      };
      expect(log.promptTokens).toBe(123);
      expect(log.completionTokens).toBe(45);
      expect(log.model).toBe("deepseek-chat");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns structured tool schema errors for missing required fields", async () => {
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        yield {
          content: "Writing file.",
          toolCalls: [
            {
              id: "write-missing-content",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "README.md" }),
              },
            },
          ],
        };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Write readme.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-schema-missing-")),
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
    });

    expect(events.some((event) =>
      event.type === "tool_result" &&
      event.ok === false &&
      event.summary === 'Missing required field: "content"'
    )).toBe(true);
  });

  it("returns structured tool schema errors for wrong required field types", async () => {
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        yield {
          content: "Writing file.",
          toolCalls: [
            {
              id: "write-wrong-type",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: 123, content: "demo" }),
              },
            },
          ],
        };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Write readme.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-schema-type-")),
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
    });

    expect(events.some((event) =>
      event.type === "tool_result" &&
      event.ok === false &&
      event.summary === 'Field "path" must be string, got number'
    )).toBe(true);
  });

  it("asks for a coding final report when the model stops without one", async () => {
    const provider = makeProvider([
      "The existing setup looks good.",
      "Verification-only: existing setup satisfied\nVerification: xcodebuild -list -> passed\nNo blockers.",
    ]);
    const events: TanyaEvent[] = [];

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-report-")),
      sink: async (event) => { events.push(event); },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("produce the final coding report");
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(events.some((event) => event.type === "final")).toBe(true);
  });

  it("returns a fallback coding report when tool turns are exhausted after verification", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Checking build.",
          toolCalls: [
            {
              id: `call-${provider.requests.length}`,
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ script: "echo ok" }),
              },
            },
          ],
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-limit-report-")),
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Stopped after reaching the tool-turn limit.");
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(result).toContain("Verification: echo ok -> passed");
  });

  it("includes artifact provenance in fallback coding reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Checking artifact.",
          toolCalls: [
            {
              id: "read-artifact",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: ".tania/artifacts/ios/FastlaneSetup.md" }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-report-"));
    mkdirSync(join(cwd, ".tania", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "artifacts", "ios", "FastlaneSetup.md"), "fastlane");

    const events: TanyaEvent[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tania/artifacts/example.md",
            sourcePath: "artifacts/example.md",
            status: "available",
          },
        ],
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/ios/FastlaneSetup.md");
    expect(result).toContain("Verification-only: existing setup satisfied");
    const finalEvent = events.find((event) => event.type === "final");
    expect(finalEvent?.manifest?.artifactsRead).toEqual(["artifacts/ios/FastlaneSetup.md"]);
  });

  it("strips prose artifact reuse claims from zero-change verification-only reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking existing Android splash.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/android/SplashScreenPattern.kt" }),
                },
              },
              {
                id: "verify",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "./gradlew assembleDebug --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "**Verification-only: existing setup satisfied**",
            "- `Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/SplashScreen.kt` (already adapted)",
            "- `Artifact created: none`",
            "- `Modified: none`",
            "- `Verification: ./gradlew assembleDebug --no-daemon -> BUILD SUCCESSFUL`",
            "- `Blocked: none`",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-zero-change-strip-artifact-prose-"));
    mkdirSync(join(cwd, ".tania", "artifacts", "android"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "artifacts", "android", "SplashScreenPattern.kt"), "splash");

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify Android splash.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Splash Screen - Android" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/SplashScreen.kt");
    expect(result).toContain("Verification-only: existing setup satisfied");
  });

  it("does not claim caller-provided artifacts when the model changes files without reading them", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Creating file.",
          toolCalls: [
            {
              id: "write-file",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "App/Setup.swift", content: "import SwiftUI\n" }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-provided-artifact-report-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Do setup.",
      cwd,
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tania/artifacts/example.md",
            sourcePath: "artifacts/example.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).toContain("core-artifact-provenance-missing");
    expect(result).toContain("Modified: App/Setup.swift");
  });

  it("filters Xcode DerivedData from deterministic changed-file reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Writing setup and build output.",
          toolCalls: [
            {
              id: "write-config",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: ".swiftlint.yml", content: "disabled_rules: []\n" }),
              },
            },
            {
              id: "write-derived-data",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "DerivedData-Build/Logs/Build/LogStoreManifest.plist", content: "generated\n" }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-derived-data-report-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Set up iOS.",
      cwd,
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding", title: "Setup Environment - iOS" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: .swiftlint.yml");
    expect(result).not.toContain("Modified: DerivedData-Build");
  });

  it("uses manifest artifact targets when model prose under-reports reused files", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading setup artifact.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/ios/FastlaneSetup.md" }),
                },
              },
              {
                id: "write-fastfile",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "fastlane/Fastfile", content: "lane :build do\nend\n" }),
                },
              },
              {
                id: "write-appfile",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "fastlane/Appfile", content: "app_identifier(\"x\")\n" }),
                },
              },
              {
                id: "write-swiftlint",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: ".swiftlint.yml", content: "disabled_rules: []\n" }),
                },
              },
              {
                id: "verify-fastfile",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "ruby -c fastlane/Fastfile" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/FastlaneSetup.md -> fastlane/Fastfile",
            "Artifact created: none",
            "Modified: fastlane/Fastfile",
            "Modified: fastlane/Appfile",
            "Verification: ruby -c fastlane/Fastfile -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-targets-"));
    mkdirSync(join(cwd, ".tania", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "artifacts", "ios", "FastlaneSetup.md"), "fastlane");

    const { message: result } = await runAgent({
      provider,
      prompt: "Set up iOS.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Setup Environment - iOS" },
        artifacts: [{ path: ".tania/artifacts/ios/FastlaneSetup.md", sourcePath: "artifacts/ios/FastlaneSetup.md", status: "available" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/FastlaneSetup.md -> fastlane/Appfile, fastlane/Fastfile");
    expect(result).not.toContain("Artifact reused: artifacts/ios/FastlaneSetup.md -> .swiftlint.yml");
  });

  it("does not synthesize artifact reuse when the final report explicitly says none", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking artifact.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/testing/OpenApiDtoGeneration.md" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Creating setup file.",
            toolCalls: [
              {
                id: "write-file",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "App/Setup.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Summary: setup complete.",
            "Artifact reused: none — matched artifacts were read for context but not directly copied.",
            "Artifact created: none",
            "Modified: App/Setup.swift",
            "Verification: swift build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-none-report-"));
    mkdirSync(join(cwd, ".tania", "artifacts", "testing"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "artifacts", "testing", "OpenApiDtoGeneration.md"), "openapi");

    const { message: result } = await runAgent({
      provider,
      prompt: "Do setup.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tania/artifacts/testing/OpenApiDtoGeneration.md",
            sourcePath: "artifacts/testing/OpenApiDtoGeneration.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/testing/OpenApiDtoGeneration.md");
  });

  it("uses git changes in fallback reports and ignores backup files", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Implementing splash.",
          toolCalls: [
            {
              id: "commit-files",
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({
                  script: [
                    "mkdir -p App/Assets.xcassets/SplashIcon.imageset",
                    "printf 'app\\n' > App/CosaNostraApp.swift",
                    "printf 'splash\\n' > App/SplashScreenView.swift",
                    "printf '{}\\n' > App/Assets.xcassets/SplashIcon.imageset/Contents.json",
                    "printf '{}\\n' > App/Assets.xcassets/SplashIcon.imageset/Contents.json.orig",
                    "git add App/CosaNostraApp.swift App/SplashScreenView.swift App/Assets.xcassets/SplashIcon.imageset/Contents.json",
                    "git commit -m splash",
                  ].join(" && "),
                }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-git-report-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });

    const events: TanyaEvent[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Create splash.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        metadata: { requireCommit: true },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: App/CosaNostraApp.swift");
    expect(result).toContain("Modified: App/SplashScreenView.swift");
    expect(result).toContain("Modified: App/Assets.xcassets/SplashIcon.imageset/Contents.json");
    expect(result).not.toContain("Modified: App/Assets.xcassets/SplashIcon.imageset/Contents.json.orig");
    expect(existsSync(join(cwd, "App/Assets.xcassets/SplashIcon.imageset/Contents.json.orig"))).toBe(false);
    expect(events.some((event) => event.type === "final" && (event.files ?? []).includes("App/CosaNostraApp.swift"))).toBe(true);
  });

  it("scopes git fallback reports to the current nested workspace", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Implementing Android setup.",
          toolCalls: [
            {
              id: "commit-files",
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({
                  script: [
                    "mkdir -p app/src/main/java ../ios/App",
                    "printf 'android\\n' > app/src/main/java/MainActivity.kt",
                    "printf 'ios\\n' > ../ios/App/SplashScreenView.swift",
                    "git -C .. add android/app/src/main/java/MainActivity.kt ios/App/SplashScreenView.swift",
                    "git -C .. commit -m platform-changes",
                  ].join(" && "),
                }),
              },
            },
          ],
        };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "tanya-runner-nested-report-"));
    mkdirSync(join(repo, "android"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    const { message: result } = await runAgent({
      provider,
      prompt: "Configure Android.",
      cwd: join(repo, "android"),
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tania/artifacts/testing/OpenApiDtoGeneration.md",
            sourcePath: "artifacts/testing/OpenApiDtoGeneration.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Modified: app/src/main/java/MainActivity.kt");
    expect(result).not.toContain("Modified: ../ios/App/SplashScreenView.swift");
    expect(result).not.toContain("Modified: ios/App/SplashScreenView.swift");
    expect(result).toContain("Artifact reused: none");
    expect(result).toContain("core-artifact-provenance-missing");
  });

  it("normalizes repo-prefixed tool paths for nested workspace reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating file.",
            toolCalls: [
              {
                id: "write-file",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "mkdir -p app/src/main/java && printf 'android\\n' > app/src/main/java/MainActivity.kt" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Committing with repo-prefixed path.",
            toolCalls: [
              {
                id: "commit-file",
                type: "function",
                function: {
                  name: "commit_platform_changes",
                  arguments: JSON.stringify({
                    files: ["android/app/src/main/java/MainActivity.kt"],
                    message: "[Android] Add main activity",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none — matched artifacts were read for context but not directly copied.",
            "Artifact created: none",
            "Modified: android/app/src/main/java/MainActivity.kt",
            "Verification: git rev-parse --short HEAD -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "tanya-runner-nested-prefixed-report-"));
    mkdirSync(join(repo, "android"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    const { message: result } = await runAgent({
      provider,
      prompt: "Configure Android.",
      cwd: join(repo, "android"),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        metadata: { requireCommit: true },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: app/src/main/java/MainActivity.kt");
    expect(result).not.toContain("Modified: android/app/src/main/java/MainActivity.kt");
  });

  it("reruns duplicate verification commands after a file mutation", async () => {
    const toolSummaries: string[] = [];
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Write v1.",
            toolCalls: [
              {
                id: "write-v1",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "Info.plist", content: "v1\n" }) },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Verify v1.",
            toolCalls: [
              {
                id: "verify-v1",
                type: "function",
                function: { name: "run_shell", arguments: JSON.stringify({ script: "cat Info.plist" }) },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: "Write v2.",
            toolCalls: [
              {
                id: "write-v2",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "Info.plist", content: "v2\n" }) },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Verify v2.",
            toolCalls: [
              {
                id: "verify-v2",
                type: "function",
                function: { name: "run_shell", arguments: JSON.stringify({ script: "cat Info.plist" }) },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: Info.plist",
            "Verification: cat Info.plist -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    await runAgent({
      provider,
      prompt: "Update plist.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-verify-after-mutation-")),
      sink: async (event) => {
        if (event.type === "tool_result") toolSummaries.push(event.summary);
      },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(toolSummaries.filter((summary) => summary.includes("Skipped duplicate verification"))).toHaveLength(0);
  });

  it("skips absolute reads outside the workspace without counting a tool error", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading safety rules.",
            toolCalls: [
              {
                id: "external-read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "/tmp/outside-workspace/safety.md" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: skipped external safety read -> passed\nModified: none",
        };
      },
    };

    const toolResults: TanyaEvent[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-external-read-")),
      sink: async (event) => { toolResults.push(event); },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(toolResults.some((event) => event.type === "tool_result" && event.ok === true && event.summary.includes("Skipped external path outside workspace"))).toBe(true);
    expect(toolResults.some((event) => event.type === "final" && event.metrics?.toolErrorCount === 0)).toBe(true);
  });

  it("does not report files from failed patch attempts as modified", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Trying a patch.",
            toolCalls: [
              {
                id: "bad-patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: JSON.stringify({
                    patch: "--- a/App/Setup.swift\n+++ b/App/Setup.swift\n@@ -99,1 +99,1 @@\n-missing\n+changed\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: existing setup check -> passed\nModified: none",
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-failed-patch-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: none");
    expect(result).not.toContain("Modified: App/Setup.swift");
  });

  it("skips duplicate successful build and test verification commands", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length <= 4) {
          const script = provider.requests.length === 1
            ? "printf '#!/bin/sh\\necho ok\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App"
            : provider.requests.length === 2
              ? "PATH=$PWD:$PATH xcodebuild build -scheme App"
              : provider.requests.length === 3
                ? "PATH=$PWD:$PATH xcodebuild test -scheme App"
                : "PATH=$PWD:$PATH xcodebuild test -scheme App";
          yield {
            content: "Verifying build.",
            toolCalls: [
              {
                id: `call-${provider.requests.length}`,
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script }),
                },
              },
            ],
          };
          shellRuns += 1;
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: xcodebuild build -scheme App -> passed\nModified: none",
        };
      },
    };

    const toolSummaries: string[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-duplicate-build-")),
      sink: async (event) => {
        if (event.type === "tool_result") toolSummaries.push(event.summary);
      },
      maxTurns: 4,
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(shellRuns).toBe(4);
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(toolSummaries.filter((summary) => summary.includes("Skipped duplicate verification"))).toHaveLength(2);
  });

  it("does not treat an unsafe piped xcodebuild command as duplicate coverage for a direct build", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length <= 2) {
          const script = provider.requests.length === 1
            ? "printf '#!/bin/sh\\necho ok\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App 2>&1 | tail -5"
            : "PATH=$PWD:$PATH xcodebuild build -scheme App";
          yield {
            content: "Verifying build.",
            toolCalls: [
              {
                id: `call-${provider.requests.length}`,
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script }),
                },
              },
            ],
          };
          shellRuns += 1;
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: xcodebuild build -scheme App -> passed\nModified: none",
        };
      },
    };

    const toolSummaries: string[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-xcodebuild-pipe-")),
      sink: async (event) => {
        if (event.type === "tool_result") toolSummaries.push(event.summary);
      },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(shellRuns).toBe(2);
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(toolSummaries.filter((summary) => summary.includes("Skipped duplicate verification"))).toHaveLength(0);
  }, 10_000);

  it("does not keep failed Fastlane output probes as blockers after build verification recovers", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking Fastlane output.",
            toolCalls: [
              {
                id: "failed-grep",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "fastlane ios build 2>&1 | grep -E 'BUILD SUCCEEDED'" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Verifying with xcodebuild.",
            toolCalls: [
              {
                id: "passed-build",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "printf '#!/bin/sh\\nexit 0\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: none",
            "Verification-only: existing setup satisfied",
            "Verification: xcodebuild build -scheme App -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify iOS Fastlane setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-fastlane-recovery-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: fastlane ios build");
  });

  it("removes untracked Fastlane generated noise before finalizing coding reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Running Fastlane.",
            toolCalls: [
              {
                id: "make-fastlane-noise",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({
                    script: "mkdir -p fastlane/test_output && printf '# Generated\\n' > fastlane/README.md && printf '<testsuite />\\n' > fastlane/report.xml && printf 'log\\n' > fastlane/test_output/output.log",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: none",
            "Verification-only: existing setup satisfied",
            "Verification: fastlane lanes -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-fastlane-noise-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Configure Fastlane.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(existsSync(join(cwd, "fastlane/README.md"))).toBe(false);
    expect(existsSync(join(cwd, "fastlane/report.xml"))).toBe(false);
    expect(existsSync(join(cwd, "fastlane/test_output"))).toBe(false);
    expect(result).not.toContain("Modified: fastlane/README.md");
    expect(result).not.toContain("Modified: fastlane/report.xml");
  });

  it("does not keep recovered ktlint and git add attempts as blockers", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking ktlint.",
            toolCalls: [
              {
                id: "failed-ktlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "exit 1 # ./gradlew ktlintCheck --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Rechecking ktlint.",
            toolCalls: [
              {
                id: "passed-ktlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "true # ./gradlew ktlintCheck --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: "Trying git add from nested cwd.",
            toolCalls: [
              {
                id: "failed-git-add",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "git add android/app/build.gradle.kts" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Retrying git add from repo root.",
            toolCalls: [
              {
                id: "passed-git-add",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "true # git -C /tmp/repo add android/app/build.gradle.kts" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: app/build.gradle.kts",
            "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
            "Verification: git -C /tmp/repo add android/app/build.gradle.kts -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-ktlint-git-recovery-"));
    execFileSync("git", ["init"], { cwd });
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify Android setup.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: exit 1 # ./gradlew ktlintCheck");
    expect(result).not.toContain("failed verification: git add android/app/build.gradle.kts");
  });

  it("repairs missing Android Gradle verification before finalizing", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Updating Android file.",
            toolCalls: [
              {
                id: "write-main",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "app/src/main/java/com/example/MainActivity.kt",
                    content: "package com.example\nfun ready() = true\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: app/src/main/java/com/example/MainActivity.kt",
              "Verification: not run -> omitted",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 3) {
          expect(input.messages.some((message) =>
            typeof message.content === "string" &&
            message.content.includes("./gradlew ktlintCheck --no-daemon")
          )).toBe(true);
          yield {
            content: "Repairing Android verification.",
            toolCalls: [
              {
                id: "assemble",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "./gradlew assembleDebug --no-daemon" }),
                },
              },
              {
                id: "ktlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "./gradlew ktlintCheck --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: app/src/main/java/com/example/MainActivity.kt",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-android-gradle-repair-"));
    writeFileSync(join(cwd, "gradlew"), "#!/bin/sh\necho BUILD SUCCESSFUL\n");
    execFileSync("chmod", ["+x", "gradlew"], { cwd });
    writeFileSync(join(cwd, "build.gradle.kts"), "plugins { id(\"org.jlleitschuh.gradle.ktlint\") version \"12.1.1\" }\n");

    const { message: result, manifest } = await runAgent({
      provider,
      prompt: "Update Android MainActivity.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Android simple task" },
        expected_report: { verification: true },
      },
    });

    expect(manifest.validation?.passed).toBe(true);
    expect(result).toContain("Verification: ./gradlew assembleDebug --no-daemon -> passed");
    expect(result).toContain("Verification: ./gradlew ktlintCheck --no-daemon -> passed");
    expect(result).toContain("Blocked: none");
  });

  it("does not keep failed grep absence probes as blockers when the final report explains no matches", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking for old references.",
            toolCalls: [
              {
                id: "grep-old-references",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "grep -r \"old_color\" app/src 2>/dev/null" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: app/src/main/java/com/example/AppTheme.kt",
            "Verification: grep -r \"old_color\" app/src 2>/dev/null -> failed",
            "No old references remain; no matches were found.",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-grep-absence-"));
    mkdirSync(join(cwd, "app/src"), { recursive: true });

    const { message: result } = await runAgent({
      provider,
      prompt: "Remove old color references.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: grep -r \"old_color\"");
  });

  it("does not keep failed exploratory project probes as blockers after a stronger build passes", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking Xcode project entries.",
            toolCalls: [
              {
                id: "failed-project-grep",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "grep -c \"Theme/Colors.swift\" CosaNostra.xcodeproj/project.pbxproj" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Running stronger build verification.",
            toolCalls: [
              {
                id: "passed-xcodebuild",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "printf '#!/bin/sh\\nexit 0\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator'" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: CosaNostra/Theme/Colors.swift",
            "Verification: xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator' -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Build iOS foundation.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-project-probe-recovery-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Fundações - iOS" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: grep -c \"Theme/Colors.swift\"");
  });

  it("does not map read-only iOS artifacts to unrelated changed files", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading multiple artifacts and changing theme.",
            toolCalls: [
              {
                id: "read-theme",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/ios/ThemeSystem.swift" }),
                },
              },
              {
                id: "read-offline",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/ios/OfflineCachePatterns.swift" }),
                },
              },
              {
                id: "write-colors",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Theme/Colors.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/ThemeSystem.swift -> CosaNostra/Theme/Colors.swift",
            "Artifact created: none",
            "Modified: CosaNostra/Theme/Colors.swift",
            "Verification: swift build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-precise-ios-"));
    mkdirSync(join(cwd, ".tania/artifacts/ios"), { recursive: true });
    writeFileSync(join(cwd, ".tania/artifacts/ios/ThemeSystem.swift"), "theme");
    writeFileSync(join(cwd, ".tania/artifacts/ios/OfflineCachePatterns.swift"), "offline");

    const { message: result } = await runAgent({
      provider,
      prompt: "Build iOS theme.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/ThemeSystem.swift -> CosaNostra/Theme/Colors.swift");
    expect(result).not.toContain("OfflineCachePatterns.swift -> CosaNostra/Theme/Colors.swift");
  });

  it("adds targeted iOS splash repair instructions after validation catches prompt contract violations", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash with the required high-level tool.",
            toolCalls: [
              {
                id: "create-splash",
                type: "function",
                function: {
                  name: "create_ios_splash",
                  arguments: JSON.stringify({
                    viewPath: "CosaNostra/SplashScreenView.swift",
                    assetSetDir: "CosaNostra/Assets.xcassets/SplashIcon.imageset",
                    brandHex: "#A52A2A",
                    durationMs: 1200,
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Accidentally adding prohibited details.",
            toolCalls: [
              {
                id: "write-bad-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: [
                      "import SwiftUI",
                      "struct SplashScreenView: View {",
                      "  @State private var isReady = false",
                      "  var body: some View {",
                      "    ZStack {",
                      "      LinearGradient(colors: [.red, .black], startPoint: .top, endPoint: .bottom)",
                      "      Image(\"SplashIcon\").scaleEffect(isReady ? 1 : 0.9)",
                      "      Text(\"Cosa Nostra\")",
                      "    }",
                      "    .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
                      "  }",
                      "}",
                    ].join("\n"),
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: [
              "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift",
              "Artifact created: none",
              "Modified: CosaNostra/SplashScreenView.swift",
              "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
              "Verification: xcodebuild build -> passed",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Applying validation repair.",
            toolCalls: [
              {
                id: "fix-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: [
                      "import SwiftUI",
                      "struct SplashScreenView: View {",
                      "  @State private var isReady = false",
                      "  var body: some View {",
                      "    ZStack {",
                      "      Color(red: 165/255, green: 42/255, blue: 42/255)",
                      "      Image(\"SplashIcon\").opacity(isReady ? 1 : 0)",
                      "    }",
                      "    .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
                      "  }",
                      "}",
                    ].join("\n"),
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 5) {
          yield {
            content: "Rerunning verification after repair.",
            toolCalls: [
              {
                id: "verify-repair",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "echo xcodebuild ok" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Verification: echo xcodebuild ok -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-ios-splash-repair-"));
    const memoryHome = mkdtempSync(join(tmpdir(), "tanya-repair-memory-"));
    const previousMemoryHome = process.env.TANYA_MEMORY_HOME;
    process.env.TANYA_MEMORY_HOME = memoryHome;
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}");

    try {
      const { message: result } = await runAgent({
        provider,
        prompt: "Create iOS splash screen with solid background. No taglines, no text. Brief fade-in animation on the icon, nothing else.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Splash Screen — iOS" },
          expected_report: { verification: true, artifact_reuse: true },
          metadata: {
            validationPrompt: "Create iOS splash screen with solid background. No taglines, no text. Brief fade-in animation on the icon, nothing else.",
            caller: "test",
          },
        },
      });

      const repairPrompt = String(provider.requests[3]?.messages.at(-1)?.content ?? "");
      expect(repairPrompt).toContain("Repair attempt 1 of 2");
      expect(repairPrompt).toContain("remove LinearGradient/RadialGradient/AngularGradient");
      expect(repairPrompt).toContain("remove all Text(...) views");
      expect(repairPrompt).toContain("remove pulse, scale, rotation");
      expect(result).toContain("Blocked: none");
      const memory = await readRepairRunMemory();
      expect(memory).toHaveLength(1);
      expect(memory[0]?.outcome).toBe("passed");
      expect(memory[0]?.attempts[0]?.issueIds).toEqual(expect.arrayContaining([
        "ios-splash-solid-background-violated",
        "ios-splash-text-forbidden",
      ]));
    } finally {
      if (previousMemoryHome === undefined) {
        delete process.env.TANYA_MEMORY_HOME;
      } else {
        process.env.TANYA_MEMORY_HOME = previousMemoryHome;
      }
    }
  });

  it("does not keep failed file copy setup after a later copy succeeds", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Copying the splash asset.",
            toolCalls: [
              {
                id: "failed-cp",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "cp brand/icons/android/xxxhdpi-192x192.png android/app/src/main/res/drawable/ic_splash_logo.png" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Creating the directory and retrying.",
            toolCalls: [
              {
                id: "passed-cp",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "mkdir -p android/app/src/main/res/drawable && cp brand/icons/android/xxxhdpi-192x192.png android/app/src/main/res/drawable/ic_splash_logo.png" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/SplashScreen.kt",
            "Artifact created: none",
            "Modified: android/app/src/main/res/drawable/ic_splash_logo.png",
            "Verification: mkdir -p android/app/src/main/res/drawable && cp brand/icons/android/xxxhdpi-192x192.png android/app/src/main/res/drawable/ic_splash_logo.png -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-copy-recovery-"));
    mkdirSync(join(cwd, "brand/icons/android"), { recursive: true });
    mkdirSync(join(cwd, "android/app/src/main/res"), { recursive: true });
    writeFileSync(join(cwd, "brand/icons/android/xxxhdpi-192x192.png"), "png");
    execFileSync("git", ["init"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Copy Android splash asset.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [{ sourcePath: "artifacts/android/SplashScreenPattern.kt", path: "artifacts/android/SplashScreenPattern.kt" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: cp brand/icons/android/xxxhdpi-192x192.png");
  });

  it("does not keep a failed SwiftLint config existence probe after SwiftLint passes", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking config.",
            toolCalls: [
              {
                id: "failed-ls",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "ls -la .swiftlint.yml 2>&1; ls -la ../.swiftlint.yml 2>&1" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Running SwiftLint.",
            toolCalls: [
              {
                id: "passed-swiftlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "printf '#!/bin/sh\\nexit 0\\n' > swiftlint && chmod +x swiftlint && PATH=$PWD:$PATH swiftlint --config .swiftlint.yml" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: .swiftlint.yml",
            "Verification: swiftlint --config .swiftlint.yml -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify iOS setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-swiftlint-recovery-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: ls -la .swiftlint.yml");
  });

  it("finalizes when the model repeatedly asks for the same duplicate verification", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        const script = provider.requests.length === 1
          ? "printf '#!/bin/sh\\necho ok\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App"
          : "PATH=$PWD:$PATH xcodebuild build -scheme App";
        yield {
          content: "Checking build.",
          toolCalls: [
            {
              id: `call-${provider.requests.length}`,
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ script }),
              },
            },
          ],
        };
        shellRuns += 1;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-duplicate-finalize-"));
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd,
      sink: async () => {},
      maxTurns: 8,
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(shellRuns).toBe(3);
    expect(result).toContain("Finalized after repeated duplicate verification requests.");
    expect(result).toContain("Verification-only: existing setup satisfied");
  });

  it("does not append contradictory artifact lines after a duplicate-finalize path", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: android/app/build.gradle.kts",
              "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
              "Blocked: none",
            ].join("\n"),
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "true # ./gradlew ktlintCheck --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: "Rechecking the same verification.",
          toolCalls: [
            {
              id: `call-${provider.requests.length}`,
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ script: "true # ./gradlew ktlintCheck --no-daemon" }),
              },
            },
          ],
        };
        shellRuns += 1;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-duplicate-artifact-none-"));
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify Android setup.",
      cwd,
      sink: async () => {},
      maxTurns: 8,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tania/artifacts/android/FastlaneSetup.md",
            sourcePath: "artifacts/android/FastlaneSetup.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(shellRuns).toBeGreaterThanOrEqual(1);
    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/android/FastlaneSetup.md");
    expect((result.match(/Artifact reused:/g) ?? []).length).toBe(1);
  });

  it("does not contradict explicit artifact reuse none in the deterministic report", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating onboarding.",
            toolCalls: [
              {
                id: "read-nav",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/android/NavigationSetup.kt" }),
                },
              },
              {
                id: "read-room",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/android/RoomSetup.kt" }),
                },
              },
              {
                id: "write-main",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/com/example/MainActivity.kt", content: "package test\n" }),
                },
              },
              {
                id: "write-store",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/com/example/data/OnboardingPreferences.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none — matched artifacts were read for context but not directly copied.",
            "Artifact created: none",
            "Modified: app/src/main/java/com/example/MainActivity.kt",
            "Modified: app/src/main/java/com/example/data/OnboardingPreferences.kt",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-none-deterministic-"));
    mkdirSync(join(cwd, ".tania/artifacts/android"), { recursive: true });
    writeFileSync(join(cwd, ".tania/artifacts/android/NavigationSetup.kt"), "package artifact\n");
    writeFileSync(join(cwd, ".tania/artifacts/android/RoomSetup.kt"), "package artifact\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android onboarding.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tania/artifacts/android/NavigationSetup.kt",
            sourcePath: "artifacts/android/NavigationSetup.kt",
            status: "available",
          },
          {
            path: ".tania/artifacts/android/RoomSetup.kt",
            sourcePath: "artifacts/android/RoomSetup.kt",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("## Tanya deterministic report");
    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/android/NavigationSetup.kt");
    expect(result).not.toContain("Artifact reused: artifacts/android/RoomSetup.kt");
    expect((result.match(/Artifact reused:/g) ?? []).length).toBe(1);
  });

  it("syncs reusable artifact output to the caller artifact root", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Creating reusable artifact.",
          toolCalls: [
            {
              id: "write-artifact",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: ".tania/artifact-output/backend/NewPattern.ts",
                  content: "export const pattern = true;\n",
                }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-output-"));
    const artifactRoot = mkdtempSync(join(tmpdir(), "tanya-output-artifacts-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Create a reusable backend artifact.",
      cwd,
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        expected_report: { artifact_created: true },
        metadata: { artifactOutputRoot: artifactRoot },
      },
    });

    expect(existsSync(join(artifactRoot, "backend", "NewPattern.ts"))).toBe(true);
    expect(readFileSync(join(artifactRoot, "backend", "NewPattern.ts"), "utf8")).toContain("pattern");
    expect(result).toContain("Artifact created: artifacts/backend/NewPattern.ts -> reusable artifact");
  });

  it("cleans materialized .tania context after a successful coding run", async () => {
    const provider = makeProvider([
      [
        "Artifact reused: none",
        "Artifact created: none",
        "Verification: local check -> passed",
        "Blocked: none",
      ].join("\n"),
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-clean-context-"));
    mkdirSync(join(cwd, ".tania", "context"), { recursive: true });
    mkdirSync(join(cwd, ".tania", "artifacts"), { recursive: true });
    mkdirSync(join(cwd, ".tania", "memory"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "context", "safety.md"), "rules\n");
    writeFileSync(join(cwd, ".tania", "artifacts", "manifest.json"), "{}\n");
    writeFileSync(join(cwd, ".tania", "memory", "golden-tasks.jsonl"), "{}\n");

    try {
      await runAgent({
        provider,
        prompt: "Verify setup.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          metadata: { tanyaMaterializedContext: true, keepMaterializedContext: false },
        },
      });

      expect(existsSync(join(cwd, ".tania", "context"))).toBe(false);
      expect(existsSync(join(cwd, ".tania", "artifacts"))).toBe(false);
      expect(existsSync(join(cwd, ".tania", "memory"))).toBe(false);
      expect(existsSync(join(cwd, ".tania", "runs"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records verification for run_shell command alias calls", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking with command alias.",
            toolCalls: [
              {
                id: "alias-check",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "printf ok", timeoutMs: 5_000 }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Verification: printf ok -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-shell-alias-verification-"));

    try {
      const { message: result } = await runAgent({
        provider,
        prompt: "Verify existing setup.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          expected_report: { verification: true },
        },
      });

      expect(result).toContain("Verification: printf ok -> passed");
      expect(result).not.toContain("core-verification-missing");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps materialized .tania context when validation fails", async () => {
    const provider = makeProvider([
      [
        "Artifact reused: none",
        "Artifact created: none",
        "Verification: local check -> passed",
        "Blocked: none",
      ].join("\n"),
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-keep-failed-context-"));
    mkdirSync(join(cwd, ".tania", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "artifacts", "ios", "FastlaneSetup.md"), "setup\n");

    try {
      await runAgent({
        provider,
        prompt: "Set up iOS.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          artifacts: [
            {
              path: ".tania/artifacts/ios/FastlaneSetup.md",
              sourcePath: "artifacts/ios/FastlaneSetup.md",
              status: "available",
            },
          ],
          expected_report: { artifact_reuse: true },
          metadata: { tanyaMaterializedContext: true, keepMaterializedContext: false },
        },
      });

      expect(existsSync(join(cwd, ".tania", "artifacts", "ios", "FastlaneSetup.md"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps materialized .tania context when keep mode is enabled", async () => {
    const provider = makeProvider([
      [
        "Artifact reused: none",
        "Artifact created: none",
        "Verification: local check -> passed",
        "Blocked: none",
      ].join("\n"),
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-keep-context-"));
    mkdirSync(join(cwd, ".tania", "context"), { recursive: true });
    writeFileSync(join(cwd, ".tania", "context", "safety.md"), "rules\n");

    try {
      await runAgent({
        provider,
        prompt: "Verify setup.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          metadata: { tanyaMaterializedContext: true, keepMaterializedContext: true },
        },
      });

      expect(existsSync(join(cwd, ".tania", "context", "safety.md"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("expands untracked directories from shell-created files in the final report", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash drawables.",
            toolCalls: [
              {
                id: "create-drawables",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({
                    script: [
                      "mkdir -p app/src/main/res/drawable",
                      "printf 'png' > app/src/main/res/drawable/ic_splash_logo.png",
                      "printf 'png' > app/src/main/res/drawable/ic_splash_logo_1024.png",
                    ].join(" && "),
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: app/src/main/res/drawable/ic_splash_logo.png",
            "Modified: app/src/main/res/drawable/ic_splash_logo_1024.png",
            "Verification: file app/src/main/res/drawable/ic_splash_logo.png -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-untracked-dir-"));
    execFileSync("git", ["init"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash drawables.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: app/src/main/res/drawable/ic_splash_logo.png");
    expect(result).toContain("Modified: app/src/main/res/drawable/ic_splash_logo_1024.png");
  });

  it("canonicalizes prose-heavy artifact reuse lines before adding the deterministic report", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift` — adapted the generic splash pattern.",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-line-canonical-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("adapted the generic splash pattern");
  });

  it("strips parenthetical prose from artifact reuse targets", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift (adapted from the generic pattern)",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-line-parenthetical-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("adapted from the generic pattern");
  });

  it("removes contradictory artifact reused none lines when specific reuse exists", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/SplashScreen.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt",
            "Artifact reused: none (no other artifacts matched)",
            "Artifact created: none",
            "Modified: app/src/main/java/SplashScreen.kt",
            "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-contradictory-none-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt");
    expect(result).not.toContain("Artifact reused: none");
  });

  it("does not infer Android splash XML resources as direct targets of the Kotlin splash artifact", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating Android splash from the reusable Kotlin pattern.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/android/SplashScreenPattern.kt" }),
                },
              },
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/SplashScreen.kt", content: "package test\n" }),
                },
              },
              {
                id: "write-theme",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/res/values/splash_theme.xml", content: "<resources />\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Modified: app/src/main/java/SplashScreen.kt",
            "Modified: app/src/main/res/values/splash_theme.xml",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-android-splash-artifact-targets-"));
    mkdirSync(join(cwd, ".tania/artifacts/android"), { recursive: true });
    writeFileSync(join(cwd, ".tania/artifacts/android/SplashScreenPattern.kt"), "fun SplashPattern() {}\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [{ sourcePath: "artifacts/android/SplashScreenPattern.kt", path: ".tania/artifacts/android/SplashScreenPattern.kt" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt");
    expect(result).not.toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt, app/src/main/res/values/splash_theme.xml");
    expect(result).not.toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/res/values/splash_theme.xml");
  });

  it("repairs commit-required runs when a changed asset is left outside the commit", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash files.",
            toolCalls: [
              {
                id: "write-view",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
              {
                id: "write-asset",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png", content: "png\n" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Committing only the Swift file by mistake.",
            toolCalls: [
              {
                id: "commit-partial",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "git add CosaNostra/SplashScreenView.swift && git commit -m '[iOS] Add splash view'" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: CosaNostra/SplashScreenView.swift",
              "Verification: git commit partial -> passed",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Amending the missing asset into the task commit.",
            toolCalls: [
              {
                id: "commit-repair",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "git add CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png && git commit --amend --no-edit" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png",
            "Verification: git commit --amend --no-edit -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-commit-repair-"));
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, "README.md"), "# Demo\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Patch files and commit the changed files.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Generic coding task" },
        expected_report: { verification: true, commit: true },
      },
      repairAttempts: 0,
    });

    const commitRepairPrompt = String(provider.requests[3]?.messages.at(-1)?.content ?? "");
    expect(commitRepairPrompt).toContain("not included in the task commit");
    expect(commitRepairPrompt).toContain("SplashIcon.png");
    expect(result).toContain("Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png");
  });

  it("does not report unchanged tool-touched files for commit-required runs", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Touching asset metadata and changing the splash view.",
            toolCalls: [
              {
                id: "write-unchanged-contents",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
                    content: "{}\n",
                  }),
                },
              },
              {
                id: "write-view",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: "import SwiftUI\nstruct SplashScreenView: View { var body: some View { Text(\"Splash\") } }\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Committing the task.",
            toolCalls: [
              {
                id: "commit",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({
                    script: "git add CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json CosaNostra/SplashScreenView.swift && git commit -m '[iOS] Add splash screen'",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: git commit -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-commit-report-source-"));
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    execFileSync("git", ["add", "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"], { cwd });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Patch files and commit the changed files.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Generic coding task" },
        expected_report: { verification: true, commit: true },
      },
      repairAttempts: 0,
    });

    expect(result).toContain("Modified: CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json");
  });

  it("treats missing explicit npm install verification as repairable error", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Patching backend docs.",
            toolCalls: [
              {
                id: "write-doc",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "README.md", content: "# Backend\n" }),
                },
              },
              {
                id: "probe-install",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "ls node_modules/.package-lock.json" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: README.md",
              "Verification: ls node_modules/.package-lock.json -> passed",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: "Running the missing exact install verification.",
            toolCalls: [
              {
                id: "npm-install",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "npm install" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: README.md",
            "Verification: npm install -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-npm-install-repair-"));
    writeFileSync(join(cwd, "package.json"), "{\"scripts\":{}}\n");
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/.package-lock.json"), "{}\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Patch backend docs and verify npm install.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Backend docs" },
        expected_report: { verification: true },
        verification: { commands: ["npm install"] },
      },
    });

    const repairPrompt = String(provider.requests[2]?.messages.at(-1)?.content ?? "");
    expect(repairPrompt).toContain("Requested verification command was not captured exactly: npm install");
    expect(repairPrompt).toContain("Do not substitute file-existence probes");
    expect(result).toContain("Verification: npm install -> passed");
  });

  it("drops artifact reuse lines whose target is explicitly none", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        this.requests.push({ ...input, messages: [...input.messages] });
        if (this.requests.length === 1) {
          yield {
            content: "Creating Android foundation.",
            toolCalls: [
              {
                id: "write-theme",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/com/example/ui/theme/Theme.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/ThemeSystem.kt -> app/src/main/java/com/example/ui/theme/Theme.kt",
            "Artifact reused: artifacts/android/OfflineCachePatterns.kt -> none (not used in this foundation step)",
            "Artifact created: none",
            "Modified: app/src/main/java/com/example/ui/theme/Theme.kt",
            "Verification: ./gradlew assembleDebug -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Build Android foundation.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-target-none-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/android/ThemeSystem.kt -> app/src/main/java/com/example/ui/theme/Theme.kt");
    expect(result).not.toContain("OfflineCachePatterns.kt -> none");
  });

  it("normalizes bold machine-readable report labels", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "- **Artifact reused:** `artifacts/ios/SplashScreenPattern.swift` → `CosaNostra/SplashScreenView.swift` (adapted)",
            "- **Artifact created:** none",
            "- `Modified: CosaNostra/SplashScreenView.swift`",
            "- `Verification: xcodebuild build -> passed`",
            "- **Manual check:** Run on a simulator to verify the splash icon renders",
            "- **Blocked:** none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-bold-report-labels-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).toContain("Artifact created: none");
    expect(result).toContain("Manual check: Run on a simulator to verify the splash icon renders -> required after CLI");
    expect(result).not.toContain("**Artifact reused:**");
  });

  it("normalizes fully bold artifact reuse lines with explanatory text", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating iOS splash files.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
              {
                id: "write-asset",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json", content: "{}\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "- **Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift** — adapted the generic splash structure.",
            "- **Artifact created:** none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-fully-bold-artifact-line-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json, CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("adapted the generic splash structure");
  });

  it("maps fallback artifact reuse to same-extension changed files when possible", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading artifact and writing files.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tania/artifacts/ios/SplashScreenPattern.swift" }),
                },
              },
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
              {
                id: "write-asset",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json", content: "{}\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-same-extension-"));
    mkdirSync(join(cwd, ".tania/artifacts/ios"), { recursive: true });
    writeFileSync(join(cwd, ".tania/artifacts/ios/SplashScreenPattern.swift"), "import SwiftUI\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [{ sourcePath: "artifacts/ios/SplashScreenPattern.swift", path: ".tania/artifacts/ios/SplashScreenPattern.swift" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json");
  });

  it("adds deterministic manual check lines from manual testing sections", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/SplashScreen.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt",
            "Artifact created: none",
            "Modified: app/src/main/java/SplashScreen.kt",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Blocked: none",
            "",
            "### Manual testing needed",
            "1. Launch on an emulator and verify the splash renders.",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-manual-testing-section-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Manual check: Launch on an emulator and verify the splash renders. -> required after CLI");
  });

  it("drops prose fragments from comma-separated artifact reuse targets", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift, tagline, gradient, scale animation; kept the gate",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
            "",
            "### What to test manually",
            "1. Launch the app and verify the splash appears.",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-prose-targets-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("tagline, gradient");
    expect(result).toContain("Manual check: Launch the app and verify the splash appears. -> required after CLI");
  });

  it("appends a structured report and validator findings for coding tasks", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating a weak iOS splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: "import SwiftUI\nstruct SplashScreenView: View { var body: some View { Color.accentColor } }\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Splash Screen for iOS.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-structured-report-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Generic coding task" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Tanya structured report:");
    expect(result).toContain("\"modified\"");
    expect(result).toContain("\"blocked\"");
    expect(result).toContain("Blocked: core-verification-missing");
    expect(result).not.toContain("ios-splash-icon-image");
    expect(result).not.toContain("ios-splash-accentcolor-only");
  });

  it("records golden task memory when caller opts in", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Writing README.",
            toolCalls: [
              {
                id: "write-readme",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "README.md", content: "# Demo\n" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Verifying README patch.",
            toolCalls: [
              {
                id: "verify-readme",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "echo ok" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: README.md",
            "Verification: echo ok -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-golden-memory-"));

    await runAgent({
      provider,
      prompt: "Patch README.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Patch README" },
        expected_report: { verification: true },
        metadata: { goldenTaskCandidate: true, caller: "test" },
      },
    });

    const memory = readFileSync(join(cwd, ".tania/memory/golden-tasks.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { outcome: string; task: { title?: string } });
    expect(memory).toHaveLength(1);
    expect(memory[0]?.outcome).toBe("passed");
    expect(memory[0]?.task.title).toBe("Patch README");
  });
});
