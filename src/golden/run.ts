import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "../agent/runner";
import type { TanyaRunContext } from "../context/runContext";
import type { TanyaEvent } from "../events/types";
import { ContextWindowExceededError, type ChatDelta, type ChatProvider, type ChatRequest, type ToolCall } from "../providers/types";
import { loadGoldenTaskProfiles, type GoldenTaskProfile } from "./profiles";

type GoldenTaskFixture = {
  workspace: string;
  prompt: string;
  runContext: TanyaRunContext;
  provider: ChatProvider;
};

type GenericBenchmarkSpec = {
  id: string;
  targetFiles: Array<{ path: string; content: string }>;
  prompt: string;
  preFiles?: Array<{ path: string; content: string }>;
  useArtifact?: boolean;
  useContext?: boolean;
  useSearchReplace?: boolean;
  dirtyWorktree?: boolean;
  reportRepair?: boolean;
  preVerifyBeforeEdit?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
};

export type GoldenRunResult = {
  profile: GoldenTaskProfile;
  workspace: string;
  passed: boolean;
  finalText: string;
  problems: string[];
  turns: number;
};

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function scriptedProvider(id: string, turns: ChatDelta[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: `golden:${id}`,
    model: "scripted",
    requests,
    async *streamChat(input: ChatRequest) {
      requests.push({ ...input, messages: [...input.messages] });
      yield turns[Math.min(requests.length - 1, turns.length - 1)] ?? { content: "" };
    },
  };
}

const execFileAsync = promisify(execFile);

async function createBaseWorkspace(profileId: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `tanya-golden-${profileId.replace(/[^a-z0-9]+/gi, "-")}-`));
}

