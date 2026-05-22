import type { EventSink } from "../events/types";
import { createSubAgentSink } from "../events/subAgentSink";
import type { TanyaRunContext } from "../context/runContext";
import type { FinalStateVerification, VerifierShell } from "./verifier";
import { isContextWindowExceededError, type ChatMessage, type ChatProvider, type ToolCall } from "../providers/types";
import {
  TOOL_CALL_CORRECTION_LIMIT,
  malformedToolCallCorrectionMessage,
  parseProviderToolCalls,
  parseToolArguments,
} from "../providers/parser";
import { resolveWorkspace } from "../safety/workspace";
import { decide, inputShape, type Decision, type PermissionContext } from "../safety/permissions/engine";
import type { HostPermissionAnswer, PermissionRequest, PermissionRequestHandler } from "../safety/permissions/host";
import { loadPermissionRules, mergeInheritedPermissionRules, stricterPermissionMode } from "../safety/permissions/rules";
import type { PermissionMode } from "../safety/permissions/schema";
import { ToolRegistry } from "../tools/registry";
import { recordGoldenTaskMemory } from "../memory/goldenTasks";
import { recordRepairRunMemory, type RepairAttemptSnapshot } from "../memory/repairRuns";
import { appendTaskHistory, buildHistoryBlock, readRecentTaskHistory } from "../memory/taskHistory";
import { appendTaskToVault } from "../obsidian/vaultAppender";
import { envValue, numberEnvValue } from "../config/envCompat";
import { appendArchive, toArchivedMessages } from "../memory/runArchive";
import { appendAuditDecision } from "../memory/auditLog";
import { estimateRunCost } from "../memory/runLogs";
import { writeCachedToolResult } from "../memory/resultCache";
import { FileReadDedupCache } from "../memory/fileReadDedup";
import { buildRepoMap } from "../context/repoMap";
import { appendReasoningChunk, evictReasoningFromArchive } from "../memory/reasoningArchive";
import { loadMcpToolsForWorkspace } from "../mcp/client";
import type { SubAgentTaskRequest, SubAgentTaskResult, TanyaTool, ToolResult } from "../tools/types";
import {
  classifyStep,
  contextWindowForTarget,
  EscalationExhaustedError,
  resolveRouteWithContextGuard,
  type EffectiveRouteTable,
  type ResolvedRoute,
  type RouteTarget,
  type StepType,
} from "../router";
import type { ValidationSummary } from "./validators";
import {
  autoCompact,
  CompactionExhaustedError,
  estimateCompactTokens,
  microcompact,
  snipLowSignal,
  type CompactionAggression,
} from "./compact";
import {
  buildFallbackCodingReport,
  buildFinalManifest,
  collectChangedFiles,
  ensureCodingReport,
  failedVerificationBlockers,
  hasRequiredCodingReport,
  isCodingTask,
} from "./report";
import { captureGitSnapshot, commitStillRequired, hasTrackedPathUnder, listFilesRecursive, uniqueSorted } from "./git";
import { buildSystemPrompt } from "./systemPrompt";
import {
  applyTokenBudgetRule,
  childRunId,
  createRootRunId,
  mergeRunContexts,
  resolveSubAgentWorkspace,
  type RunAgentParentContext,
} from "./subAgentContext";
import { AsyncSemaphore, BudgetLedger } from "./budgetLedger";
import { isLikelySubtaskCycle } from "./cycleDetect";
import type { ChildVerdict, ReasoningAnnotation } from "./verifier/types";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
const CONTEXT_TOKEN_LIMIT = 48_000;
const CONTEXT_SUMMARY_KEEP_RECENT = 6;
const permissionModes = new Set<PermissionMode>(["default", "ask", "bypass", "plan"]);
let sessionSpendTokens = 0;
let sessionSpendUsd = 0;
let sessionEscalations = 0;
const TOOL_RESULT_TRUNCATE_THRESHOLD = 2_048;
const TOOL_RESULT_HEAD_CHARS = 1_024;
const TOOL_RESULT_TAIL_CHARS = 500;
const EXPAND_RESULT_LIMIT_PER_TURN = 3;

export type TanyaFinalManifest = {
  schemaVersion: 1;
  changedFiles: string[];
  uncommittedFiles: string[];
  artifactsRead: string[];
  artifactsCreated: string[];
  contextFilesRead: string[];
  verification: string[];
  git: {
    root: string | null;
    head: string | null;
  };
  toolErrors: number;
  blockers: string[];
  childRunIds?: string[];
  childVerdicts?: ChildVerdict[];
  childWarnings?: string[];
  reasoningAnnotations?: ReasoningAnnotation[];
  validation?: ValidationSummary;
  finalStateVerification?: FinalStateVerification;
};

export type RunAgentResult = {
  message: string;
  manifest: TanyaFinalManifest;
  metrics?: FinalMetrics;
};

type FinalMetrics = {
  durationMs: number;
  toolCallCount: number;
  toolErrorCount: number;
  changedFileCount: number;
  repairAttemptCount: number;
  retryAttemptCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  systemPromptTokens: number;
  repoMapTokens: number;
  toolResultTokens: number;
};

export interface RunAgentOptions {
  provider: ChatProvider;
  prompt: string;
  cwd: string;
  sink: EventSink;
  maxTurns?: number;
  history?: ChatMessage[];
  runContext?: TanyaRunContext;
  parentContext?: RunAgentParentContext;
  runId?: string;
  repairAttempts?: number;
  retryAttempt?: number;
  signal?: AbortSignal;
  onPermissionRequest?: PermissionRequestHandler;
  verifierShell?: VerifierShell | undefined;
  routing?: {
    enabled: boolean;
    table: EffectiveRouteTable;
    providerFactory: (target: RouteTarget) => ChatProvider;
  };
}

function findSafeCompressionBoundary(messages: ChatMessage[], desiredKeepCount: number): number {
  if (messages.length <= desiredKeepCount + 1) return Math.max(1, messages.length - desiredKeepCount);
  let startIndex = messages.length - desiredKeepCount;
  // Cap how many leading tool messages we'll walk past — a runaway loop of
  // back-to-back tool results without an assistant tool_calls header indicates
  // a corrupt history; in that case fall back to the original boundary.
  const maxWalk = Math.min(8, messages.length - startIndex);
  let walked = 0;
  while (startIndex < messages.length && messages[startIndex]?.role === "tool" && walked < maxWalk) {
    const prev = messages[startIndex - 1];
    if (prev?.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
      startIndex -= 1;
      break;
    }
    startIndex += 1;
    walked += 1;
  }
  if (startIndex >= messages.length) return messages.length - 1;
  return Math.max(1, startIndex);
}

function fieldMatchesType(value: unknown, expectedType: string): boolean {
  if (expectedType === "array") return Array.isArray(value);
  return typeof value === expectedType;
}

function validateToolInput(
  input: unknown,
  definition: { function: { parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } } },
): string | null {
  const params = definition.function.parameters;
  if (!params) return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const key of params.required ?? []) {
    if (!(key in record) || record[key] === undefined || record[key] === null) {
      return `Missing required field: "${key}"`;
    }
    const expectedType = params.properties?.[key]?.type;
    if (expectedType && !fieldMatchesType(record[key], expectedType)) {
      const actualType = Array.isArray(record[key]) ? "array" : typeof record[key];
      return `Field "${key}" must be ${expectedType}, got ${actualType}`;
    }
  }
  return null;
}

function materializedContextCleanupEnabled(manifest: TanyaFinalManifest, runContext?: TanyaRunContext): boolean {
  const metadata = runContext?.metadata ?? {};
  if (metadata.tanyaMaterializedContext !== true) return false;
  if (metadata.keepMaterializedContext === true) return false;
  if (manifest.blockers.length > 0) return false;
  if (manifest.validation && !manifest.validation.passed) return false;
  return true;
}