const GENERIC_BENCHMARK_SPECS: Record<string, GenericBenchmarkSpec> = {
  "tanya.low.search-replace": {
    id: "tanya.low.search-replace",
    prompt: "Replace the pending marker in an existing helper and verify it.",
    useSearchReplace: true,
    targetFiles: [{ path: "src/searchReplaceTarget.ts", content: "export const status = 'search-replace-ready';\n" }],
  },
  "tanya.low.new-helper": {
    id: "tanya.low.new-helper",
    prompt: "Create a small helper file and verify it.",
    targetFiles: [{ path: "src/newHelper.ts", content: "export function newHelper() { return 'new-helper-ready'; }\n" }],
  },
  "tanya.low.config-update": {
    id: "tanya.low.config-update",
    prompt: "Update a small config file with the requested marker.",
    useSearchReplace: true,
    targetFiles: [{ path: "config/settings.json", content: "{\n  \"mode\": \"config-update-ready\"\n}\n" }],
  },
  "tanya.low.readme-update": {
    id: "tanya.low.readme-update",
    prompt: "Append the benchmark readiness note to the README.",
    useSearchReplace: true,
    targetFiles: [{ path: "README.md", content: "# Demo\n\nBenchmark note: readme-update-ready\n" }],
  },
  "tanya.low.package-script": {
    id: "tanya.low.package-script",
    prompt: "Add a benchmark package script while preserving package metadata.",
    targetFiles: [{ path: "package.json", content: "{\n  \"name\": \"benchmark-fixture\",\n  \"scripts\": {\n    \"benchmark:ok\": \"node scripts/check.js\"\n  },\n  \"marker\": \"package-script-ready\"\n}\n" }],
  },
  "tanya.medium.service-module": {
    id: "tanya.medium.service-module",
    prompt: "Create a service module and export it from the index.",
    targetFiles: [
      { path: "src/services/taskService.ts", content: "export function taskService() { return 'service-module-ready'; }\n" },
      { path: "src/index.ts", content: "export { taskService } from './services/taskService';\n" },
    ],
  },
  "tanya.medium.test-harness": {
    id: "tanya.medium.test-harness",
    prompt: "Add a tiny executable test harness and verify it runs.",
    targetFiles: [
      { path: "src/harness.js", content: "module.exports = () => 'test-harness-ready';\n" },
      { path: "test/harness.test.js", content: "const run = require('../src/harness'); if (run() !== 'test-harness-ready') process.exit(1);\n" },
    ],
  },
  "tanya.medium.artifact-component": {
    id: "tanya.medium.artifact-component",
    prompt: "Adapt the reusable component artifact into the project.",
    useArtifact: true,
    targetFiles: [{ path: "src/components/BenchmarkCard.tsx", content: "export function BenchmarkCard() { return 'artifact-component-ready'; }\n" }],
  },
  "tanya.medium.artifact-service": {
    id: "tanya.medium.artifact-service",
    prompt: "Adapt the reusable service artifact into the project.",
    useArtifact: true,
    targetFiles: [{ path: "src/services/artifactService.ts", content: "export function artifactService() { return 'artifact-service-ready'; }\n" }],
  },
  "tanya.medium.dirty-worktree": {
    id: "tanya.medium.dirty-worktree",
    prompt: "Complete the task while preserving an unrelated dirty file.",
    dirtyWorktree: true,
    targetFiles: [{ path: "src/dirtyTask.ts", content: "export const dirtyTask = 'dirty-worktree-ready';\n" }],
  },
  "tanya.medium.report-repair": {
    id: "tanya.medium.report-repair",
    prompt: "Complete the task and recover if the first final response omits the required report.",
    reportRepair: true,
    targetFiles: [{ path: "src/reportRepair.ts", content: "export const reportRepair = 'report-repair-ready';\n" }],
  },
  "tanya.medium.multi-file": {
    id: "tanya.medium.multi-file",
    prompt: "Create a coordinated source and documentation update.",
    targetFiles: [
      { path: "src/multiFile.ts", content: "export const multiFile = 'multi-file-ready';\n" },
      { path: "docs/multi-file.md", content: "# Multi File\n\nmulti-file-ready\n" },
    ],
  },
  "tanya.medium.package-manager": {
    id: "tanya.medium.package-manager",
    prompt: "Add package-manager metadata and a source marker.",
    targetFiles: [
      { path: "package.json", content: "{\n  \"name\": \"benchmark-fixture\",\n  \"packageManager\": \"npm@10.0.0\",\n  \"scripts\": {\n    \"typecheck\": \"node scripts/check.js\",\n    \"test\": \"node scripts/check.js\"\n  },\n  \"marker\": \"package-manager-ready\"\n}\n" },
      { path: "src/packageManager.ts", content: "export const packageManager = 'package-manager-ready';\n" },
    ],
  },
  "tanya.medium.context-aware": {
    id: "tanya.medium.context-aware",
    prompt: "Read the provided context note before editing the implementation.",
    useContext: true,
    targetFiles: [{ path: "src/contextAware.ts", content: "export const contextAware = 'context-aware-ready';\n" }],
  },
  "tanya.medium.existing-tests": {
    id: "tanya.medium.existing-tests",
    prompt: "Modify implementation while running the existing verification script.",
    targetFiles: [
      { path: "src/existingTests.js", content: "module.exports = 'existing-tests-ready';\n" },
      { path: "test/existingTests.test.js", content: "if (require('../src/existingTests') !== 'existing-tests-ready') process.exit(1);\n" },
    ],
  },
  "tanya.medium.dependency-install": {
    id: "tanya.medium.dependency-install",
    prompt: "Add the requested runtime dependency and lockfile state, then verify the manifest.",
    targetFiles: [
      { path: "package.json", content: "{\n  \"name\": \"benchmark-fixture\",\n  \"scripts\": {\n    \"check\": \"node scripts/check.js\"\n  },\n  \"dependencies\": {\n    \"zod\": \"^3.25.0\"\n  },\n  \"marker\": \"dependency-install-ready\"\n}\n" },
      { path: "package-lock.json", content: "{\n  \"name\": \"benchmark-fixture\",\n  \"lockfileVersion\": 3,\n  \"packages\": {\n    \"\": {\n      \"dependencies\": {\n        \"zod\": \"^3.25.0\"\n      },\n      \"marker\": \"dependency-install-ready\"\n    }\n  }\n}\n" },
    ],
  },
  "tanya.medium.framework-migration": {
    id: "tanya.medium.framework-migration",
    prompt: "Migrate the legacy page into an app-router-style page and preserve compatibility.",
    preFiles: [
      { path: "src/pages/index.tsx", content: "export default function LegacyHome() { return 'legacy'; }\n" },
    ],
    targetFiles: [
      { path: "src/app/page.tsx", content: "export default function Page() { return 'framework-migration-ready'; }\n" },
      { path: "src/app/layout.tsx", content: "export default function Layout({ children }: { children: unknown }) { return children; }\n// framework-migration-ready\n" },
      { path: "src/pages/index.tsx", content: "export { default } from '../app/page';\n// framework-migration-ready\n" },
    ],
  },
  "tanya.medium.failing-test-repair": {
    id: "tanya.medium.failing-test-repair",
    prompt: "Run the existing check, repair the failing implementation, and rerun verification.",
    useSearchReplace: true,
    preVerifyBeforeEdit: true,
    targetFiles: [
      { path: "src/math.js", content: "module.exports = function add(a, b) { return a + b; };\n// failing-test-repair-ready\n" },
      { path: "test/math.test.js", content: "const add = require('../src/math'); if (add(2, 2) !== 4) process.exit(1);\n// failing-test-repair-ready\n" },
    ],
  },
  "tanya.medium.frontend-smoke": {
    id: "tanya.medium.frontend-smoke",
    prompt: "Create a small frontend component and smoke check that proves the key UI marker is present.",
    targetFiles: [
      { path: "src/App.tsx", content: "export function App() { return <main className=\"dashboard\">frontend-smoke-ready</main>; }\n" },
      { path: "src/App.css", content: ".dashboard { display: grid; gap: 12px; }\n/* frontend-smoke-ready */\n" },
      { path: "test/render-smoke.js", content: "const fs = require('fs'); const text = fs.readFileSync('src/App.tsx', 'utf8'); if (!text.includes('frontend-smoke-ready')) process.exit(1);\n// frontend-smoke-ready\n" },
    ],
  },
  "tanya.medium.run-log-history": {
    id: "tanya.medium.run-log-history",
    prompt: "Complete a normal edit and make sure usage metrics are available for run history.",
    usage: { promptTokens: 2_400, completionTokens: 620 },
    targetFiles: [{ path: "src/runLogHistory.ts", content: "export const runLogHistory = 'run-log-history-ready';\n" }],
  },
};

async function genericBenchmarkFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const spec = GENERIC_BENCHMARK_SPECS[profile.id];
  if (!spec) throw new Error(`No generic benchmark spec for ${profile.id}`);
  const workspace = await createBaseWorkspace(profile.id);
  const marker = `${profile.id.split(".").pop() ?? "benchmark"}-ready`;

  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts/check.js"), [
    "const fs = require('fs');",
    `const targets = ${JSON.stringify(spec.targetFiles.map((file) => ({ path: file.path, marker })))};`,
    "for (const target of targets) {",
    "  const text = fs.readFileSync(target.path, 'utf8');",
    "  if (!text.includes(target.marker)) {",
    "    console.error(`missing ${target.marker} in ${target.path}`);",
    "    process.exit(1);",
    "  }",
    "}",
    "console.log('benchmark ok');",
    "",
  ].join("\n"));

  if (spec.useSearchReplace) {
    for (const file of spec.targetFiles) {
      const dir = file.path.split("/").slice(0, -1).join("/");
      if (dir) await mkdir(join(workspace, dir), { recursive: true });
      await writeFile(join(workspace, file.path), file.content.replace(marker, "PENDING_MARKER"));
    }
  }
  for (const file of spec.preFiles ?? []) {
    const dir = file.path.split("/").slice(0, -1).join("/");
    if (dir) await mkdir(join(workspace, dir), { recursive: true });
    await writeFile(join(workspace, file.path), file.content);
  }
  if (spec.useArtifact) {
    await mkdir(join(workspace, ".tanya/artifacts/generic"), { recursive: true });
    await writeFile(join(workspace, ".tanya/artifacts/generic/Pattern.md"), `# Pattern\n\nUse ${marker} in the adapted output.\n`);
  }
  if (spec.useContext) {
    await mkdir(join(workspace, ".tanya/context"), { recursive: true });
    await writeFile(join(workspace, ".tanya/context/task.md"), `# Task Context\n\nUse ${marker}.\n`);
  }
  if (spec.dirtyWorktree) {
    await writeFile(join(workspace, "unrelated.txt"), "baseline\n");
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "tanya@example.test"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Tanya Benchmark"], { cwd: workspace });
    await execFileAsync("git", ["add", "unrelated.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: workspace });
    await writeFile(join(workspace, "unrelated.txt"), "pre-existing dirty change\n");
  }

  const toolCalls: ToolCall[] = [];
  if (spec.useArtifact) toolCalls.push(toolCall("read-artifact", "read_file", { path: ".tanya/artifacts/generic/Pattern.md" }));
  if (spec.useContext) toolCalls.push(toolCall("read-context", "read_file", { path: ".tanya/context/task.md" }));
  if (spec.preVerifyBeforeEdit) toolCalls.push(toolCall("verify-before", "run_command", { command: "node", args: ["scripts/check.js"] }));
  if (spec.useSearchReplace) {
    for (const file of spec.targetFiles) {
      toolCalls.push(toolCall(`edit-${file.path}`, "search_replace", {
        path: file.path,
        old_string: file.content.replace(marker, "PENDING_MARKER"),
        new_string: file.content,
      }));
    }
  } else {
    for (const file of spec.targetFiles) toolCalls.push(toolCall(`write-${file.path}`, "write_file", file));
  }
  toolCalls.push(toolCall("verify", "run_command", { command: "node", args: ["scripts/check.js"] }));

  const artifactLine = spec.useArtifact
    ? `Artifact reused: artifacts/generic/Pattern.md -> ${spec.targetFiles.map((file) => file.path).join(", ")}`
    : "Artifact reused: none";
  const finalReport = [
    artifactLine,
    "Artifact created: none",
    ...spec.targetFiles.map((file) => `Modified: ${file.path}`),
    "Verification: node scripts/check.js -> passed",
    "Blocked: none",
  ].join("\n");

  return {
    workspace,
    prompt: spec.prompt,
    provider: scriptedProvider(profile.id, [
      { content: spec.prompt, toolCalls, ...(spec.usage ? { usage: spec.usage } : {}) },
      ...(spec.reportRepair ? [{ content: "Done." }] : []),
      { content: finalReport },
    ]),
    runContext: {
      task: { kind: "coding", title: profile.title, summary: profile.purpose },
      artifacts: spec.useArtifact ? [{ path: ".tanya/artifacts/generic/Pattern.md", sourcePath: "artifacts/generic/Pattern.md", status: "available" }] : [],
      contextFiles: spec.useContext ? [{ path: ".tanya/context/task.md", sourcePath: "context/task.md", status: "available" }] : [],
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-benchmark" },
    },
  };
}

async function streamingLongToolFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  const script = "for i in 1 2 3 4 5 6; do printf \"stream-$i\\n\"; sleep 2; done; node scripts/check.js";
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts/check.js"), [
    "const fs = require('fs');",
    "const text = fs.readFileSync('src/streamingLongTool.ts', 'utf8');",
    "if (!text.includes('streaming-long-tool-ready')) process.exit(1);",
    "console.log('benchmark ok');",
    "",
  ].join("\n"));

  const provider = scriptedProvider(profile.id, [
    {
      content: "Create a marker file and verify it with a long-running streaming shell command.",
      toolCalls: [
        toolCall("write-marker", "write_file", {
          path: "src/streamingLongTool.ts",
          content: "export const streamingLongTool = 'streaming-long-tool-ready';\n",
        }),
        toolCall("long-verify", "run_shell", { script, timeoutMs: 20_000 }),
      ],
    },
    {
      content: [
        "Artifact reused: none",
        "Artifact created: none",
        "Modified: src/streamingLongTool.ts",
        `Verification: ${script} -> passed`,
        "Blocked: none",
      ].join("\n"),
    },
  ]);

  return {
    workspace,
    prompt: "Create a marker file and verify it with a >10s shell command that streams output.",
    provider,
    runContext: {
      task: { kind: "coding", title: profile.title, summary: profile.purpose },
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function compactionBoundaryFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts/check.js"), [
    "const fs = require('fs');",
    "const text = fs.readFileSync('src/compactionBoundary.ts', 'utf8');",
    "if (!text.includes('compaction-boundary-ready')) process.exit(1);",
    "console.log('benchmark ok');",
    "",
  ].join("\n"));

  const requests: ChatRequest[] = [];
  let mainAttempts = 0;
  const provider: ChatProvider & { requests: ChatRequest[] } = {
    id: `golden:${profile.id}`,
    model: "scripted",
    requests,
    async *streamChat(input: ChatRequest) {
      requests.push({ ...input, messages: [...input.messages] });
      const prompt = input.messages[0]?.content ?? "";
      if (input.tools?.length === 0 && prompt.includes("Summarize these older Tanya conversation turns")) {
        yield { content: "The run wrote src/compactionBoundary.ts and verified it with node scripts/check.js." };
        return;
      }

      mainAttempts += 1;
      if (mainAttempts === 1) {
        yield {
          content: "Create and verify the compaction boundary marker.",
          toolCalls: [
            toolCall("write-marker", "write_file", {
              path: "src/compactionBoundary.ts",
              content: "export const compactionBoundary = 'compaction-boundary-ready';\n",
            }),
            toolCall("verify", "run_command", { command: "node", args: ["scripts/check.js"] }),
          ],
        };
        return;
      }
      if (mainAttempts === 2) {
        throw new ContextWindowExceededError({
          provider: provider.id,
          status: 413,
          rawMessage: "context_length_exceeded",
        });
      }
      yield {
        content: [
          "Artifact reused: none",
          "Artifact created: none",
          "Modified: src/compactionBoundary.ts",
          "Verification: node scripts/check.js -> passed",
          "Blocked: none",
        ].join("\n"),
      };
    },
  };

  return {
    workspace,
    prompt: "Create a marker file and finish correctly after a synthetic context compaction boundary.",
    provider,
    runContext: {
      task: { kind: "coding", title: profile.title, summary: profile.purpose },
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function editBlockFuzzyFixture(profile: GoldenTaskProfile, mode: "enabled" | "disabled" = "enabled"): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(`${profile.id}-${mode}`);
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "src/status.ts"), [
    "export function status() {",
    "  const current = \"pending\";",
    "  return current;",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(workspace, "scripts/check.js"), [
    "const fs = require('fs');",
    "const text = fs.readFileSync('src/status.ts', 'utf8');",
    "if (!text.includes('complete')) {",
    "  console.error('missing edit-block-fuzzy-ready');",
    "  process.exit(1);",
    "}",
    "console.log('benchmark ok');",
    "",
  ].join("\n"));
  if (mode === "enabled") {
    await mkdir(join(workspace, ".tanya"), { recursive: true });
    await writeFile(join(workspace, ".tanya", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "default",
      alwaysAllow: ["edit_block:.*\"matchPolicy\":\"fuzzy\".*"],
    }));
  }

  const original = [
    "export function status() {",
    "  const current = \"pending\";",
    "  return current;",
    "}",
  ].join("\n");
  const nearMatch = [
    "export function status() {",
    "  const current = \"pendng\";",
    "  return current;",
    "}",
  ].join("\n");
  const replacement = [
    "export function status() {",
    "  const current = \"complete\";",
    "  return current;",
    "}",
  ].join("\n");
  const finalReport = [
    "Artifact reused: none",
    "Artifact created: none",
    "Modified: src/status.ts",
    "Verification: node scripts/check.js -> passed",
    "Blocked: none",
  ].join("\n");

  const turns = mode === "enabled"
    ? [
        {
          content: "Use fuzzy edit_block to recover the near-match and verify it.",
          toolCalls: [
            toolCall("fuzzy-edit", "edit_block", {
              path: "src/status.ts",
              search: nearMatch,
              replace: replacement,
              matchPolicy: "fuzzy",
            }),
            toolCall("verify", "run_command", { command: "node", args: ["scripts/check.js"] }),
          ],
        },
        { content: finalReport },
      ]
    : [
        {
          content: "Try the near-match exactly first.",
          toolCalls: [
            toolCall("bad-exact", "edit_block", {
              path: "src/status.ts",
              search: nearMatch,
              replace: replacement,
            }),
          ],
        },
        {
          content: "Read the file after the exact block failed.",
          toolCalls: [toolCall("read-status", "read_file", { path: "src/status.ts" })],
        },
        {
          content: "Apply the closer exact block and verify.",
          toolCalls: [
            toolCall("exact-edit", "edit_block", {
              path: "src/status.ts",
              search: original,
              replace: replacement,
            }),
            toolCall("verify", "run_command", { command: "node", args: ["scripts/check.js"] }),
          ],
        },
        { content: finalReport },
      ];

  return {
    workspace,
    prompt: "Recover a cheap-provider-style near-match edit and verify the file.",
    provider: scriptedProvider(`${profile.id}-${mode}`, turns),
    runContext: {
      task: { kind: "coding", title: profile.title, summary: profile.purpose },
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function androidSplashFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  await mkdir(join(workspace, ".tanya/artifacts/android"), { recursive: true });
  await mkdir(join(workspace, "app/src/main/java/com/example/app/ui/splash"), { recursive: true });
  await mkdir(join(workspace, "app/src/main/res/values"), { recursive: true });
  await mkdir(join(workspace, "app/src/main/res/drawable"), { recursive: true });
  await writeFile(join(workspace, ".tanya/artifacts/android/SplashScreenPattern.kt"), "fun SplashPattern() {}\n");
  await writeFile(join(workspace, "gradlew"), "#!/bin/sh\ncase \"$*\" in\n  *ktlintCheck*) echo ktlint ok ;;\n  *) echo BUILD SUCCESSFUL ;;\nesac\n");
  await writeFile(join(workspace, "app/src/main/res/drawable/ic_splash_logo.png"), "png\n");

  const provider = scriptedProvider(profile.id, [
    {
      content: "Create Android splash resources from the artifact.",
      toolCalls: [
        toolCall("read-artifact", "read_file", { path: ".tanya/artifacts/android/SplashScreenPattern.kt" }),
        toolCall("write-manifest", "write_file", {
          path: "app/src/main/AndroidManifest.xml",
          content: "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><application><activity android:name=\".MainActivity\" android:theme=\"@style/Theme.App.Splash\" /></application></manifest>\n",
        }),
        toolCall("write-theme", "write_file", {
          path: "app/src/main/res/values/splash_theme.xml",
          content: "<resources><style name=\"Theme.App.Splash\" parent=\"Theme.SplashScreen\"><item name=\"windowSplashScreenAnimatedIcon\">@drawable/ic_splash_logo</item><item name=\"postSplashScreenTheme\">@style/Theme.App</item></style></resources>\n",
        }),
        toolCall("write-icon", "write_file", {
          path: "app/src/main/res/drawable/ic_splash_logo.png",
          content: "png\n",
        }),
        toolCall("write-main", "write_file", {
          path: "app/src/main/java/com/example/app/MainActivity.kt",
          content: "package com.example.app\nfun onCreate() { installSplashScreen() }\n",
        }),
        toolCall("write-splash", "write_file", {
          path: "app/src/main/java/com/example/app/ui/splash/SplashScreen.kt",
          content: "package com.example.app.ui.splash\nfun CosaNostraSplashScreen() {}\n",
        }),
        toolCall("verify", "run_shell", { script: "chmod +x ./gradlew && ./gradlew assembleDebug --no-daemon" }),
      ],
    },
    {
      content: [
        "Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/app/ui/splash/SplashScreen.kt",
        "Artifact created: none",
        "Modified: app/src/main/AndroidManifest.xml",
        "Modified: app/src/main/res/values/splash_theme.xml",
        "Modified: app/src/main/res/drawable/ic_splash_logo.png",
        "Modified: app/src/main/java/com/example/app/MainActivity.kt",
        "Modified: app/src/main/java/com/example/app/ui/splash/SplashScreen.kt",
        "Verification: ./gradlew assembleDebug --no-daemon -> passed",
        "Blocked: none",
      ].join("\n"),
    },
  ]);

  return {
    workspace,
    prompt: "Create Android splash screen using artifacts/android/SplashScreenPattern.kt.",
    provider,
    runContext: {
      task: { kind: "coding", title: "Splash Screen - Android", summary: profile.purpose },
      artifacts: [{ path: ".tanya/artifacts/android/SplashScreenPattern.kt", sourcePath: "artifacts/android/SplashScreenPattern.kt", status: "available" }],
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function iosFoundationFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  await mkdir(join(workspace, ".tanya/artifacts/ios"), { recursive: true });
  await writeFile(join(workspace, ".tanya/artifacts/ios/ThemeSystem.swift"), "import SwiftUI\n");
  await writeFile(join(workspace, ".tanya/artifacts/ios/SwiftDataSetup.swift"), "import SwiftData\n");
  await writeFile(join(workspace, ".tanya/artifacts/ios/NavigationSetup.swift"), "import SwiftUI\n");

  const provider = scriptedProvider(profile.id, [
    {
      content: "Create iOS foundation from theme, SwiftData, and navigation artifacts.",
      toolCalls: [
        toolCall("read-theme", "read_file", { path: ".tanya/artifacts/ios/ThemeSystem.swift" }),
        toolCall("read-data", "read_file", { path: ".tanya/artifacts/ios/SwiftDataSetup.swift" }),
        toolCall("read-nav", "read_file", { path: ".tanya/artifacts/ios/NavigationSetup.swift" }),
        toolCall("mkdirs", "run_shell", { script: "mkdir -p CosaNostra/Theme CosaNostra/Models CosaNostra/Navigation" }),
        toolCall("write-colors", "write_file", {
          path: "CosaNostra/Theme/Colors.swift",
          content: "import SwiftUI\nextension Color { static let brandPrimary = Color(red: 26 / 255, green: 47 / 255, blue: 75 / 255); static let brandSecondary = Color(red: 200 / 255, green: 174 / 255, blue: 127 / 255); static let textPrimary = Color.primary }\n",
        }),
        toolCall("write-type", "write_file", {
          path: "CosaNostra/Theme/Typography.swift",
          content: "import SwiftUI\nenum AppTypography { static let title = Font.system(size: 28, design: .serif); static let body = Font.system(size: 16, design: .default) /* Playfair Display / Roboto local fallback */ }\n",
        }),
        toolCall("write-mods", "write_file", {
          path: "CosaNostra/Theme/ViewModifiers.swift",
          content: "import SwiftUI\nstruct CardStyle: ViewModifier { func body(content: Content) -> some View { content } }\nstruct PrimaryButtonStyle: ButtonStyle { func makeBody(configuration: Configuration) -> some View { configuration.label } }\nstruct EmptyStateView: View { var body: some View { Text(\"Empty\") } }\nstruct LoadingView: View { var body: some View { ProgressView() } }\nstruct ErrorView: View { var body: some View { Text(\"Error\") } }\n",
        }),
        toolCall("write-models", "write_file", {
          path: "CosaNostra/Models/SwiftDataSetup.swift",
          content: "import SwiftData\n@Model final class UserProfile { var id: String = \"\" }\nlet appSchema = Schema([UserProfile.self])\n",
        }),
        toolCall("write-nav", "write_file", {
          path: "CosaNostra/Navigation/NavigationSetup.swift",
          content: "import SwiftUI\nstruct RootTabView: View { @AppStorage(\"isDarkMode\") private var isDarkMode = false; var body: some View { TabView { NavigationStack { Toggle(\"Dark Mode\", isOn: $isDarkMode); Text(\"Dashboard\") } } } }\n",
        }),
        toolCall("write-app", "write_file", {
          path: "CosaNostra/CosaNostraApp.swift",
          content: "import SwiftUI\nimport SwiftData\n@main struct CosaNostraApp: App { @AppStorage(\"isDarkMode\") private var isDarkMode = false; var body: some Scene { WindowGroup { RootTabView().preferredColorScheme(isDarkMode ? .dark : nil).modelContainer(for: [UserProfile.self]) } } }\n",
        }),
        toolCall("verify", "run_shell", { script: "grep -R \"TabView\" CosaNostra/Navigation && echo xcodebuild" }),
      ],
    },
    {
      content: [
        "Artifact reused: artifacts/ios/ThemeSystem.swift -> CosaNostra/Theme/Colors.swift, CosaNostra/Theme/Typography.swift, CosaNostra/Theme/ViewModifiers.swift",
        "Artifact reused: artifacts/ios/SwiftDataSetup.swift -> CosaNostra/Models/SwiftDataSetup.swift",
        "Artifact reused: artifacts/ios/NavigationSetup.swift -> CosaNostra/Navigation/NavigationSetup.swift",
        "Artifact created: none",
        "Modified: CosaNostra/Theme/Colors.swift",
        "Modified: CosaNostra/Theme/Typography.swift",
        "Modified: CosaNostra/Theme/ViewModifiers.swift",
        "Modified: CosaNostra/Models/SwiftDataSetup.swift",
        "Modified: CosaNostra/Navigation/NavigationSetup.swift",
        "Modified: CosaNostra/CosaNostraApp.swift",
        "Verification: grep -R \"TabView\" CosaNostra/Navigation && echo xcodebuild -> passed",
        "Blocked: none",
      ].join("\n"),
    },
  ]);

  return {
    workspace,
    prompt: "Create bounded iOS foundation from the provided artifacts. Ensure dark mode support and local typography fallback.",
    provider,
    runContext: {
      task: { kind: "coding", title: "Fundações - iOS", summary: profile.purpose },
      artifacts: [
        { path: ".tanya/artifacts/ios/ThemeSystem.swift", sourcePath: "artifacts/ios/ThemeSystem.swift", status: "available" },
        { path: ".tanya/artifacts/ios/SwiftDataSetup.swift", sourcePath: "artifacts/ios/SwiftDataSetup.swift", status: "available" },
        { path: ".tanya/artifacts/ios/NavigationSetup.swift", sourcePath: "artifacts/ios/NavigationSetup.swift", status: "available" },
      ],
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function appleAppIconFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  await mkdir(join(workspace, "CosaNostra/Assets.xcassets"), { recursive: true });
  const provider = scriptedProvider(profile.id, [
    {
      content: "Generate Apple app icon set with iOS and macOS slots.",
      toolCalls: [
        toolCall("write-svg", "write_file", {
          path: "brand-icon.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1024\" height=\"1024\"><rect width=\"1024\" height=\"1024\" fill=\"#1A2F4B\"/><circle cx=\"512\" cy=\"512\" r=\"280\" fill=\"#C8AE7F\"/></svg>\n",
        }),
        toolCall("create-icons", "create_apple_app_icon_set", {
          source: "brand-icon.svg",
          outputDir: "CosaNostra/Assets.xcassets/AppIcon.appiconset",
          platforms: ["ios", "macos"],
        }),
        toolCall("parse-json", "run_shell", { script: "node -e \"const c=require('./CosaNostra/Assets.xcassets/AppIcon.appiconset/Contents.json'); const idioms=new Set(c.images.map(i=>i.idiom)); if(!idioms.has('iphone')||!idioms.has('ipad')||!idioms.has('ios-marketing')||!idioms.has('mac')) process.exit(1); console.log(c.images.length)\"" }),
        toolCall("xcodebuild", "run_shell", { script: "printf '#!/bin/sh\\necho BUILD SUCCEEDED\\n' > xcodebuild && chmod +x xcodebuild && PATH=\"$PWD:$PATH\" xcodebuild build -scheme CosaNostra -destination 'generic/platform=iOS Simulator'" }),
      ],
    },
    {
      content: [
        "Artifact reused: none",
        "Artifact created: none",
        "Modified: brand-icon.svg",
        "Modified: CosaNostra/Assets.xcassets/AppIcon.appiconset/Contents.json",
        "Verification: node Contents.json idiom parse -> passed",
        "Verification: xcodebuild build -scheme CosaNostra -destination 'generic/platform=iOS Simulator' -> passed",
        "Blocked: none",
      ].join("\n"),
    },
  ]);

  return {
    workspace,
    prompt: "Generate Apple app icon assets for iOS, iPad, ios-marketing, and macOS.",
    provider,
    runContext: {
      task: { kind: "coding", title: "App Icon - Apple", summary: profile.purpose },
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function androidFoundationFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  await mkdir(join(workspace, ".tanya/artifacts/android"), { recursive: true });
  await mkdir(join(workspace, "app"), { recursive: true });
  await writeFile(join(workspace, ".tanya/artifacts/android/ThemeSystem.kt"), "package artifact\n");
  await writeFile(join(workspace, ".tanya/artifacts/android/NavigationSetup.kt"), "package artifact\n");
  await writeFile(join(workspace, ".tanya/artifacts/android/RoomSetup.kt"), "package artifact\n");
  await writeFile(join(workspace, "gradlew"), "#!/bin/sh\ncase \"$*\" in\n  *ktlintCheck*) echo ktlint ok ;;\n  *) echo BUILD SUCCESSFUL ;;\nesac\n");
  await writeFile(join(workspace, "build.gradle.kts"), "plugins {\n    id(\"com.android.application\") version \"8.7.2\" apply false\n}\n");
  await writeFile(join(workspace, "app/build.gradle.kts"), [
    "plugins {",
    "    id(\"com.android.application\")",
    "    id(\"org.jetbrains.kotlin.android\")",
    "}",
    "",
    "dependencies {",
    "}",
    "",
  ].join("\n"));

  const provider = scriptedProvider(profile.id, [
    {
      content: "Create Android foundation with the deterministic high-level tool.",
      toolCalls: [
        toolCall("read-theme", "read_file", { path: ".tanya/artifacts/android/ThemeSystem.kt" }),
        toolCall("read-nav", "read_file", { path: ".tanya/artifacts/android/NavigationSetup.kt" }),
        toolCall("read-room", "read_file", { path: ".tanya/artifacts/android/RoomSetup.kt" }),
        toolCall("create-foundation", "create_android_foundation", {
          packageName: "com.example.app",
          appName: "Golden",
          brandPrimaryHex: "#1A2F4B",
          brandSecondaryHex: "#C8AE7F",
        }),
        toolCall("verify", "run_shell", { script: "chmod +x ./gradlew && ./gradlew assembleDebug --no-daemon" }),
      ],
    },
    {
      content: [
        "Artifact reused: artifacts/android/ThemeSystem.kt -> app/src/main/java/com/example/app/ui/theme/AppTheme.kt",
        "Artifact reused: artifacts/android/NavigationSetup.kt -> app/src/main/java/com/example/app/navigation/AppNavigation.kt",
        "Artifact reused: artifacts/android/RoomSetup.kt -> app/src/main/java/com/example/app/data/AppDatabase.kt",
        "Artifact created: none",
        "Modified: build.gradle.kts",
        "Modified: app/build.gradle.kts",
        "Modified: app/src/main/java/com/example/app/ui/theme/AppTheme.kt",
        "Modified: app/src/main/java/com/example/app/navigation/AppNavigation.kt",
        "Modified: app/src/main/java/com/example/app/data/AppDatabase.kt",
        "Modified: app/src/main/java/com/example/app/ui/components/FoundationStates.kt",
        "Verification: ./gradlew assembleDebug --no-daemon -> passed",
        "Blocked: none",
      ].join("\n"),
    },
  ]);

  return {
    workspace,
    prompt: "Create Android foundation using Room, Navigation Compose, Material 3 theme, and base composables.",
    provider,
    runContext: {
      task: { kind: "coding", title: "Fundações - Android", summary: profile.purpose },
      artifacts: [
        { path: ".tanya/artifacts/android/ThemeSystem.kt", sourcePath: "artifacts/android/ThemeSystem.kt", status: "available" },
        { path: ".tanya/artifacts/android/NavigationSetup.kt", sourcePath: "artifacts/android/NavigationSetup.kt", status: "available" },
        { path: ".tanya/artifacts/android/RoomSetup.kt", sourcePath: "artifacts/android/RoomSetup.kt", status: "available" },
      ],
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

async function backendApiFoundationFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  const workspace = await createBaseWorkspace(profile.id);
  await mkdir(join(workspace, ".tanya/artifacts/backend"), { recursive: true });
  await mkdir(join(workspace, "app/api/health"), { recursive: true });
  await mkdir(join(workspace, "lib"), { recursive: true });
  await mkdir(join(workspace, "prisma"), { recursive: true });
  await writeFile(join(workspace, ".tanya/artifacts/backend/JwtAuthRoutes.ts"), "export function authRoutePattern() {}\n");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node --test" }, dependencies: {} }, null, 2));

  const provider = scriptedProvider(profile.id, [
    {
      content: "Create backend health/API foundation from the route artifact.",
      toolCalls: [
        toolCall("read-artifact", "read_file", { path: ".tanya/artifacts/backend/JwtAuthRoutes.ts" }),
        toolCall("write-health", "write_file", {
          path: "app/api/health/route.ts",
          content: "export async function GET() { return Response.json({ status: 'ok', health: true }); }\n",
        }),
        toolCall("write-openapi", "write_file", {
          path: "lib/openapi.ts",
          content: "export const openApiSpec = { paths: { '/api/health': { get: { summary: 'health' } } } };\n",
        }),
        toolCall("write-prisma", "write_file", {
          path: "prisma/schema.prisma",
          content: "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\ngenerator client { provider = \"prisma-client-js\" }\nmodel User { id String @id }\n",
        }),
        toolCall("write-env", "write_file", {
          path: ".env.example",
          content: [
            "# Managed deploy provisions PostgreSQL.",
            "# Set DATABASE_URL and DIRECT_URL before seed:mock-data and seed:test-account actions.",
            "DATABASE_URL=\"replace-me-managed-postgresql-url\"",
            "DIRECT_URL=\"replace-me-managed-postgresql-direct-url\"",
            "",
          ].join("\n"),
        }),
        toolCall("verify", "run_shell", { script: "node -e \"require('fs').accessSync('app/api/health/route.ts'); console.log('typecheck')\"" }),
      ],
    },
    {
      content: [
        "Artifact reused: artifacts/backend/JwtAuthRoutes.ts -> app/api/health/route.ts",
        "Artifact created: none",
        "Modified: app/api/health/route.ts",
        "Modified: lib/openapi.ts",
        "Modified: prisma/schema.prisma",
        "Modified: .env.example",
        "Verification: node -e route exists -> passed",
        "Blocked: none",
      ].join("\n"),
    },
  ]);

  return {
    workspace,
    prompt: "Implement backend API foundation with health endpoint, OpenAPI seed, Prisma schema, and env example.",
    provider,
    runContext: {
      task: { kind: "coding", title: "Backend API Foundation", summary: profile.purpose },
      artifacts: [{ path: ".tanya/artifacts/backend/JwtAuthRoutes.ts", sourcePath: "artifacts/backend/JwtAuthRoutes.ts", status: "available" }],
      expected_report: { verification: true, artifact_reuse: true },
      metadata: { goldenTaskCandidate: true, caller: "tanya-golden" },
    },
  };
}

export function goldenRunnableProfiles(): GoldenTaskProfile[] {
  const runnable = new Set([
    "tanya.medium.streaming-long-tool",
    "tanya.medium.compaction-boundary",
    "tanya.medium.edit-block-fuzzy",
    ...Object.keys(GENERIC_BENCHMARK_SPECS),
  ]);
  return loadGoldenTaskProfiles().filter((profile) => runnable.has(profile.id));
}

async function createFixture(profile: GoldenTaskProfile): Promise<GoldenTaskFixture> {
  if (profile.id === "tanya.medium.streaming-long-tool") return streamingLongToolFixture(profile);
  if (profile.id === "tanya.medium.compaction-boundary") return compactionBoundaryFixture(profile);
  if (profile.id === "tanya.medium.edit-block-fuzzy") return editBlockFuzzyFixture(profile);
  if (profile.id in GENERIC_BENCHMARK_SPECS) return genericBenchmarkFixture(profile);
  throw new Error(`Golden profile is not executable yet: ${profile.id}`);
}

async function runFixture(profile: GoldenTaskProfile, fixture: GoldenTaskFixture): Promise<GoldenRunResult> {
  const events: TanyaEvent[] = [];
  const { message: finalText } = await runAgent({
    provider: fixture.provider,
    prompt: fixture.prompt,
    cwd: fixture.workspace,
    sink: async (event) => { events.push(event); },
    runContext: fixture.runContext,
  });
  const problems = [
    ...finalText.matchAll(/"severity"\s*:\s*"error"[\s\S]{0,220}?"id"\s*:\s*"([^"]+)"/g),
  ].map((match) => match[1] ?? "validation-error");
  if (profile.id === "tanya.medium.streaming-long-tool" && !events.some((event) => event.type === "tool_progress")) {
    problems.push("missing-tool-progress");
  }
  if (profile.id === "tanya.medium.compaction-boundary" && !events.some((event) => event.type === "compact_event" && event.compactType === "auto")) {
    problems.push("missing-auto-compaction");
  }
  const blocked = finalText
    .split(/\r?\n/)
    .some((line) => {
      const match = line.trim().match(/^Blocked:\s*(.+)$/i);
      return !!match?.[1] && !/^none\b/i.test(match[1].trim());
    });
  return {
    profile,
    workspace: fixture.workspace,
    passed: !blocked && problems.length === 0,
    finalText,
    problems,
    turns: (fixture.provider as ChatProvider & { requests?: ChatRequest[] }).requests?.length ?? events.filter((event) => event.type === "message_start").length,
  };
}

export async function runGoldenTask(profileId: string): Promise<GoldenRunResult> {
  const profile = loadGoldenTaskProfiles().find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown golden profile: ${profileId}`);
  const fixture = await createFixture(profile);
  return runFixture(profile, fixture);
}

export async function runEditBlockFuzzyGoldenComparison(): Promise<{
  enabled: GoldenRunResult;
  disabled: GoldenRunResult;
}> {
  const profile = loadGoldenTaskProfiles().find((item) => item.id === "tanya.medium.edit-block-fuzzy");
  if (!profile) throw new Error("Unknown golden profile: tanya.medium.edit-block-fuzzy");
  const enabled = await runFixture(profile, await editBlockFuzzyFixture(profile, "enabled"));
  const disabled = await runFixture(profile, await editBlockFuzzyFixture(profile, "disabled"));
  return { enabled, disabled };
}