async function cleanupMaterializedContext(workspace: string, manifest: TanyaFinalManifest, runContext?: TanyaRunContext): Promise<void> {
  if (!materializedContextCleanupEnabled(manifest, runContext)) return;
  const taniaDir = resolve(workspace, ".tania");
  if (!existsSync(taniaDir)) return;
  if (await hasTrackedPathUnder(workspace, ".tania")) return;
  try {
    await rm(taniaDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; successful task output should not fail because temp cleanup failed.
  }
}

async function appendObsidianTaskIfConfigured(manifest: TanyaFinalManifest, runContext?: TanyaRunContext): Promise<void> {
  const metadataVault = runContext?.metadata?.obsidianVault;
  const vaultPath = typeof metadataVault === "string" && metadataVault.trim()
    ? metadataVault.trim()
    : envValue({}, "TANYA_OBSIDIAN_VAULT").trim();
  if (!vaultPath) return;
  try {
    await appendTaskToVault(vaultPath, manifest, runContext);
  } catch {
    // Obsidian logging is best-effort and must never fail a Tanya run.
  }
}

async function appendTaskHistorySilently(
  workspace: string,
  prompt: string,
  manifest: TanyaFinalManifest,
  runContext?: TanyaRunContext,
): Promise<void> {
  try {
    await appendTaskHistory(workspace, prompt, manifest, runContext);
  } catch {
    // Local history is best-effort and must never fail a Tanya run.
  }
}

async function recordRepairRunMemorySilently(
  runContext: TanyaRunContext | undefined,
  attempts: RepairAttemptSnapshot[],
  manifest: TanyaFinalManifest,
): Promise<void> {
  try {
    await recordRepairRunMemory(runContext, attempts, manifest);
  } catch {
    // Cross-session repair memory is best-effort and must never fail a Tanya run.
  }
}

// Keep at most this many run summary files per workspace; older ones are deleted.
// One workspace can produce 30+ run files in a single session (orchestrated loops),
// so the directory grows unbounded without rotation.
export const RUN_SUMMARY_MAX_FILES = 50;

export function rotateRunSummaryFiles(runsDir: string): void {
  try {
    const entries = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
    const excess = entries.length - RUN_SUMMARY_MAX_FILES;
    if (excess <= 0) return;
    for (const stale of entries.slice(0, excess)) {
      try { unlinkSync(join(runsDir, stale)); } catch { /* best-effort */ }
    }
  } catch {
    // Rotation must never fail the task.
  }
}

function logRunSummarySilently(params: {
  workspace: string;
  runId: string;
  parentRunId?: string;
  prompt: string;
  provider: string;
  model: string;
  metrics: FinalMetrics;
  manifest: TanyaFinalManifest;
}): void {
  try {
    const runsDir = join(params.workspace, ".tania", "runs");
    const outputDir = params.parentRunId ? join(runsDir, params.parentRunId) : runsDir;
    mkdirSync(outputDir, { recursive: true });
    const ts = new Date().toISOString();
    const logPath = join(outputDir, params.parentRunId ? `${params.runId}.json` : `${params.runId}.json`);
    writeFileSync(
      logPath,
      JSON.stringify(
        {
          ts,
          runId: params.runId,
          ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
          prompt: params.prompt.slice(0, 200),
          provider: params.provider,
          model: params.model,
          durationMs: params.metrics.durationMs,
          promptTokens: params.metrics.promptTokens,
          completionTokens: params.metrics.completionTokens,
          reasoningTokens: params.metrics.reasoningTokens,
          systemPromptTokens: params.metrics.systemPromptTokens,
          repoMapTokens: params.metrics.repoMapTokens,
          toolResultTokens: params.metrics.toolResultTokens,
          changedFiles: params.manifest.changedFiles,
          blockers: params.manifest.blockers,
          toolCallCount: params.metrics.toolCallCount,
          repairAttemptCount: params.metrics.repairAttemptCount,
          retryAttemptCount: params.metrics.retryAttemptCount,
          validation: params.manifest.validation ?? null,
          artifactsRead: params.manifest.artifactsRead,
        },
        null,
        2,
      ),
      "utf8",
    );
    rotateRunSummaryFiles(outputDir);
  } catch {
    // Run logs are best-effort and must never fail the task.
  }
}

function buildFinalReportReminder(changedFiles: string[], toolErrorCount: number): string {
  return [
    "You must now stop using tools and produce the final coding report.",
    "Use the caller's required final report format.",
    "Include either `Artifact reused: <artifact-path> -> <target-path>` for adapted artifacts or exactly `Artifact reused: none`.",
    "Include either `Artifact created: <artifact-path> -> reusable artifact` for reusable artifacts created or exactly `Artifact created: none`.",
    "Include one `Verification: <command> -> <result>` line for every verification command you ran.",
    "Include one plain `Artifact reused: <artifact-path> -> <target-path>` line for every artifact you adapted.",
    "Only attribute files directly adapted from an artifact; do not list unrelated config, formatter-only files, generated icons, or source files under an artifact just because the artifact was read.",
    changedFiles.length > 0
      ? "Include one `Modified: <path>` line for every changed file."
      : "If no files needed changes because the existing setup already satisfied the task, include exactly: `Verification-only: existing setup satisfied`.",
    "Do not create or keep backup files such as `.orig`, `.bak`, `.backup`, or `.tmp`.",
    toolErrorCount > 0
      ? `Mention the ${toolErrorCount} tool error${toolErrorCount === 1 ? "" : "s"} as recovered issues if later verification passed; only list active blockers under Blocked.`
      : "If there are no blockers, say so briefly.",
    "Do not call more tools unless the final report is impossible without one specific missing fact.",
  ].join("\n");
}

function buildCommitRequiredReminder(manifest: TanyaFinalManifest): string {
  const uncommitted = manifest.uncommittedFiles.length > 0 ? manifest.uncommittedFiles : manifest.changedFiles;
  return [
    manifest.uncommittedFiles.length > 0
      ? "The caller requires a git commit, and there are still in-scope changed files that are not included in the task commit."
      : "You changed files and the caller requires a git commit, but HEAD has not changed yet.",
    "Do not produce the final report until the commit is created.",
    manifest.git.head
      ? "Call `commit_platform_changes` with `amend: true` to add the remaining in-scope files to the existing task commit."
      : "Call `commit_platform_changes` now with the in-scope changed files and the exact required commit-message prefix from the prompt.",
    `Files that must be committed: ${uncommitted.join(", ") || "none"}`,
    "After the commit succeeds, run `git rev-parse --short HEAD`, then produce the final report.",
  ].join("\n");
}

function buildValidationRepairReminder(manifest: TanyaFinalManifest, attempt: number, maxAttempts: number): string {
  const issues = manifest.validation?.issues ?? [];
  const issueLines = issues.length > 0
    ? issues.map((issue) => `- ${issue.id}: ${issue.message}${issue.files?.length ? ` (${issue.files.join(", ")})` : ""}`)
    : ["- validation failed without detailed issues"];
  const blockerLines = manifest.blockers.length > 0
    ? manifest.blockers.map((blocker) => `- ${blocker}`)
    : [];
  const repairHints: string[] = [];
  const issueIds = new Set(issues.map((issue) => issue.id));
  if (issueIds.has("apple-app-icon-xcodebuild-missing")) {
    repairHints.push("For Apple app icon verification, run a direct `xcodebuild build` command with an available scheme and a concrete or generic simulator destination. Report the exact command only after it passes.");
  }
  if (manifest.blockers.some((blocker) => /failed verification:/i.test(blocker))) {
    repairHints.push("Resolve every failed verification with a later passing rerun of the same check, or keep the task blocked and do not claim completion.");
  }
  if (issueIds.has("core-verification-requested-command-missing")) {
    repairHints.push("Run every missing requested verification command exactly as named in the issue message. Do not substitute file-existence probes, package-lock checks, or equivalent commands for required commands such as `npm install`.");
  }
  if (issueIds.has("core-artifact-provenance-missing")) {
    repairHints.push("READ at least one caller-provided artifact NOW using read_file on a path under .tania/artifacts/, then report it as `Artifact reused: <artifact-path> -> <target-file-or-verification-only>`. This applies even when the existing setup is already complete: pick one artifact under .tania/artifacts/ and read it to confirm the canonical pattern, then report the line.");
  }
  if (issueIds.has("android-gradle-assembledebug-missing")) {
    repairHints.push("For Android Gradle verification, run `./gradlew assembleDebug --no-daemon` from the Android workspace root and report it only after it exits successfully.");
  }
  if (issueIds.has("android-gradle-ktlintcheck-missing")) {
    repairHints.push("For Android ktlint verification, run `./gradlew ktlintCheck --no-daemon` from the Android workspace root and report it only after it exits successfully.");
  }
  if (issueIds.has("ios-splash-solid-background-violated")) {
    repairHints.push("For iOS splash solid-background violations, remove LinearGradient/RadialGradient/AngularGradient and use a single explicit brand Color value.");
  }
  if (issueIds.has("ios-splash-text-forbidden")) {
    repairHints.push("For iOS splash text-forbidden violations, remove all Text(...) views, taglines, labels, and captions from SplashScreenView.swift.");
  }
  if (issueIds.has("ios-splash-extra-animation")) {
    repairHints.push("For iOS splash extra-animation violations, keep only the brief icon fade-in; remove pulse, scale, rotation, shimmer, and repeatForever animations.");
  }
  if (issueIds.has("ios-splash-icon-image")) {
    repairHints.push("For iOS splash icon-image violations, render Image(\"SplashIcon\") from SplashIcon.imageset instead of app names, SF Symbols, or remote images.");
  }
  if ([...issueIds].some((id) => /onboarding-final-cta-slide-missing/.test(id))) {
    repairHints.push("For onboarding CTA violations, make the final pager page a dedicated CTA slide with `Começar grátis` and `Já tenho conta`; do not use a normal feature slide with CTA buttons only in the footer.");
  }
  if ([...issueIds].some((id) => /onboarding-skip-not-top-right/.test(id))) {
    repairHints.push("For onboarding skip placement violations, move `Pular` into a top-right overlay aligned to the safe area and hide it on the final CTA slide.");
  }
  if ([...issueIds].some((id) => /onboarding-storage-key-missing/.test(id))) {
    repairHints.push("For onboarding persistence violations, use the exact completion key `hasSeenOnboarding` in UserDefaults/AppStorage or DataStore.");
  }
  if (issueIds.has("android-base-layout-feature-missing")) {
    repairHints.push("For Android base layout feature coverage, derive the tabs/routes from every named feature in the prompt. Do not use generic buckets like Settings unless Settings is explicitly one of the requested app features.");
  }
  if (issueIds.has("android-base-layout-premium-gate-missing")) {
    repairHints.push("For Android premium feature coverage, wrap premium feature placeholder content with PremiumGate or an equivalent entitlement-state gate. Premium placeholders can show locked/paywall states until RevenueCat is fully configured.");
  }
  return [
    `Tanya validation found task-specific problems before finalization. Repair attempt ${attempt} of ${maxAttempts}.`,
    "Fix the implementation directly, rerun the relevant verification commands, then produce the required final report.",
    "If you already created a task commit before this validation repair, amend that task commit after fixing the files instead of creating a second task commit.",
    "Use `commit_platform_changes` with `amend: true` when amending is needed.",
    "",
    "Validation issues:",
    ...issueLines,
    ...(blockerLines.length > 0 ? ["", "Blocking verification failures:", ...blockerLines] : []),
    ...(repairHints.length > 0 ? ["", "Targeted repair instructions:", ...repairHints.map((hint) => `- ${hint}`)] : []),
    "",
    "Current changed files:",
    manifest.changedFiles.length > 0 ? manifest.changedFiles.map((file) => `- ${file}`).join("\n") : "- none",
  ].join("\n");
}

function validationRepairSignature(manifest: TanyaFinalManifest): string {
  const issueIds = manifest.validation?.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.id}:${issue.files?.join(",") ?? ""}`) ?? [];
  return [...issueIds, ...manifest.blockers].sort().join("|") || "unknown-validation-failure";
}

function pruneStaleRepairReminders(messages: ChatMessage[]): ChatMessage[] {
  const isRepairReminder = (msg: ChatMessage | undefined): boolean => {
    if (!msg) return false;
    if (msg.role !== "user") return false;
    if (typeof msg.content !== "string") return false;
    return /Tanya validation found task-specific problems before finalization\. Repair attempt/i.test(msg.content);
  };
  let lastIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (isRepairReminder(messages[i])) lastIndex = i;
  }
  if (lastIndex === -1) return messages;
  return messages.filter((msg, idx) => idx === lastIndex || !isRepairReminder(msg));
}

function isTypeScriptProject(workspace: string): boolean {
  return existsSync(join(workspace, "tsconfig.json"));
}

function repairAttemptBudget(options: RunAgentOptions): number {
  const configured = typeof options.runContext?.metadata?.repairAttempts === "number"
    ? options.runContext.metadata.repairAttempts
    : typeof options.runContext?.metadata?.repairAttempts === "string"
      ? Number(options.runContext.metadata.repairAttempts)
      : options.repairAttempts;
  if (typeof configured === "number" && Number.isFinite(configured)) return Math.max(0, Math.min(5, Math.floor(configured)));
  if (!isCodingTask(options.runContext)) return 0;
  return isTypeScriptProject(options.cwd) ? 3 : 2;
}

function repairAttemptSnapshot(attempt: number, manifest: TanyaFinalManifest): RepairAttemptSnapshot {
  return {
    attempt,
    issueIds: manifest.validation?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.id).sort() ?? [],
    blockerCount: manifest.blockers.length,
    changedFileCount: manifest.changedFiles.length,
  };
}

function commandLabel(toolName: string, input: unknown): string | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (toolName === "run_shell") {
    const script = typeof record.script === "string"
      ? record.script.trim()
      : typeof record.command === "string"
        ? record.command.trim()
        : "";
    return script || null;
  }
  if (toolName === "run_command") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
    return command ? [command, ...args].join(" ") : null;
  }
  if (/^validate_/.test(toolName)) return toolName;
  return null;
}

function toolResultMutatedFiles(toolName: string, result: { ok: boolean; files?: string[] }): boolean {
  if (!result.ok) return false;
  if ((result.files ?? []).length > 0) return true;
  return mutatingToolNames.has(toolName);
}

const mutatingToolNames = new Set([
    "write_file",
    "apply_patch",
    "search_replace",
    "copy_file",
    "copy_directory",
    "apply_artifact",
    "commit_platform_changes",
    "create_apple_app_icon_set",
    "create_android_launcher_icon_set",
    "create_android_foundation",
    "render_svg_to_png",
    "resize_image",
]);

function requiredHighLevelTool(runContext: TanyaRunContext | undefined, prompt = ""): string | null {
  const includeRawPrompt = runContext?.metadata?.caller === "cosmochat";
  const text = [
    includeRawPrompt ? prompt : "",
    runContext?.task?.title,
    runContext?.task?.summary,
    ...(runContext?.instructions ?? []),
  ].filter(Boolean).join("\n").toLowerCase();
  if (/\b(?:android\s+foundation|foundation\s+(?:—|-|for)\s+android|fundações\s+(?:—|-)\s+android|build android foundation)\b/.test(text)) {
    return "create_android_foundation";
  }
  if (/\b(?:ios\s+splash|splash\s+screen\s+(?:—|-|for)\s+ios|splash\s+screen.*\bios\b|create the splash screen.*\bios\b)\b/.test(text)) {
    return "create_ios_splash";
  }
  return null;
}

function toolCallMayMutate(toolName: string, input: unknown): boolean {
  if (mutatingToolNames.has(toolName)) return true;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (toolName === "run_shell") {
    const script = typeof record.script === "string" ? record.script : "";
    return /\b(?:cat|printf|echo)\b[\s\S]{0,200}>\s*[^&|;\n]|\btee\s+[^|;\n]+|\b(?:mkdir|touch|rm|mv|cp)\s+|\bsed\s+-i\b|\bperl\s+-pi\b|\bktlintFormat\b/.test(script);
  }
  if (toolName === "run_command") {
    const command = typeof record.command === "string" ? record.command : "";
    const args = Array.isArray(record.args) ? record.args.join(" ") : "";
    return /\b(?:git|npm|pnpm|yarn|gradle|\.\/gradlew)\b/.test(command) && /\b(?:add|commit|install|ktlintFormat)\b/.test(args);
  }
  return false;
}

function verificationKey(label: string): string {
  const isUnsafeXcodebuildPipe = /\bxcodebuild\b/i.test(label) && /\|/.test(label) && !/set\s+-o\s+pipefail/.test(label);
  const usesGradle = /(?:^|[\s;&|])(?:\.\/gradlew|gradle)\b/i.test(label);
  const usesMobileBuildTool = /(?:^|[\s;&|])(?:\.\/gradlew|gradle|xcodebuild)\b/i.test(label);
  const isUnsafeGradlePipe = usesGradle && /\|/.test(label) && !/set\s+-o\s+pipefail/.test(label);
  const masksExitCode = usesMobileBuildTool && /;\s*echo\s+["']?EXIT_CODE=\$\?["']?/i.test(label);
  if (isUnsafeGradlePipe || masksExitCode) return label.replace(/\s+/g, " ").trim();
  if (!isUnsafeXcodebuildPipe && /\bxcodebuild\s+build\b/i.test(label)) return "xcodebuild build";
  if (!isUnsafeXcodebuildPipe && /\bxcodebuild\s+test\b/i.test(label)) return "xcodebuild test";
  if (/\bxcodebuild\s+-list\b/i.test(label)) return "xcodebuild -list";
  if (/\bfastlane\s+lanes\b/i.test(label)) return "fastlane lanes";
  if (/\bgit\s+rev-parse\s+--show-toplevel\b/i.test(label)) return "git root";
  if (/\bgit\s+rev-parse\s+--short\s+HEAD\b/i.test(label)) return "git head";
  return label.replace(/\s+/g, " ").trim();
}

function shellCommandSpiralKey(input: unknown): string | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const script = typeof record.script === "string"
    ? record.script
    : typeof record.command === "string"
      ? record.command
      : "";
  const normalized = script
    .replace(/\$\(\s*go\s+env\s+GOMODCACHE\s*\)/g, "$(go env GOMODCACHE)")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function shouldApplyShellSpiralDetector(command: string): boolean {
  return /\bgrep\b/i.test(command) &&
    /\b(?:GOMODCACHE|go env GOMODCACHE|pkg\/mod|github\.com\/danielgtaylor\/huma\/v2|huma\/v2)\b/i.test(command);
}

function artifactPathFromRead(toolName: string, input: unknown): string | null {
  if (toolName !== "read_file") return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return null;
  if (path.startsWith(".tania/artifacts/")) return path;
  if (path.startsWith("artifacts/")) return path;
  return null;
}

function contextPathFromRead(toolName: string, input: unknown, runContext?: TanyaRunContext): string | null {
  if (toolName !== "read_file") return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return null;
  if (path.startsWith(".tania/context/")) return path;
  if ((runContext?.contextFiles ?? []).some((contextFile) => contextFile.path === path)) return path;
  return null;
}

function outsideWorkspaceReadMessage(workspace: string, toolName: string, input: unknown): string | null {
  if (toolName !== "read_file") return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path || !isAbsolute(path)) return null;
  const target = resolve(path);
  const rel = relative(workspace, target);
  if (!rel.startsWith("..") && rel !== "..") return null;
  return [
    `Skipped external path outside workspace: ${path}.`,
    "The caller should materialize external context inside the workspace or embed it in the prompt.",
    "Do not retry this absolute path; continue with the workspace-local context and report the skipped external read only if it matters.",
  ].join(" ");
}

function resolvePermissionMode(loadedMode: PermissionMode): PermissionMode {
  const rawMode = envValue(process.env, "TANYA_MODE")?.trim();
  return rawMode && permissionModes.has(rawMode as PermissionMode) ? rawMode as PermissionMode : loadedMode;
}

function permissionEventSource(decision: Decision, mode: PermissionMode): "rule" | "engine" | "bypass" {
  if (mode === "bypass" && decision.decision === "allow" && decision.reason === "bypass-mode") return "bypass";
  return decision.matchedRule ? "rule" : "engine";
}

function auditPermissionDecision(workspace: string, context: PermissionContext, tool: string, input: unknown, decision: Decision, source: "user" | "rule" | "engine" | "bypass"): void {
  const auditSource = mcpAuditSource(tool) ?? source;
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool,
    input,
    decision: decision.decision,
    source: auditSource,
    mode: context.mode,
    ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.projectedCostUsd !== undefined ? { projectedCostUsd: decision.projectedCostUsd } : {}),
    ...(decision.projectedTokens !== undefined ? { projectedTokens: decision.projectedTokens } : {}),
    ...(decision.thresholdUsd !== undefined ? { thresholdUsd: decision.thresholdUsd } : {}),
    ...(decision.thresholdTokens !== undefined ? { thresholdTokens: decision.thresholdTokens } : {}),
  });
}

function mcpAuditSource(tool: string): `mcp:${string}` | null {
  if (!tool.startsWith("mcp:")) return null;
  const [, server] = tool.split(":");
  return server ? `mcp:${server}` : "mcp:unknown";
}

function providerKey(provider: ChatProvider): string {
  return `${provider.id}/${provider.model}`;
}

function auditModelRouted(workspace: string, context: PermissionContext, event: {
  stepType: StepType;
  provider: string;
  model: string;
  reason: string;
  cacheImpact?: "hit" | "miss" | "unknown";
}): void {
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool: "model_routed",
    input: event,
    decision: "allow",
    source: "engine",
    mode: context.mode,
    reason: event.reason,
  });
}

function auditEscalation(workspace: string, context: PermissionContext, event: {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: "parse_failure" | "schema_failure" | "context_too_small";
  stepType: StepType;
}): void {
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool: "escalation_event",
    input: event,
    decision: "allow",
    source: "engine",
    mode: context.mode,
    reason: event.reason,
  });
}

function outputRecord(result: ToolResult): Record<string, unknown> {
  return result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? result.output as Record<string, unknown>
    : {};
}

function withEditBlockRepairHint(tool: string, result: ToolResult): ToolResult {
  if (tool !== "edit_block" || result.ok) return result;
  const output = outputRecord(result);
  const candidateExcerpt = typeof output.candidateExcerpt === "string" && output.candidateExcerpt.trim()
    ? output.candidateExcerpt.trim()
    : "";
  const hint = candidateExcerpt
    ? `consider re-reading the file and emitting a closer search block. Closest candidate excerpt:\n${candidateExcerpt}`
    : "consider re-reading the file and emitting a closer search block";
  return {
    ...result,
    error: result.error ? `${result.error}; ${hint}` : hint,
    output: { ...output, repairHint: hint },
  };
}

const shellSafetyRepairHint = [
  "Your cleanup command was blocked by Tanya's safety policy.",
  "Safer alternatives:",
  "- For build artifacts: rely on the next run's clean step; don't manually rm",
  "- For temporary files: use mktemp -d and let the OS clean /tmp eventually",
  "- For workspace state: use git clean -fd inside the workspace instead",
  "Re-attempt the task; cleanup isn't required for verification.",
].join("\n");

function toolResultReason(result: ToolResult): string | undefined {
  const output = outputRecord(result);
  const reason = output.reason;
  return typeof reason === "string" ? reason : undefined;
}

function withShellSafetyRepairHint(result: ToolResult): ToolResult {
  if (result.ok || toolResultReason(result) !== "shell_safety_block") return result;
  const output = outputRecord(result);
  const error = result.error && result.error.includes(shellSafetyRepairHint)
    ? result.error
    : [result.error, shellSafetyRepairHint].filter(Boolean).join("\n\n");
  return {
    ...result,
    error,
    output: { ...output, repairHint: shellSafetyRepairHint },
  };
}

function withRunnerRepairHints(tool: string, result: ToolResult): ToolResult {
  return withShellSafetyRepairHint(withEditBlockRepairHint(tool, result));
}

function networkFailureCommandText(toolName: string, input: unknown): string {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (toolName === "run_shell") {
    return typeof record.script === "string"
      ? record.script
      : typeof record.command === "string" ? record.command : "";
  }
  if (toolName === "run_command") {
    const command = typeof record.command === "string" ? record.command : "";
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string").join(" ") : "";
    return `${command} ${args}`.trim();
  }
  return "";
}

function looksLikeNetworkOrDependencyFailure(toolName: string, input: unknown, result: ToolResult): boolean {
  if (result.ok) return false;
  if (toolName !== "run_shell" && toolName !== "run_command") return false;
  const command = networkFailureCommandText(toolName, input);
  const output = [result.summary, result.error, typeof result.output === "string" ? result.output : ""].join("\n");
  return /\b(?:pip3?|python3?\s+-m\s+pip|npm\s+(?:install|i)|pnpm\s+install|yarn\s+install|bun\s+install|curl|wget|requests|beautifulsoup|bs4)\b/i.test(command) ||
    /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|DNS|timeout|certificate|Could not resolve|Temporary failure|No matching distribution|command not found: pip|pip: command not found)\b/i.test(output);
}

function buildNetworkFallbackReminder(): string {
  return [
    "Network or dependency operations failed twice.",
    "Stop retrying the same live network/install path in this run.",
    "Scaffold a local mock fallback so the task can complete:",
    "- include deterministic sample data or a mock response path",
    "- keep the real network code path when practical",
    "- document mock versus live behavior and the network/dependency limitation in README.md",
    "Then run a local verification command that does not require the unavailable network path.",
  ].join("\n");
}

function auditEditBlockCandidate(workspace: string, context: PermissionContext, input: unknown, result: ToolResult): void {
  const output = outputRecord(result);
  if (output.matchPolicy !== "fuzzy") return;
  if (output.recoveredVia === undefined || output.recoveredVia === "exact") return;
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool: "edit_block",
    input: {
      path: typeof output.path === "string" ? output.path : undefined,
      requested: input,
      fuzzyCandidate: {
        recoveredVia: output.recoveredVia,
        confidence: output.confidence,
        candidateExcerpt: output.candidateExcerpt,
      },
    },
    decision: "allow",
    source: "engine",
    mode: context.mode,
    reason: "fuzzy-candidate-applied",
  });
}

function deniedPermissionResult(decision: Decision, fallback = "permission denied"): {
  ok: false;
  summary: string;
  error: string;
  output: { ok: false; error: string; rule?: string; reason?: string };
} {
  const matched = decision.matchedRule ?? decision.reason;
  const error = matched ? `denied by rule: ${matched}` : fallback;
  return {
    ok: false,
    summary: error,
    error,
    output: {
      ok: false,
      error,
      ...(decision.matchedRule ? { rule: decision.matchedRule } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    },
  };
}

function permissionCacheKey(tool: string, input: unknown): string {
  return `${tool}:${inputShape(input)}`;
}

function permissionRequestFromDecision(id: string, tool: string, input: unknown, decision: Decision): PermissionRequest {
  return {
    id,
    tool,
    input,
    ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    ...(decision.projectedCostUsd !== undefined ? { projectedCostUsd: decision.projectedCostUsd } : {}),
    ...(decision.projectedTokens !== undefined ? { projectedTokens: decision.projectedTokens } : {}),
  };
}

function projectedToolSpend(input: unknown, provider: ChatProvider): { projectedTokens: number; projectedUsd: number } {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const projectedTokens = numberField(record, "projectedTokens") ??
    numberField(record, "estimatedTokens") ??
    numberField(record, "estimatedOutputTokens") ??
    0;
  const explicitUsd = numberField(record, "projectedCostUsd") ?? numberField(record, "estimatedCostUsd");
  const projectedUsd = explicitUsd ?? (
    projectedTokens > 0
      ? estimateRunCost({
        provider: provider.id,
        model: provider.model,
        promptTokens: 0,
        completionTokens: projectedTokens,
      }).usd ?? 0
      : 0
  );
  return { projectedTokens, projectedUsd };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function truthyEnv(key: string): boolean {
  return /^(1|true|yes|on)$/i.test(envValue(process.env, key).trim());
}

function promptBudgetRatio(): number {
  const parsed = Number(envValue(process.env, "TANYA_PROMPT_BUDGET_RATIO"));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.25;
}

function subtaskMaxParallel(): number {
  return Math.max(1, Math.floor(numberEnvValue(process.env, "TANYA_SUBTASK_MAX_PARALLEL", 3)));
}

function subtaskCycleCheckEnabled(): boolean {
  const raw = envValue(process.env, "TANYA_SUBTASK_CYCLE_CHECK").trim();
  return raw === "" || !/^(0|false|off|no)$/i.test(raw);
}

function escalationCap(): number {
  return Math.max(0, Math.floor(numberEnvValue(process.env, "TANYA_ESCALATION_CAP", 5)));
}

// reasoningCapForTurn picks the per-turn reasoning-token budget. An explicit
// per-route reasoningCap always wins. Otherwise the budget falls back to two
// env-configurable tiers — short (planning / tool_call / unknown) and long
// (synthesis / verification / reasoning) — so heavier reasoning models can be
// given more headroom without hand-writing a full routes.json route table.
export function reasoningCapForTurn(stepType: StepType, route?: ResolvedRoute): number {
  if (route?.reasoningCap?.maxTokens) return route.reasoningCap.maxTokens;
  const shortCap = Math.max(1, Math.floor(numberEnvValue(process.env, "TANYA_REASONING_CAP_SHORT", 2_000)));
  const longCap = Math.max(1, Math.floor(numberEnvValue(process.env, "TANYA_REASONING_CAP_LONG", 8_000)));
  return stepType === "planning" || stepType === "tool_call" || stepType === "unknown" ? shortCap : longCap;
}

function resultOutputText(result: ToolResult): string | null {
  if (result.output === undefined || result.output === null) return null;
  if (typeof result.output === "string") return result.output;
  try {
    return JSON.stringify(result.output, null, 2);
  } catch {
    return String(result.output);
  }
}

function truncateToolResultForModel(params: {
  tool: TanyaTool;
  result: ToolResult;
  workspace: string;
  runId: string;
  toolCallId: string;
  expandCallsRemaining: number;
}): { modelResult: ToolResult; truncated: boolean } {
  if (params.tool.truncateLargeResults === false) {
    return { modelResult: params.result, truncated: false };
  }
  const output = resultOutputText(params.result);
  if (!output || output.length <= TOOL_RESULT_TRUNCATE_THRESHOLD) {
    return { modelResult: params.result, truncated: false };
  }

  writeCachedToolResult(params.workspace, params.runId, params.toolCallId, output);
  const omittedChars = Math.max(0, output.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS);
  const marker = [
    `<truncated ${omittedChars} chars; ask for more (tool_call_id=${params.toolCallId}; `,
    `you have ${Math.max(0, params.expandCallsRemaining)} expand_result call${params.expandCallsRemaining === 1 ? "" : "s"} left this turn)>`,
  ].join("");
  const modelOutput = [
    output.slice(0, TOOL_RESULT_HEAD_CHARS),
    marker,
    output.slice(-TOOL_RESULT_TAIL_CHARS),
  ].join("\n");
  return {
    modelResult: {
      ...params.result,
      summary: `${params.result.summary} Output was truncated for the model; use expand_result if more is needed.`,
      output: modelOutput,
    },
    truncated: true,
  };
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const parentContext = options.parentContext;
  const workspace = parentContext
    ? resolveSubAgentWorkspace(parentContext.workspace, options.cwd)
    : resolveWorkspace(options.cwd);
  if (parentContext) {
    const mergedRunContext = mergeRunContexts(parentContext.runContext, options.runContext);
    if (mergedRunContext) options.runContext = mergedRunContext;
    options.history = [...(parentContext.history ?? []), ...(options.history ?? [])];
  }
  const beforeGitSnapshot = await captureGitSnapshot(workspace);
  const registry = new ToolRegistry();
  await loadMcpToolsForWorkspace({ cwd: workspace, registry, sink: options.sink });
  const runStartedAt = new Date();
  const startedAt = runStartedAt.getTime();
  const runId = options.runId ?? (parentContext
    ? childRunId(parentContext.runId, parentContext.childIndex ?? 1)
    : createRootRunId(runStartedAt));
  const loadedPermissions = loadPermissionRules({ cwd: workspace });
  const inheritedPermissions = parentContext
    ? mergeInheritedPermissionRules(parentContext.permissionContext.rules, loadedPermissions.rules)
    : { rules: loadedPermissions.rules, warnings: [] };
  const rulesWithBudget = applyTokenBudgetRule(inheritedPermissions.rules, parentContext?.tokenBudget);
  const localMode = resolvePermissionMode(rulesWithBudget.mode);
  const permissionMode = parentContext
    ? stricterPermissionMode(parentContext.permissionContext.mode, localMode)
    : localMode;
  const permissionContext: PermissionContext = {
    mode: permissionMode,
    rules: { ...rulesWithBudget, mode: permissionMode },
    runId,
    cwd: workspace,
    ...(parentContext ? { parentContext: parentContext.permissionContext } : {}),
  };
  for (const warning of inheritedPermissions.warnings) {
    await options.sink({ type: "status", message: `Sub-agent permission inheritance warning: ${warning.reason}` });
  }
  const fileReadDedup = new FileReadDedupCache(workspace);
  const permissionAnswers = new Map<string, { answer: HostPermissionAnswer; source: "user" | "engine" }>();
  const changedFiles: string[] = [];
  let changed = changedFiles;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let totalToolResultTokens = 0;
  let runSpendTokens = 0;
  let runSpendUsd = 0;
  let activeProvider = options.provider;
  let lastProviderKey = providerKey(activeProvider);
  if (options.routing?.enabled) {
    try {
      const initialRoute = resolveRouteWithContextGuard({
        stepType: "planning",
        table: options.routing.table,
        messages: [...(options.history ?? []), { role: "user", content: options.prompt }],
      });
      activeProvider = options.routing.providerFactory(initialRoute);
      lastProviderKey = providerKey(activeProvider);
    } catch {
      activeProvider = options.provider;
      lastProviderKey = providerKey(activeProvider);
    }
  }
  const historyBlock = buildHistoryBlock(await readRecentTaskHistory(workspace));
  const promptBudgetEvents: Array<{ droppedSections: string[]; totalTokens: number; cap: number }> = [];
  const litePrompt = truthyEnv("TANYA_LITE_PROMPT");
  if (litePrompt) {
    try {
      await buildRepoMap(workspace, { writeCache: true });
    } catch {
      // Repo-map is advisory context. Indexing failures should not block a run.
    }
  }
  let repoMapTokens = 0;
  const systemPrompt = buildSystemPrompt(workspace, options.runContext, historyBlock, options.prompt, {
    lite: litePrompt,
    ...(activeProvider.contextWindow ? { contextWindow: activeProvider.contextWindow } : {}),
    promptBudgetRatio: promptBudgetRatio(),
    onPromptBudgetExceeded: (event) => {
      promptBudgetEvents.push(event);
    },
    onRepoMapTokens: (tokens) => {
      repoMapTokens = tokens;
    },
  });
  const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
  let messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(options.history ?? []),
    { role: "user", content: options.prompt },
  ];
  const maxTurns = options.maxTurns ?? 12;
  let finalText = "";
  let requestedFinalReport = false;
  let requestedCommitRepair = false;
  let validationRepairAttempts = 0;
  let lastValidationRepairSignature: string | null = null;
  const seenValidationRepairSignatures = new Set<string>();
  const repairAttempts: RepairAttemptSnapshot[] = [];
  let consecutiveNoToolNoReportTurns = 0;
  const MAX_NO_TOOL_NO_REPORT_TURNS = 2;
  const maxRepairAttempts = repairAttemptBudget(options);
  const verificationLines: string[] = [];
  const passedVerificationKeys = new Map<string, number>();
  const skippedDuplicateKeys = new Map<string, number>();
  const shellCommandSpiralCounts = new Map<string, number>();
  let shellCommandSpiralAdvisorySent = false;
  let consecutiveNetworkFailures = 0;
  let networkFallbackReminderSent = false;
  let networkFallbackReminderPending = false;
  let mutationRevision = 0;
  let readArtifactPaths: string[] = [];
  let readContextPaths: string[] = [];
  let createdArtifactPaths: string[] = [];
  const requiredTool = requiredHighLevelTool(options.runContext, options.prompt);
  let requiredToolUsed = requiredTool ? false : true;
  let toolCallCorrectionAttempts = 0;
  let parseEscalationUsed = false;
  let forcedNextRoute: { target: RouteTarget; stepType: StepType; reason: string } | null = null;
  let childSequence = 0;
  const childVerdicts: ChildVerdict[] = [];
  const subtaskSemaphore = new AsyncSemaphore(subtaskMaxParallel());
  const budgetLedger = new BudgetLedger({
    ...(parentContext?.tokenBudget?.max_tokens !== undefined ? { maxTokens: parentContext.tokenBudget.max_tokens } : {}),
    ...(parentContext?.tokenBudget?.max_usd !== undefined ? { maxUsd: parentContext.tokenBudget.max_usd } : {}),
  });

  function evictReasoningArchiveForCompaction(): void {
    try {
      evictReasoningFromArchive(workspace, runId, 0);
    } catch {
      // Reasoning archive eviction is best-effort; compaction must still proceed.
    }
  }

  for (const event of promptBudgetEvents) {
    await options.sink({ type: "prompt_budget_exceeded", ...event });
    auditPermissionDecision(
      workspace,
      permissionContext,
      "system_prompt",
      event,
      { decision: "allow", reason: "prompt-budget-enforced" },
      "engine",
    );
  }

  async function runSubAgentTask(request: SubAgentTaskRequest): Promise<SubAgentTaskResult> {
    childSequence += 1;
    const subRunId = childRunId(runId, childSequence);
    return subtaskSemaphore.run(async () => {
      const recentPrompts = [
        options.prompt,
        ...messages
          .filter((message) => message.role === "user" && typeof message.content === "string")
          .map((message) => message.content ?? ""),
      ].slice(-3);
      if (subtaskCycleCheckEnabled() && isLikelySubtaskCycle(request.prompt, recentPrompts)) {
        throw new Error("cycle_detected: child prompt is too similar to recent parent prompts");
      }

      const reservation = budgetLedger.reserve({
        ...(request.token_budget?.max_tokens !== undefined ? { maxTokens: request.token_budget.max_tokens } : {}),
        ...(request.token_budget?.max_usd !== undefined ? { maxUsd: request.token_budget.max_usd } : {}),
      });
      let usedForRelease: { maxTokens?: number; maxUsd?: number } = {};
      try {
        const childWorkspace = resolveSubAgentWorkspace(workspace, request.workspace);
        const historySnapshot = messages.filter((message) => message.role !== "system").map((message) => ({ ...message }));
        const childRunContext = {
          metadata: {
            subAgent: true,
            goldenTask: false,
            goldenTaskCandidate: false,
            ...(request.skill_pack_overrides?.length
              ? { subAgentSkillPackOverrides: request.skill_pack_overrides }
              : {}),
          },
        };
        await options.sink({
          type: "subtask_started",
          subRunId,
          parentRunId: runId,
          prompt: request.prompt,
          workspace: childWorkspace,
        });
        const childProvider = request.model && options.routing
          ? options.routing.providerFactory(request.model)
          : activeProvider;
        const childRouting = request.model ? undefined : options.routing;
        const runResult = await runAgent({
          provider: childProvider,
          prompt: request.prompt,
          cwd: childWorkspace,
          sink: createSubAgentSink(options.sink, subRunId),
          maxTurns: request.max_turns ?? 20,
          runContext: childRunContext,
          parentContext: {
            runId,
            workspace,
            permissionContext,
            history: historySnapshot,
            childIndex: childSequence,
            ...(options.runContext ? { runContext: options.runContext } : {}),
            ...(request.token_budget ? { tokenBudget: request.token_budget } : {}),
          },
          runId: subRunId,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onPermissionRequest ? { onPermissionRequest: options.onPermissionRequest } : {}),
          ...(childRouting ? { routing: childRouting } : {}),
        });
        const validationErrors = runResult.manifest.validation?.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message) ?? [];
        const tokensUsed = {
          in: runResult.metrics?.promptTokens ?? 0,
          out: runResult.metrics?.completionTokens ?? 0,
          reasoning: runResult.metrics?.reasoningTokens ?? 0,
        };
        const usedTokens = tokensUsed.in + tokensUsed.out + tokensUsed.reasoning;
        const usedUsd = estimateRunCost({
          provider: childProvider.id,
          model: childProvider.model,
          promptTokens: tokensUsed.in,
          completionTokens: tokensUsed.out,
          reasoningTokens: tokensUsed.reasoning,
        }).usd ?? 0;
        usedForRelease = {
          maxTokens: usedTokens,
          maxUsd: usedUsd,
        };
        const budgetExceeded = (request.token_budget?.max_tokens !== undefined && usedTokens > request.token_budget.max_tokens) ||
          (request.token_budget?.max_usd !== undefined && usedUsd > request.token_budget.max_usd);
        const budgetBlockers = budgetExceeded ? ["budget exceeded"] : [];
        const blockers = uniqueSorted([...runResult.manifest.blockers, ...validationErrors, ...budgetBlockers]);
        const verdict = blockers.length === 0 ? "passed" : "failed";
        const childVerdict: ChildVerdict = {
          subRunId,
          verdict,
          blockers,
          changedFiles: uniqueSorted(runResult.manifest.changedFiles),
          summary: budgetExceeded ? "Subtask exceeded its token budget." : runResult.message.slice(0, 2_000),
          treatFailureAs: request.treat_failure_as ?? "blocker",
        };
        childVerdicts.push(childVerdict);
        auditPermissionDecision(workspace, permissionContext, "task", {
          subRunId,
          verdict,
          blockers,
          treatFailureAs: childVerdict.treatFailureAs,
        }, {
          decision: verdict === "passed" ? "allow" : "deny",
          reason: "child-verdict",
        }, "engine");
        await options.sink({
          type: "subtask_completed",
          subRunId,
          parentRunId: runId,
          verdict,
          summary: runResult.message.slice(0, 500),
          tokensUsed,
        });
        return {
          ok: verdict === "passed",
          subRunId,
          verdict,
          blockers,
          changedFiles: childVerdict.changedFiles,
          summary: childVerdict.summary,
          tokensUsed,
          childRunIds: [],
          manifest: runResult.manifest,
          runResult,
          treatFailureAs: request.treat_failure_as ?? "blocker",
          ...(budgetExceeded ? { cancelled: true, reason: "budget" } : {}),
        };
      } finally {
        budgetLedger.release(reservation.id, usedForRelease);
      }
    });
  }

  async function syncArtifactOutput(): Promise<string[]> {
    const outputRootValue = options.runContext?.metadata?.artifactOutputRoot;
    if (typeof outputRootValue !== "string" || !outputRootValue.trim()) return [];
    const localOutputRoot = resolve(workspace, ".tania", "artifact-output");
    if (!existsSync(localOutputRoot)) return [];
    const localFiles = await listFilesRecursive(localOutputRoot);
    if (localFiles.length === 0) return [];
    const outputRoot = resolve(outputRootValue);
    const copied: string[] = [];
    for (const relPath of localFiles) {
      const source = resolve(localOutputRoot, relPath);
      const target = resolve(outputRoot, relPath);
      const sourceStat = await stat(source);
      if (!sourceStat.isFile()) continue;
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { force: true, recursive: true });
      copied.push(`artifacts/${relPath}`);
    }
    return uniqueSorted(copied);
  }

  function finalMetrics(manifest: TanyaFinalManifest): FinalMetrics {
    return {
      durationMs: Date.now() - startedAt,
      toolCallCount,
      toolErrorCount,
      changedFileCount: manifest.changedFiles.length,
      repairAttemptCount: repairAttempts.length,
      retryAttemptCount: options.retryAttempt ?? 0,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      reasoningTokens: totalReasoningTokens,
      systemPromptTokens,
      repoMapTokens,
      toolResultTokens: totalToolResultTokens,
    };
  }

  async function finishRun(finalMessage: string, manifest: TanyaFinalManifest): Promise<FinalMetrics> {
    const metrics = finalMetrics(manifest);
    await options.sink({
      type: "final",
      message: finalMessage,
      files: manifest.changedFiles,
      manifest,
      metrics,
    });
    await cleanupMaterializedContext(workspace, manifest, options.runContext);
    logRunSummarySilently({
      workspace,
      runId,
      ...(parentContext?.runId ? { parentRunId: parentContext.runId } : {}),
      prompt: options.prompt,
      provider: activeProvider.id,
      model: activeProvider.model,
      metrics,
      manifest,
    });
    return metrics;
  }

  function pendingToolCallsForRouting(): Array<ToolCall & { preferredModel?: TanyaTool["preferredModel"] }> {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return (lastAssistant?.tool_calls ?? []).map((call) => {
      const preferredModel = registry.get(call.function.name)?.preferredModel;
      return preferredModel ? { ...call, preferredModel } : call;
    });
  }

  function preferredRouteForStep(stepType: StepType): ResolvedRoute | null {
    if (stepType !== "tool_call" && stepType !== "verification") return null;
    const pending = pendingToolCallsForRouting();
    for (const call of pending) {
      const preferred = call.preferredModel;
      if (!preferred) continue;
      if (preferred.match && preferred.match !== stepType) continue;
      if (estimateCompactTokens(messages) > contextWindowForTarget(preferred)) continue;
      return {
        provider: preferred.provider,
        model: preferred.model,
        match: stepType,
        escalate: true,
        source: "session",
        reason: `preferred model for tool ${call.function.name}`,
      };
    }
    return null;
  }

  async function routeProviderForTurn(turn: number): Promise<{
    provider: ChatProvider;
    stepType: StepType;
    route?: ResolvedRoute;
  }> {
    if (!options.routing?.enabled) {
      return { provider: activeProvider, stepType: "unknown" };
    }

    if (forcedNextRoute) {
      const forced = forcedNextRoute;
      forcedNextRoute = null;
      const provider = options.routing.providerFactory(forced.target);
      const key = providerKey(provider);
      const cacheImpact: "hit" | "miss" = key === lastProviderKey ? "hit" : "miss";
      activeProvider = provider;
      lastProviderKey = key;
      const event = {
        type: "model_routed" as const,
        stepType: forced.stepType,
        provider: provider.id,
        model: provider.model,
        reason: forced.reason,
        cacheImpact,
      };
      await options.sink(event);
      auditModelRouted(workspace, permissionContext, event);
      return { provider, stepType: forced.stepType };
    }

    const stepType = classifyStep({ messages, turnIndex: turn, pendingToolCalls: pendingToolCallsForRouting() });
    const route = preferredRouteForStep(stepType) ?? resolveRouteWithContextGuard({
      stepType,
      table: options.routing.table,
      messages,
    });
    const provider = options.routing.providerFactory(route);
    const key = providerKey(provider);
    const cacheImpact: "hit" | "miss" = key === lastProviderKey ? "hit" : "miss";
    activeProvider = provider;
    lastProviderKey = key;
    const event = {
      type: "model_routed" as const,
      stepType,
      provider: provider.id,
      model: provider.model,
      reason: route.reason,
      cacheImpact,
    };
    await options.sink(event);
    auditModelRouted(workspace, permissionContext, event);
    return { provider, stepType, route };
  }

  async function routeFallbackProvider(params: {
    fallback: RouteTarget;
    stepType: StepType;
    reason: string;
  }): Promise<ChatProvider> {
    const provider = options.routing?.providerFactory(params.fallback) ?? activeProvider;
    const key = providerKey(provider);
    const cacheImpact: "hit" | "miss" = key === lastProviderKey ? "hit" : "miss";
    activeProvider = provider;
    lastProviderKey = key;
    const event = {
      type: "model_routed" as const,
      stepType: params.stepType,
      provider: provider.id,
      model: provider.model,
      reason: params.reason,
      cacheImpact,
    };
    await options.sink(event);
    auditModelRouted(workspace, permissionContext, event);
    return provider;
  }

  async function scheduleEscalation(params: {
    from: ChatProvider;
    route?: ResolvedRoute;
    stepType: StepType;
    reason: "parse_failure" | "schema_failure" | "context_too_small";
  }): Promise<boolean> {
    if (!options.routing?.enabled) return false;
    if (params.route?.escalate === false) return false;
    const target = params.route?.fallback ?? options.routing.table.defaults;
    if (`${target.provider}/${target.model}` === `${params.from.id}/${params.from.model}`) return false;
    const cap = escalationCap();
    if (sessionEscalations >= cap) {
      throw new EscalationExhaustedError(`Escalation cap reached (${cap}) for this session.`);
    }
    sessionEscalations += 1;
    const event = {
      type: "escalation_event" as const,
      from: { provider: params.from.id, model: params.from.model },
      to: { provider: target.provider, model: target.model },
      reason: params.reason,
      stepType: params.stepType,
    };
    await options.sink(event);
    auditEscalation(workspace, permissionContext, event);
    forcedNextRoute = {
      target,
      stepType: params.stepType,
      reason: `escalated after ${params.reason}`,
    };
    return true;
  }

  let compactionsThisRun = 0;
  const COMPACTION_LIMIT = 3;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (parentContext && options.signal?.aborted) {
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot,
        changed,
        verificationLines,
        toolErrorCount,
        readArtifactPaths,
        readContextPaths,
        createdArtifactPaths,
        blockers: ["run cancelled"],
        childVerdicts,
        runContext: options.runContext,
        prompt: options.prompt,
        runId,
        verifierShell: options.verifierShell,
      });
      const metrics = await finishRun("Run cancelled.", manifest);
      return { message: "Run cancelled.", manifest, metrics };
    }
    let turnSpendTokens = 0;
    let turnSpendUsd = 0;
    let expandResultCallsThisTurn = 0;
    const compactTokenEstimate = estimateCompactTokens(messages);
    if (compactTokenEstimate >= CONTEXT_TOKEN_LIMIT * 0.85) {
      const compacted = microcompact(messages, {
        tokenBudget: Math.floor(CONTEXT_TOKEN_LIMIT * 0.85),
        foldRatio: 0.2,
      });
      if (compacted.foldedPairs > 0) {
        evictReasoningArchiveForCompaction();
        await appendArchive(runId, toArchivedMessages(compacted.archivedMessages), { workspace });
        messages = compacted.messages;
        fileReadDedup.clear();
        await options.sink({
          type: "compact_event",
          compactType: "micro",
          removedTokens: compacted.removedTokens,
        });
      }
    }

    if (estimateCompactTokens(messages) >= CONTEXT_TOKEN_LIMIT * 0.85) {
      const snipped = snipLowSignal(messages);
      if (snipped.snippedCount > 0) {
        evictReasoningArchiveForCompaction();
        const beforeSnipTokens = estimateCompactTokens(messages);
        await appendArchive(runId, toArchivedMessages(snipped.archivedMessages), { workspace });
        messages = snipped.messages;
        fileReadDedup.clear();
        const afterSnipTokens = estimateCompactTokens(messages);
        await options.sink({
          type: "compact_event",
          compactType: "snip",
          removedTokens: Math.max(0, beforeSnipTokens - afterSnipTokens),
        });
      }
    }

    let routed = await routeProviderForTurn(turn);
    let turnProvider = routed.provider;
    const reasoningCapTokens = reasoningCapForTurn(routed.stepType, routed.route);
    let turnReasoningTokens = 0;
    let reasoningBudgetExceeded = false;

    await options.sink({ type: "message_start" });
    let assistantText = "";
    let assistantReasoningText = "";
    let rawToolCalls: unknown[] = [];
    let schemaFlattenedThisTurn = false;

    const codingProviderOptions = isCodingTask(options.runContext)
      ? { temperature: 0, topP: 0.2 }
      : {};
    // Provider transient retry: if the stream errors before any content or tool
    // call has been emitted (e.g. DeepSeek 'fetch failed' or 'timed out before
    // streaming a response'), retry the same turn once. Once content has been
    // streamed, retry would corrupt the conversation — fall through to the
    // existing repair-loop instead. This eliminates the most common case of
    // losing a whole loop cycle to a 1-second network blip.
    let providerAttempt = 0;
    let contextCompactionsThisTurn = 0;
    let routeFallbackIndex = 0;
    const routeFallbackTargets = [
      routed.route?.fallback,
      options.routing?.table.defaults,
    ].filter((target): target is RouteTarget => Boolean(target));
    const PROVIDER_TRANSIENT_RETRIES = 1;
    streamLoop: while (true) {
      try {
        for await (const delta of turnProvider.streamChat({
          messages,
          tools: registry.list().map((tool) => tool.definition),
          onProviderThrottle: (event) => {
            void Promise.resolve(options.sink({
              type: "provider_throttle",
              provider: event.provider,
              attempt: event.attempt,
              waitMs: event.waitMs,
            })).catch(() => {});
          },
          ...codingProviderOptions,
        })) {
          if (delta.usage) {
            totalPromptTokens += delta.usage.promptTokens;
            totalCompletionTokens += delta.usage.completionTokens;
            totalReasoningTokens += delta.usage.reasoningTokens ?? 0;
            const usageTokens = delta.usage.promptTokens + delta.usage.completionTokens + (delta.usage.reasoningTokens ?? 0);
            const usageUsd = estimateRunCost({
              provider: turnProvider.id,
              model: turnProvider.model,
              promptTokens: delta.usage.promptTokens,
              completionTokens: delta.usage.completionTokens,
              reasoningTokens: delta.usage.reasoningTokens ?? 0,
            }).usd ?? 0;
            turnSpendTokens += usageTokens;
            runSpendTokens += usageTokens;
            sessionSpendTokens += usageTokens;
            turnSpendUsd += usageUsd;
            runSpendUsd += usageUsd;
            sessionSpendUsd += usageUsd;
          }
          if (delta.schemaWarnings) {
            schemaFlattenedThisTurn = true;
            for (const warning of delta.schemaWarnings) {
              await options.sink({
                type: "schema_flatten_warning",
                reason: warning.reason,
                path: warning.path,
                provider: turnProvider.id,
                ...(warning.tool ? { tool: warning.tool } : {}),
              });
            }
          }
          if (delta.content) {
            assistantText += delta.content;
            finalText += delta.content;
            await options.sink({ type: "message_delta", text: delta.content });
          }
          if (delta.reasoningContent) {
            assistantReasoningText += delta.reasoningContent;
            const tokens = delta.usage?.reasoningTokens ?? Math.ceil(delta.reasoningContent.length / 4);
            if (delta.usage?.reasoningTokens === undefined) totalReasoningTokens += tokens;
            turnReasoningTokens += tokens;
            await appendReasoningChunk({
              workspace,
              runId,
              turn,
              provider: turnProvider.id,
              model: turnProvider.model,
              content: delta.reasoningContent,
              tokens,
            });
            if (!reasoningBudgetExceeded && turnReasoningTokens > reasoningCapTokens) {
              reasoningBudgetExceeded = true;
              await options.sink({
                type: "reasoning_truncated",
                provider: turnProvider.id,
                model: turnProvider.model,
                usedTokens: turnReasoningTokens,
                capTokens: reasoningCapTokens,
                stepType: routed.stepType,
              });
            }
            await options.sink({
              type: "reasoning_chunk",
              content: delta.reasoningContent,
              provider: turnProvider.id,
              model: turnProvider.model,
              runId,
              turn,
              tokens,
            });
          }
          if (delta.toolCalls?.length) rawToolCalls = delta.toolCalls;
        }
        break; // stream completed normally
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const noProgressYet = assistantText.length === 0 && assistantReasoningText.length === 0 && rawToolCalls.length === 0;
        if (isContextWindowExceededError(err)) {
          if (!noProgressYet || contextCompactionsThisTurn >= 2 || compactionsThisRun >= COMPACTION_LIMIT) {
            if (noProgressYet) {
              const escalated = await scheduleEscalation({
                from: turnProvider,
                ...(routed.route ? { route: routed.route } : {}),
                stepType: routed.stepType,
                reason: "context_too_small",
              });
              if (escalated && forcedNextRoute) {
                const forced = forcedNextRoute;
                forcedNextRoute = null;
                turnProvider = await routeFallbackProvider({
                  fallback: forced.target,
                  stepType: forced.stepType,
                  reason: forced.reason,
                });
                contextCompactionsThisTurn = 0;
                continue streamLoop;
              }
            }
            throw new CompactionExhaustedError(`Context compaction exhausted after ${compactionsThisRun} compaction(s): ${message}`);
          }

          const micro = microcompact(messages, {
            tokenBudget: Math.floor(CONTEXT_TOKEN_LIMIT * 0.85),
            foldRatio: 0.2,
          });
          if (micro.foldedPairs > 0) {
            evictReasoningArchiveForCompaction();
            await appendArchive(runId, toArchivedMessages(micro.archivedMessages), { workspace });
            messages = micro.messages;
            fileReadDedup.clear();
            await options.sink({
              type: "compact_event",
              compactType: "micro",
              removedTokens: micro.removedTokens,
            });
          }

          const beforeSnipTokens = estimateCompactTokens(messages);
          const snipped = snipLowSignal(messages);
          if (snipped.snippedCount > 0) {
            evictReasoningArchiveForCompaction();
            await appendArchive(runId, toArchivedMessages(snipped.archivedMessages), { workspace });
            messages = snipped.messages;
            fileReadDedup.clear();
            await options.sink({
              type: "compact_event",
              compactType: "snip",
              removedTokens: Math.max(0, beforeSnipTokens - estimateCompactTokens(messages)),
            });
          }

          const aggression: CompactionAggression = contextCompactionsThisTurn === 0 ? "normal" : "heavy";
          const compacted = await autoCompact(messages, {
            provider: turnProvider,
            model: turnProvider.model,
            aggression,
            archive: { workspace, runId },
          });
          evictReasoningArchiveForCompaction();
          messages = compacted.messages;
          fileReadDedup.clear();
          compactionsThisRun += 1;
          contextCompactionsThisTurn += 1;
          await options.sink({
            type: "compact_event",
            compactType: "auto",
            removedTokens: compacted.removedTokens,
            summaryTokens: compacted.summaryTokens,
            aggression,
          });
          continue;
        }
        const isTransient = /timed out|fetch failed|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message);
        if (isTransient && noProgressYet && providerAttempt < PROVIDER_TRANSIENT_RETRIES) {
          providerAttempt += 1;
          await options.sink({ type: "status", message: `Provider transient error (${message.slice(0, 120)}); retrying same turn (${providerAttempt}/${PROVIDER_TRANSIENT_RETRIES}).` });
          continue;
        }
        if (options.routing?.enabled && noProgressYet) {
          while (routeFallbackIndex < routeFallbackTargets.length) {
            const fallback = routeFallbackTargets[routeFallbackIndex];
            routeFallbackIndex += 1;
            if (!fallback || `${fallback.provider}/${fallback.model}` === `${turnProvider.id}/${turnProvider.model}`) continue;
            turnProvider = await routeFallbackProvider({
              fallback,
              stepType: routed.stepType,
              reason: `fallback after provider error: ${message.slice(0, 120)}`,
            });
            routed = { provider: turnProvider, stepType: routed.stepType };
            providerAttempt = 0;
            continue streamLoop;
          }
        }
        throw err;
      }
    }

    await options.sink({ type: "message_end" });

    const assistantHistoryMessage = (toolCalls: ToolCall[] = []): ChatMessage => {
      const message: ChatMessage = {
        role: "assistant",
        content: assistantText || null,
      };
      if (assistantReasoningText.length > 0 && turnProvider.roundTripReasoning === true) {
        message.reasoning_content = assistantReasoningText;
      }
      if (toolCalls.length) message.tool_calls = toolCalls;
      return message;
    };

    if (reasoningBudgetExceeded && turn < maxTurns - 1) {
      messages.push(assistantHistoryMessage());
      messages.push({
        role: "user",
        content: "[your reasoning budget for this turn is exhausted. Give your final answer now.]",
      });
      continue;
    }

    const parsedToolCalls = rawToolCalls.length > 0
      ? parseProviderToolCalls(rawToolCalls, { turn })
      : { toolCalls: [] as ToolCall[], warnings: [], failures: [] };
    for (const warning of parsedToolCalls.warnings) {
      await options.sink({
        type: "tool_call_parse_warning",
        reason: warning.reason,
        provider: turnProvider.id,
        turn,
        attempt: toolCallCorrectionAttempts,
        ...(warning.toolCallId ? { toolCallId: warning.toolCallId } : {}),
        ...(warning.tool ? { tool: warning.tool } : {}),
      });
    }
    for (const failure of parsedToolCalls.failures) {
      await options.sink({
        type: "tool_call_parse_warning",
        reason: failure.reason,
        provider: turnProvider.id,
        turn,
        attempt: toolCallCorrectionAttempts + 1,
        toolCallId: failure.toolCall.id,
        tool: failure.toolCall.function.name,
      });
    }

    if (
      parsedToolCalls.failures.length > 0 &&
      !parseEscalationUsed &&
      toolCallCorrectionAttempts + 1 >= TOOL_CALL_CORRECTION_LIMIT &&
      turn < maxTurns - 1
    ) {
      const escalated = await scheduleEscalation({
        from: turnProvider,
        ...(routed.route ? { route: routed.route } : {}),
        stepType: routed.stepType,
        reason: schemaFlattenedThisTurn ? "schema_failure" : "parse_failure",
      });
      if (escalated) {
        parseEscalationUsed = true;
        toolCallCorrectionAttempts += 1;
        messages.push(assistantHistoryMessage());
        messages.push({
          role: "user",
          content: malformedToolCallCorrectionMessage(parsedToolCalls.failures.map((failure) => failure.reason).join("; ")),
        });
        continue;
      }
    }

    if (parsedToolCalls.failures.length > 0 && toolCallCorrectionAttempts < TOOL_CALL_CORRECTION_LIMIT && turn < maxTurns - 1) {
      toolCallCorrectionAttempts += 1;
      messages.push(assistantHistoryMessage());
      messages.push({
        role: "user",
        content: malformedToolCallCorrectionMessage(parsedToolCalls.failures.map((failure) => failure.reason).join("; ")),
      });
      continue;
    }

    if (parsedToolCalls.failures.length > 0) {
      const failedToolCalls = parsedToolCalls.failures.map((failure) => failure.toolCall);
      toolErrorCount += failedToolCalls.length;
      messages.push(assistantHistoryMessage(failedToolCalls));
      for (const failure of parsedToolCalls.failures) {
        const error = `malformed tool call after ${TOOL_CALL_CORRECTION_LIMIT} correction attempts: ${failure.reason}`;
        messages.push({ role: "tool", tool_call_id: failure.toolCall.id, content: JSON.stringify({ ok: false, error }) });
        await options.sink({
          type: "tool_result",
          id: failure.toolCall.id,
          tool: failure.toolCall.function.name,
          ok: false,
          summary: "Malformed tool call after correction attempts.",
          error,
        });
      }
      continue;
    }

    const toolCalls = parsedToolCalls.toolCalls;
    if (toolCalls.length > 0) {
      toolCallCorrectionAttempts = 0;
      parseEscalationUsed = false;
    }

    messages.push(assistantHistoryMessage(toolCalls));

    if (
      toolCalls.length === 0 &&
      isCodingTask(options.runContext) &&
      !hasRequiredCodingReport(assistantText || finalText)
    ) {
      consecutiveNoToolNoReportTurns += 1;
      if (!requestedFinalReport && consecutiveNoToolNoReportTurns < MAX_NO_TOOL_NO_REPORT_TURNS && turn < maxTurns - 1) {
        requestedFinalReport = true;
        messages.push({
          role: "user",
          content: buildFinalReportReminder(changed, toolErrorCount),
        });
        continue;
      }
    } else {
      consecutiveNoToolNoReportTurns = 0;
    }

    if (toolCalls.length === 0) {
      createdArtifactPaths = uniqueSorted([...createdArtifactPaths, ...await syncArtifactOutput()]);
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot,
        changed,
        verificationLines,
        toolErrorCount,
        readArtifactPaths,
        readContextPaths,
        createdArtifactPaths,
        blockers: failedVerificationBlockers(verificationLines, assistantText || finalText),
        childVerdicts,
        runContext: options.runContext,
        prompt: options.prompt,
        runId,
        verifierShell: options.verifierShell,
      });
      if (
        isCodingTask(options.runContext) &&
        !requestedCommitRepair &&
        commitStillRequired(manifest, beforeGitSnapshot, options.runContext) &&
        turn < maxTurns - 1
      ) {
        requestedCommitRepair = true;
        messages.push({
          role: "user",
          content: buildCommitRequiredReminder(manifest),
        });
        continue;
      }
      if (
        isCodingTask(options.runContext) &&
        ((manifest.validation && !manifest.validation.passed) || manifest.blockers.length > 0) &&
        validationRepairAttempts < maxRepairAttempts &&
        !seenValidationRepairSignatures.has(validationRepairSignature(manifest)) &&
        turn < maxTurns - 1
      ) {
        validationRepairAttempts += 1;
        const signature = validationRepairSignature(manifest);
        lastValidationRepairSignature = signature;
        seenValidationRepairSignatures.add(signature);
        repairAttempts.push(repairAttemptSnapshot(validationRepairAttempts, manifest));
        messages = pruneStaleRepairReminders(messages);
        messages.push({
          role: "user",
          content: buildValidationRepairReminder(manifest, validationRepairAttempts, maxRepairAttempts),
        });
        continue;
      }
      const finalMessage = isCodingTask(options.runContext)
        ? ensureCodingReport(assistantText || finalText || "Done.", manifest, options.runContext)
        : assistantText || finalText || "Done.";
      await recordGoldenTaskMemory(workspace, manifest, options.runContext);
      await appendTaskHistorySilently(workspace, options.prompt, manifest, options.runContext);
      await appendObsidianTaskIfConfigured(manifest, options.runContext);
      await recordRepairRunMemorySilently(options.runContext, repairAttempts, manifest);
      const metrics = await finishRun(finalMessage, manifest);
      return { message: finalMessage, manifest, metrics };
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const tool = registry.get(toolName);
      const parsedInput = parseToolArguments(toolCall.function.arguments);
      if (!parsedInput.ok) {
        toolErrorCount += 1;
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            ok: false,
            error: parsedInput.reason,
            rawArguments: parsedInput.rawArguments,
          }),
        });
        await options.sink({
          type: "tool_result",
          id: toolCall.id,
          tool: toolName,
          ok: false,
          summary: "Invalid tool arguments (malformed JSON).",
          output: `raw arguments (preview): ${parsedInput.rawArguments}`,
          error: parsedInput.reason,
        });
        continue;
      }
      const callInput = parsedInput.input;
      toolCallCount += 1;
      await options.sink({ type: "tool_call", id: toolCall.id, tool: toolName, input: callInput });

      if (!tool) {
        const error = toolName.startsWith("mcp:")
          ? `MCP tool is not configured or allowlisted: ${toolName}`
          : `Unknown tool: ${toolName}`;
        toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: error, error });
        continue;
      }

      const validationError = validateToolInput(callInput, tool.definition as {
        function: { parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } };
      });
      if (validationError) {
        toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: validationError }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: validationError, error: validationError });
        continue;
      }

      if (requiredTool && !requiredToolUsed && toolCallMayMutate(toolName, callInput) && toolName !== requiredTool) {
        const error = `This task must use ${requiredTool} before manual file mutation. Read context/artifacts first if needed, then call ${requiredTool}.`;
        toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, summary: "Required high-level tool not used.", error }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: "Required high-level tool not used.", error });
        continue;
      }

      const projectedSpend = projectedToolSpend(callInput, turnProvider);
      permissionContext.spendState = {
        turnTokens: turnSpendTokens,
        runTokens: runSpendTokens,
        sessionTokens: sessionSpendTokens,
        projectedTokens: projectedSpend.projectedTokens,
        turnUsd: turnSpendUsd,
        runUsd: runSpendUsd,
        sessionUsd: sessionSpendUsd,
        projectedUsd: projectedSpend.projectedUsd,
      };
      const permissionDecision: Decision = tool.canRun
        ? await tool.canRun(callInput, permissionContext)
        : permissionContext.mode === "bypass"
          ? { decision: "allow", reason: "bypass-mode" }
          : decide(toolName, callInput, permissionContext);
      let finalPermissionDecision: Decision = permissionDecision;
      let finalPermissionSource: "user" | "rule" | "engine" | "bypass" = permissionEventSource(permissionDecision, permissionContext.mode);
      if (permissionContext.mode !== "bypass") {
        if (permissionDecision.decision === "ask") {
          const permissionKey = permissionCacheKey(toolName, callInput);
          let cached = permissionAnswers.get(permissionKey);
          if (!cached) {
            await options.sink({ type: "permission_request", ...permissionRequestFromDecision(toolCall.id, toolName, callInput, permissionDecision) });
            const answer = options.onPermissionRequest
              ? await options.onPermissionRequest(permissionRequestFromDecision(toolCall.id, toolName, callInput, permissionDecision))
              : { decision: "deny" as const };
            cached = { answer, source: options.onPermissionRequest ? "user" : "engine" };
            permissionAnswers.set(permissionKey, cached);
          }
          finalPermissionDecision = {
            ...permissionDecision,
            decision: cached.answer.decision,
            reason: cached.answer.decision === "allow" ? "user-approved" : (permissionDecision.reason ?? "permission-denied"),
          };
          finalPermissionSource = cached.source;
          await options.sink({
            type: "permission_decision",
            id: toolCall.id,
            decision: cached.answer.decision,
            source: cached.source,
            ...(cached.answer.persistAs ? { persistAs: cached.answer.persistAs } : {}),
            ...(permissionDecision.matchedRule ? { matchedRule: permissionDecision.matchedRule } : {}),
            ...(permissionDecision.projectedCostUsd !== undefined ? { projectedCostUsd: permissionDecision.projectedCostUsd } : {}),
            ...(permissionDecision.projectedTokens !== undefined ? { projectedTokens: permissionDecision.projectedTokens } : {}),
            ...(permissionDecision.thresholdUsd !== undefined ? { thresholdUsd: permissionDecision.thresholdUsd } : {}),
            ...(permissionDecision.thresholdTokens !== undefined ? { thresholdTokens: permissionDecision.thresholdTokens } : {}),
          });
        } else {
          await options.sink({
            type: "permission_decision",
            id: toolCall.id,
            decision: permissionDecision.decision,
            source: permissionEventSource(permissionDecision, permissionContext.mode),
            ...(permissionDecision.matchedRule ? { matchedRule: permissionDecision.matchedRule } : {}),
            ...(permissionDecision.projectedCostUsd !== undefined ? { projectedCostUsd: permissionDecision.projectedCostUsd } : {}),
            ...(permissionDecision.projectedTokens !== undefined ? { projectedTokens: permissionDecision.projectedTokens } : {}),
            ...(permissionDecision.thresholdUsd !== undefined ? { thresholdUsd: permissionDecision.thresholdUsd } : {}),
            ...(permissionDecision.thresholdTokens !== undefined ? { thresholdTokens: permissionDecision.thresholdTokens } : {}),
          });
        }
      }
      auditPermissionDecision(workspace, permissionContext, toolName, callInput, finalPermissionDecision, finalPermissionSource);
      if (finalPermissionDecision.decision !== "allow") {
        const result = deniedPermissionResult(
          finalPermissionDecision,
          permissionDecision.decision === "ask" ? "permission approval required" : "permission denied",
        );
        toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result.output) });
        await options.sink({
          type: "tool_result",
          id: toolCall.id,
          tool: toolName,
          ok: false,
          summary: result.summary,
          output: result.output,
          error: result.error,
        });
        continue;
      }

      let removeToolAbortListener: (() => void) | undefined;
      try {
        const label = commandLabel(toolName, callInput);
        const key = label ? verificationKey(label) : null;
        const outsideReadMessage = outsideWorkspaceReadMessage(workspace, toolName, callInput);
        let duplicateVerification = key ? passedVerificationKeys.get(key) === mutationRevision : false;
        const dedupedReadResult = !outsideReadMessage && toolName === "read_file"
          ? await fileReadDedup.lookup(callInput)
          : null;
        let spiralResult: ToolResult | null = null;
        if (!outsideReadMessage && toolName === "run_shell") {
          const spiralKey = shellCommandSpiralKey(callInput);
          if (spiralKey && shouldApplyShellSpiralDetector(spiralKey)) {
            const previousExecutions = shellCommandSpiralCounts.get(spiralKey) ?? 0;
            if (previousExecutions >= 5) {
              duplicateVerification = false;
              const advisory = `Detected repeated verification of ${spiralKey} — embed result in prompt or move on. Skipping further attempts.`;
              if (!shellCommandSpiralAdvisorySent) {
                shellCommandSpiralAdvisorySent = true;
                await options.sink({ type: "status", message: advisory });
              }
              spiralResult = {
                ok: true,
                summary: "Skipped repeated shell command: verification spiral detected.",
                output: `skipped: spiral detected\n${advisory}`,
              };
            } else {
              shellCommandSpiralCounts.set(spiralKey, previousExecutions + 1);
              duplicateVerification = false;
            }
          }
        }
        if (toolName === "expand_result" && expandResultCallsThisTurn >= EXPAND_RESULT_LIMIT_PER_TURN) {
          const result = {
            ok: false,
            summary: "expand_result limit reached for this turn.",
            error: `Only ${EXPAND_RESULT_LIMIT_PER_TURN} expand_result calls are allowed per turn.`,
            output: { ok: false, error: "expand_result limit reached for this turn" },
          } satisfies ToolResult;
          toolErrorCount += 1;
          messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
          await options.sink({
            type: "tool_result",
            id: toolCall.id,
            tool: toolName,
            ok: false,
            summary: result.summary,
            output: result.output,
            error: result.error,
          });
          continue;
        }
        const runRegisteredTool = () => {
          const toolAbortController = new AbortController();
          let cancelRequested = false;
          const requestToolCancellation = () => {
            if (cancelRequested) return;
            cancelRequested = true;
            void Promise.resolve(options.sink({
              type: "tool_cancel_requested",
              toolCallId: toolCall.id,
              tool: toolName,
              timestamp: new Date().toISOString(),
            })).catch(() => {});
            toolAbortController.abort(options.signal?.reason);
          };
          if (options.signal?.aborted) {
            requestToolCancellation();
          } else if (options.signal) {
            options.signal.addEventListener("abort", requestToolCancellation, { once: true });
            removeToolAbortListener = () => options.signal?.removeEventListener("abort", requestToolCancellation);
          }
          return registry.run(tool, callInput, { workspace, runId, runSubAgent: runSubAgentTask }, {
            signal: toolAbortController.signal,
            onProgress: (progress) => {
              void Promise.resolve(options.sink({
                type: "tool_progress",
                toolCallId: toolCall.id,
                chunk: progress.chunk,
                timestamp: progress.timestamp,
                stream: progress.stream,
              })).catch(() => {});
            },
          });
        };
        const rawResult = outsideReadMessage
          ? {
              ok: true,
              summary: outsideReadMessage,
              output: outsideReadMessage,
            }
          : duplicateVerification
            ? {
              ok: true,
              summary: "Skipped duplicate verification; the previous matching command already exited 0 and is authoritative.",
              output: "Already verified in this run. Do not call this verification again; produce the final report now.",
            }
            : spiralResult
              ? spiralResult
              : dedupedReadResult
                ? dedupedReadResult
                : await runRegisteredTool();
        const result = withRunnerRepairHints(toolName, rawResult);
        if (toolName === "expand_result" && result.ok) expandResultCallsThisTurn += 1;
        if (duplicateVerification && key) {
          skippedDuplicateKeys.set(key, (skippedDuplicateKeys.get(key) ?? 0) + 1);
        }
        if (toolName === "edit_block" && result.ok) {
          auditEditBlockCandidate(workspace, permissionContext, callInput, result);
        }
        if (result.ok) {
          changed = collectChangedFiles(changed, result.files);
          if (toolName === requiredTool) requiredToolUsed = true;
        }
        if (looksLikeNetworkOrDependencyFailure(toolName, callInput, result)) {
          consecutiveNetworkFailures += 1;
          if (consecutiveNetworkFailures >= 2 && !networkFallbackReminderSent) {
            networkFallbackReminderPending = true;
          }
        } else if (result.ok && toolName !== "read_file" && toolName !== "list_files" && toolName !== "search") {
          consecutiveNetworkFailures = 0;
        }
        if (toolName === "read_file" && result.ok && !dedupedReadResult && !outsideReadMessage) {
          await fileReadDedup.remember(callInput, toolCall.id, turn);
        }
        if (toolResultMutatedFiles(toolName, result)) {
          mutationRevision += 1;
          fileReadDedup.clear();
        }
        const artifactPath = artifactPathFromRead(toolName, callInput);
        if (artifactPath && result.ok) readArtifactPaths = uniqueSorted([...readArtifactPaths, artifactPath]);
        const contextPath = contextPathFromRead(toolName, callInput, options.runContext);
        if (contextPath && result.ok) readContextPaths = uniqueSorted([...readContextPaths, contextPath]);
        if (label) {
          const line = `Verification: ${label} -> ${result.ok ? "passed" : "failed"} (${result.summary})`;
          const existingIndex = verificationLines.findIndex((existing) => existing.includes(label));
          if (existingIndex === -1) {
            verificationLines.push(line);
          } else if (result.ok && /->\s*failed\b/i.test(verificationLines[existingIndex] ?? "")) {
            verificationLines[existingIndex] = line;
          }
        }
        if (key && result.ok) passedVerificationKeys.set(key, mutationRevision);
        if (!result.ok) toolErrorCount += 1;
        if (result.cancelled) {
          const cancelledEvent = {
            type: "tool_cancelled",
            toolCallId: toolCall.id,
            tool: toolName,
            timestamp: new Date().toISOString(),
          } as const;
          await options.sink(result.partial_output !== undefined
            ? { ...cancelledEvent, partialOutput: result.partial_output }
            : cancelledEvent);
        }
        const rendered = truncateToolResultForModel({
          tool,
          result,
          workspace,
          runId,
          toolCallId: toolCall.id,
          expandCallsRemaining: EXPAND_RESULT_LIMIT_PER_TURN - expandResultCallsThisTurn,
        });
        totalToolResultTokens += Math.ceil(JSON.stringify(rendered.modelResult).length / 4);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(rendered.modelResult) });
        const reason = toolResultReason(result);
        const event = {
          type: "tool_result",
          id: toolCall.id,
          tool: toolName,
          ok: result.ok,
          summary: rendered.modelResult.summary,
          output: rendered.modelResult.output,
          ...(reason ? { reason } : {}),
          ...(rendered.truncated ? { modelView: rendered.modelResult, verifierView: result } : {}),
        } as const;
        await options.sink(result.error ? { ...event, error: result.error } : event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: message }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: message, error: message });
      } finally {
        removeToolAbortListener?.();
      }
    }

    if (networkFallbackReminderPending && !networkFallbackReminderSent && turn < maxTurns - 1) {
      networkFallbackReminderPending = false;
      networkFallbackReminderSent = true;
      messages.push({ role: "user", content: buildNetworkFallbackReminder() });
      continue;
    }

    const repeatedDuplicateSkips = [...skippedDuplicateKeys.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    if (isCodingTask(options.runContext) && repeatedDuplicateSkips >= 1) {
      createdArtifactPaths = uniqueSorted([...createdArtifactPaths, ...await syncArtifactOutput()]);
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot,
        changed,
        verificationLines,
        toolErrorCount,
        readArtifactPaths,
        readContextPaths,
        createdArtifactPaths,
        blockers: failedVerificationBlockers(verificationLines, finalText),
        childVerdicts,
        runContext: options.runContext,
        prompt: options.prompt,
        runId,
        verifierShell: options.verifierShell,
      });
      if (!requestedCommitRepair && commitStillRequired(manifest, beforeGitSnapshot, options.runContext)) {
        requestedCommitRepair = true;
        skippedDuplicateKeys.clear();
        messages.push({
          role: "user",
          content: buildCommitRequiredReminder(manifest),
        });
        continue;
      }
      const finalMessage = [
        "Finalized after repeated duplicate verification requests.",
        "",
        buildFallbackCodingReport(manifest.changedFiles, verificationLines, toolErrorCount, readArtifactPaths, createdArtifactPaths, options.runContext, manifest.blockers, finalText),
      ].join("\n");
      const finalMessageWithFooter = ensureCodingReport(finalMessage, manifest, options.runContext);
      await recordGoldenTaskMemory(workspace, manifest, options.runContext);
      await appendTaskHistorySilently(workspace, options.prompt, manifest, options.runContext);
      await appendObsidianTaskIfConfigured(manifest, options.runContext);
      await recordRepairRunMemorySilently(options.runContext, repairAttempts, manifest);
      const metrics = await finishRun(finalMessageWithFooter, manifest);
      return { message: finalMessageWithFooter, manifest, metrics };
    }
  }

  const message = `Stopped after reaching the tool-turn limit. (Max dialog turn budget = ${maxTurns}; the agent did not produce a final coding report and may have stalled in a tool-call loop. Inspect the verification log and rerun with --retries if appropriate.)`;
  createdArtifactPaths = uniqueSorted([...createdArtifactPaths, ...await syncArtifactOutput()]);
  const manifest = await buildFinalManifest({
    workspace,
    beforeGitSnapshot,
    changed,
    verificationLines,
    toolErrorCount,
    readArtifactPaths,
    readContextPaths,
    createdArtifactPaths,
    blockers: [
      "tool-turn limit reached before final completion",
      ...failedVerificationBlockers(verificationLines, finalText),
    ],
    childVerdicts,
    runContext: options.runContext,
    prompt: options.prompt,
    terminationReason: "turn_budget_exhausted",
    runId,
    verifierShell: options.verifierShell,
  });
  const fallbackReport = isCodingTask(options.runContext)
    ? buildFallbackCodingReport(manifest.changedFiles, verificationLines, toolErrorCount, readArtifactPaths, createdArtifactPaths, options.runContext, manifest.blockers, finalText)
    : "";
  const finalMessage = isCodingTask(options.runContext)
    ? [
        message,
        "",
        fallbackReport,
      ].join("\n")
    : message;
  const finalMessageWithFooter = isCodingTask(options.runContext)
    ? ensureCodingReport(finalMessage, manifest, options.runContext)
    : finalMessage;
  await recordGoldenTaskMemory(workspace, manifest, options.runContext);
  await appendTaskHistorySilently(workspace, options.prompt, manifest, options.runContext);
  await appendObsidianTaskIfConfigured(manifest, options.runContext);
  await recordRepairRunMemorySilently(options.runContext, repairAttempts, manifest);
  const metrics = await finishRun(finalMessageWithFooter, manifest);
  return { message: finalMessageWithFooter, manifest, metrics };
}
