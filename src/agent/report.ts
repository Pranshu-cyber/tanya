import type { TanyaRunContext } from "../context/runContext";
import type { TanyaFinalManifest } from "./runner";
import type { ChildVerdict, ReasoningAnnotation } from "./verifier/types";
import { verifyFinalState, type VerifierShell } from "./verifier";
import { envValue } from "../config/envCompat";
import { fileTouchPathsFromArchive, readArchive } from "../memory/runArchive";
import { readReasoningArchive } from "../memory/reasoningArchive";
import { validateCodingTask, type ValidationSummary } from "./validators";
import {
  captureGitSnapshot,
  changedFilesFromGit,
  committedFilesFromGit,
  type GitSnapshot,
  isIgnoredReportPath,
  listFilesRecursive,
  normalizeReportFiles,
  normalizeReportPathsForWorkspace,
  pathIsGitTracked,
  runContextRequiresCommit,
  uncommittedFilesSince,
  uniqueSorted,
} from "./git";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function collectChangedFiles(existing: string[], next?: string[]): string[] {
  return [...new Set([...existing, ...(next ?? [])].filter((file) => !isIgnoredReportPath(file)))];
}

async function cleanupGeneratedNoise(workspace: string): Promise<void> {
  const generatedFastlanePaths = [
    "fastlane/README.md",
    "fastlane/report.xml",
    "fastlane/test_output",
  ];
  try {
    const entries = await readdir(workspace, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^DerivedData(?:[-_].*)?$/i.test(entry.name)) {
        generatedFastlanePaths.push(entry.name);
      }
      if (entry.isDirectory() && /\.xcresult$/i.test(entry.name)) {
        generatedFastlanePaths.push(entry.name);
      }
    }
  } catch {
    // Ignore cleanup discovery failures.
  }
  try {
    for (const relPath of await listFilesRecursive(workspace)) {
      if (/\.(?:orig|bak|backup|tmp)$/i.test(relPath)) generatedFastlanePaths.push(relPath);
    }
  } catch {
    // Ignore recursive cleanup discovery failures.
  }
  for (const relPath of generatedFastlanePaths) {
    const absPath = resolve(workspace, relPath);
    if (!existsSync(absPath)) continue;
    if (await pathIsGitTracked(workspace, relPath)) continue;
    try {
      await rm(absPath, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort. The final manifest/report still filters generated noise.
    }
  }
}

async function fileReportPathIsNotDirectory(workspace: string, filePath: string): Promise<boolean> {
  try {
    return !(await stat(resolve(workspace, filePath))).isDirectory();
  } catch {
    return true;
  }
}

async function normalizeReportFileList(workspace: string, files: string[]): Promise<string[]> {
  const normalized = normalizeReportFiles(files);
  const keep = await Promise.all(normalized.map(async (filePath) => ({
    filePath,
    keep: await fileReportPathIsNotDirectory(workspace, filePath),
  })));
  return keep.filter((entry) => entry.keep).map((entry) => entry.filePath);
}

export function isCodingTask(runContext?: TanyaRunContext): boolean {
  return runContext?.task?.kind === "coding" || Boolean(runContext?.expected_report);
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function verifierReasoningAnnotationsEnabled(runContext?: TanyaRunContext): boolean {
  return truthy(runContext?.metadata?.verboseVerifier) ||
    truthy(runContext?.metadata?.includeReasoningInVerifier) ||
    truthy(envValue(process.env, "TANYA_VERIFIER_INCLUDE_REASONING"));
}

function excerptReasoning(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 280);
}

function buildReasoningAnnotations(params: {
  workspace: string;
  runId?: string;
  blockers: string[];
  runContext?: TanyaRunContext;
}): ReasoningAnnotation[] {
  if (!params.runId || !verifierReasoningAnnotationsEnabled(params.runContext)) return [];
  const entries = readReasoningArchive(params.workspace, params.runId)
    .filter((entry) => !entry.evicted && entry.content.trim().length > 0)
    .slice(-3);
  if (entries.length === 0) return [];
  return entries.map((entry, index) => ({
    runId: entry.runId,
    ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
    provider: entry.provider,
    model: entry.model,
    ...(params.blockers[index] ? { blocker: params.blockers[index] } : {}),
    excerpt: excerptReasoning(entry.content),
    confidence: "advisory",
  }));
}

export function hasRequiredCodingReport(text: string): boolean {
  return /Verification:\s*.+->/i.test(text)
    && (/Modified:\s*/i.test(text) || /Verification-only:\s*existing setup satisfied/i.test(text) || /Blocked?:/i.test(text));
}

function sourceArtifactPath(localPath: string, runContext?: TanyaRunContext): string {
  const match = runContext?.artifacts?.find((artifact) => artifact.path === localPath || artifact.sourcePath === localPath);
  if (match?.sourcePath) return match.sourcePath;
  if (localPath.startsWith(".tanya/artifacts/")) return localPath.replace(/^\.tanya\/artifacts\//, "artifacts/");
  return localPath;
}

export function buildFallbackCodingReport(
  changedFiles: string[],
  verificationLines: string[],
  toolErrorCount: number,
  artifactPaths: string[],
  createdArtifactPaths: string[],
  runContext?: TanyaRunContext,
  blockers: string[] = [],
  finalText = "",
): string {
  const artifactLines = buildArtifactReportLines(
    { artifactsRead: artifactPaths.slice(0, 5), changedFiles },
    runContext,
    finalText,
  );
  const artifactCreatedLines = createdArtifactPaths.length > 0
    ? createdArtifactPaths.map((artifactPath) => `Artifact created: ${artifactPath} -> reusable artifact`)
    : ["Artifact created: none"];
  return [
    ...artifactLines,
    ...artifactCreatedLines,
    changedFiles.length === 0
      ? "Verification-only: existing setup satisfied"
      : changedFiles.map((filePath) => `Modified: ${filePath}`).join("\n"),
    verificationLines.length > 0
      ? verificationLines.join("\n")
      : "Verification: not completed -> blocked before verification command was captured",
    toolErrorCount > 0
      ? `Tool errors observed: ${toolErrorCount}`
      : "Tool errors observed: 0",
    blockers.length > 0 ? `Blocked: ${blockers.join("; ")}` : "Blocked: none",
  ].join("\n");
}

export async function buildFinalManifest(params: {
  workspace: string;
  beforeGitSnapshot: GitSnapshot | null;
  changed: string[];
  verificationLines: string[];
  toolErrorCount: number;
  readArtifactPaths: string[];
  readContextPaths: string[];
  createdArtifactPaths: string[];
  blockers?: string[];
  childVerdicts?: ChildVerdict[];
  runContext?: TanyaRunContext | undefined;
  prompt?: string;
  runId?: string;
  verifierShell?: VerifierShell | undefined;
  terminationReason?: "turn_budget_exhausted" | string | undefined;
}): Promise<TanyaFinalManifest> {
  await cleanupGeneratedNoise(params.workspace);
  const afterGitSnapshot = await captureGitSnapshot(params.workspace);
  const committedFiles = await committedFilesFromGit(params.beforeGitSnapshot, afterGitSnapshot, params.workspace);
  const uncommittedFiles = uncommittedFilesSince(params.beforeGitSnapshot, afterGitSnapshot, params.workspace);
  const liveChangedFiles = normalizeReportPathsForWorkspace(
    collectChangedFiles(params.changed, await changedFilesFromGit(params.beforeGitSnapshot, params.workspace)),
    afterGitSnapshot,
    params.workspace,
  );
  const reportSourceFiles = (committedFiles.length > 0 || uncommittedFiles.length > 0)
    ? uniqueSorted([...committedFiles, ...uncommittedFiles])
    : liveChangedFiles;
  const reportFiles = await normalizeReportFileList(params.workspace, reportSourceFiles);
  const childVerdicts = (params.childVerdicts ?? []).filter((verdict) => verdict.treatFailureAs !== "ignore");
  const childBlockers = childVerdicts
    .filter((verdict) => verdict.verdict === "failed" && verdict.treatFailureAs === "blocker")
    .map((verdict) => childVerdictMessage(verdict));
  const childWarnings = childVerdicts
    .filter((verdict) => verdict.verdict === "failed" && verdict.treatFailureAs === "warning")
    .map((verdict) => childVerdictMessage(verdict));
  const blockers = uniqueSorted([...(params.blockers ?? []), ...childBlockers]);
  const reasoningAnnotations = buildReasoningAnnotations({
    workspace: params.workspace,
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    blockers,
    ...(params.runContext !== undefined ? { runContext: params.runContext } : {}),
  });
  const manifest: TanyaFinalManifest = {
    schemaVersion: 1,
    changedFiles: reportFiles,
    uncommittedFiles: await normalizeReportFileList(params.workspace, uncommittedFiles),
    artifactsRead: uniqueSorted(params.readArtifactPaths.map((artifactPath) => sourceArtifactPath(artifactPath, params.runContext))),
    artifactsCreated: uniqueSorted(params.createdArtifactPaths),
    contextFilesRead: uniqueSorted(params.readContextPaths),
    verification: params.verificationLines.filter((line) => !isRecoveredVerificationFailure(line, params.verificationLines)),
    git: {
      root: afterGitSnapshot?.repoRoot ?? params.beforeGitSnapshot?.repoRoot ?? null,
      head: afterGitSnapshot?.head ? afterGitSnapshot.head.slice(0, 7) : params.beforeGitSnapshot?.head?.slice(0, 7) ?? null,
    },
    toolErrors: params.toolErrorCount,
    blockers,
    ...((params.childVerdicts ?? []).length > 0
      ? { childRunIds: uniqueSorted((params.childVerdicts ?? []).map((verdict) => verdict.subRunId)) }
      : {}),
    ...(childVerdicts.length > 0 ? { childVerdicts } : {}),
    ...(childWarnings.length > 0 ? { childWarnings: uniqueSorted(childWarnings) } : {}),
    ...(reasoningAnnotations.length > 0 ? { reasoningAnnotations } : {}),
  };
  if (isCodingTask(params.runContext)) {
    const validationRunContext = params.prompt
      ? {
        ...params.runContext,
        metadata: {
          ...(params.runContext?.metadata ?? {}),
          validationPrompt: params.prompt,
        },
      }
      : params.runContext;
    // Hand the forbidden-pattern gate the union of changedFiles + committedFiles so
    // it can catch violations introduced by a prior attempt that the current
    // verification-only run did not modify.
    const archivedTouchFiles = params.runId
      ? fileTouchPathsFromArchive(await readArchive(params.runId, { workspace: params.workspace }))
      : [];
    let gateScanFiles = uniqueSorted([...manifest.changedFiles, ...committedFiles, ...archivedTouchFiles]);
    // 2026-05-01 audit gap: in pure verification-only mode (agent confirmed
    // existing code without committing or modifying anything), the gate had
    // nothing to scan and missed pre-existing TODO stubs in security-critical
    // routes. Backfill with the security-critical path globs so the gate can
    // still reject existing violations the agent should have fixed.
    if (gateScanFiles.length === 0) {
      gateScanFiles = await listSecurityCriticalTrackedFiles(params.workspace);
    }
    manifest.validation = await validateCodingTask(params.workspace, manifest, validationRunContext, { gateScanFiles });
    const finalStateVerification = await verifyFinalState({
      workspace: params.workspace,
      runContext: params.runContext,
      prompt: params.prompt ?? "",
      shell: params.verifierShell,
    });
    manifest.finalStateVerification = finalStateVerification;
    if (finalStateVerification.authoritativePassed) {
      manifest.verification = reclassifyExploratoryFailuresAsRecovered(manifest.verification);
      manifest.blockers = manifest.blockers.filter((blocker) => !isExploratoryVerificationBlocker(blocker));
    }
    // Filter out blockers that match later-passing verification lines (stale failures).
    manifest.blockers = manifest.blockers.filter((blocker) => {
      if (!/^failed verification:/i.test(blocker)) return true;
      const blockerLine = blocker.replace(/^failed verification:\s*/i, "");
      return !isRecoveredVerificationFailure(blockerLine, manifest.verification);
    });
    if (params.terminationReason === "turn_budget_exhausted" && finalStateVerification.authoritativePassed) {
      manifest.blockers = manifest.blockers.filter((blocker) =>
        !isLastFailedProbeVerificationBlocker(blocker, params.verificationLines)
      );
    }
    if (finalStateVerification.newBlockers.length > 0) {
      manifest.blockers = uniqueSorted([...manifest.blockers, ...finalStateVerification.newBlockers]);
    }
  }
  return manifest;
}

// Salvaged from F-fix.5+8 WIP — reclassifies exploratory verification
// failures as "recovered" when the final-state verifier's authoritative
// checks have passed. Lets the report show "this build/test passed" even
// when intermediate probes failed during the run.
function isRecoverableBootstrapAttempt(command: string): boolean {
  return /^\s*(?:git\s+(?:-C\s+\S+\s+)?rm\b|mkdir\s+|sed\s+-i\b|cat\s+>|go\s+mod\s+init\b)/i.test(command);
}

function isRecoverableProbeCommand(command: string): boolean {
  return /^\s*(?:cat|head|tail|sed\s+-n|ls|find)\b/i.test(command);
}

const PROBE_COMMANDS = new Set([
  "go vet",
  "go build",
  "go test",
  "grep",
  "rg",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
]);

function isProbeCommand(command: string): boolean {
  const localCommand = commandAfterLeadingCd(command);
  const [first = "", second = ""] = localCommand.trim().split(/\s+/, 2);
  if (first === "go") return PROBE_COMMANDS.has(`go ${second}`);
  return PROBE_COMMANDS.has(first);
}

function isRecoverableGeneratorCommand(command: string): boolean {
  return /\b(?:sqlc|go\s+run\s+github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc(?:@\S+)?)\s+generate\b/i.test(command);
}

function isRecoverableToolInstallCommand(command: string): boolean {
  return /\bgo\s+install\s+github\.com\/(?:sqlc-dev\/sqlc\/cmd\/sqlc|pressly\/goose\/v3\/cmd\/goose)(?:@\S+)?\b/i.test(command);
}

function commandAfterLeadingCd(command: string): string {
  const match = command.match(/^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))\s*&&\s*([\s\S]+)$/);
  return (match?.[2] ?? command).trim();
}

function failedVerificationCommand(blocker: string): string | null {
  const raw = blocker
    .replace(/^failed verification:\s*/i, "")
    .replace(/^Verification:\s*/i, "");
  const match = raw.match(/^(.*?)\s*->\s*failed\b/i);
  const command = (match?.[1] ?? raw).trim();
  return command.length > 0 ? command : null;
}

function verificationCommand(line: string): string | null {
  const raw = line
    .replace(/^failed verification:\s*/i, "")
    .replace(/^Verification:\s*/i, "");
  const match = raw.match(/^(.*?)\s*->\s*(?:failed|passed|recovered)\b/i);
  const command = match?.[1]?.trim() ?? "";
  return command.length > 0 ? command : null;
}

function lastVerificationCommand(verificationLines: string[]): { command: string; failed: boolean } | null {
  for (let i = verificationLines.length - 1; i >= 0; i -= 1) {
    const line = verificationLines[i] ?? "";
    const command = verificationCommand(line);
    if (!command) continue;
    return { command, failed: /->\s*failed\b/i.test(line) };
  }
  return null;
}

function isLastFailedProbeVerificationBlocker(blocker: string, verificationLines: string[]): boolean {
  if (!/^failed verification:/i.test(blocker)) return false;
  const blockerCommand = failedVerificationCommand(blocker);
  if (!blockerCommand || !isProbeCommand(blockerCommand)) return false;
  const lastCommand = lastVerificationCommand(verificationLines);
  return Boolean(lastCommand?.failed && normalizeVerificationCommand(blockerCommand) === normalizeVerificationCommand(lastCommand.command));
}

function isExploratoryVerificationBlocker(blocker: string): boolean {
  if (!/^failed verification:/i.test(blocker)) return false;
  const command = failedVerificationCommand(blocker);
  if (!command) return false;
  const localCommand = commandAfterLeadingCd(command);
  return (
    isRecoverableBootstrapAttempt(localCommand) ||
    isRecoverableProbeCommand(localCommand) ||
    isRecoverableGeneratorCommand(localCommand) ||
    isRecoverableToolInstallCommand(localCommand)
  );
}

function reclassifyExploratoryFailuresAsRecovered(verificationLines: string[]): string[] {
  return verificationLines.map((line) => {
    if (!/->\s*failed/i.test(line)) return line;
    const command = failedVerificationCommand(line);
    if (!command) return line;
    const localCommand = commandAfterLeadingCd(command);
    const recoverable =
      isRecoverableBootstrapAttempt(localCommand) ||
      isRecoverableProbeCommand(localCommand) ||
      isRecoverableGeneratorCommand(localCommand) ||
      isRecoverableToolInstallCommand(localCommand);
    if (!recoverable) return line;
    return line.replace(/->\s*failed[^\n]*/i, "-> recovered (final-state verifier authoritative checks passed)");
  });
}

// Path globs for files the gate should scan even on verification-only runs.
// Kept narrow so we don't blow up cost on large repos: just route handlers
// for auth/billing/webhooks/email/notifications and the matching mobile
// session/auth/payment files. Project-level overrides in
// .tanya/forbidden-patterns.json `alwaysScanGlobs` (future).
const SECURITY_CRITICAL_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)(?:app|src)\/api\/(?:auth|billing|webhooks|payment|email|notifications)\/.*\.(?:ts|tsx|js|mjs)$/i,
  /(?:^|\/)routes\/(?:auth|billing|webhooks|payment|email|notifications)\/.*\.(?:ts|tsx|js|mjs|py|rb|go)$/i,
  // Mobile auth/billing files where placeholders cause silent prod failures
  /(?:^|\/)SessionStore\.swift$/i,
  /(?:^|\/)(?:APIClient|ApiClient|RevenueCatManager)\.swift$/i,
  /(?:^|\/)(?:AuthRepository|RevenueCatBilling)\.kt$/i,
  /(?:^|\/)values\/strings\.xml$/i,
];

async function listSecurityCriticalTrackedFiles(workspace: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const all = stdout.split(/\r?\n/).filter(Boolean);
    return all.filter((file) => SECURITY_CRITICAL_PATH_PATTERNS.some((pattern) => pattern.test(file)));
  } catch {
    return [];
  }
}

type StructuredArtifactReuse = {
  artifact: string;
  targets: string[];
};

type TanyaStructuredReport = {
  schemaVersion: 1;
  modified: string[];
  artifactsReused: StructuredArtifactReuse[];
  artifactsCreated: string[];
  verification: string[];
  manualChecks: string[];
  blocked: string[];
  blockers: string[];
  warnings: string[];
  validation: ValidationSummary;
  git: TanyaFinalManifest["git"];
  metrics: {
    toolErrors: number;
  };
};

export function normalizeVerificationCommand(line: string): string {
  return line
    .replace(/^Verification:\s*/i, "")
    .replace(/\s*->\s*(passed|failed|BUILD SUCCESSFUL|BUILD FAILED|blocked|.+)$/i, "")
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function successfulVerificationCommands(text: string): Set<string> {
  const commands = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^Verification:\s*/i.test(line)) continue;
    if (!/->\s*(passed|BUILD SUCCESSFUL)\b/i.test(line)) continue;
    const command = normalizeVerificationCommand(line);
    if (command) commands.add(command);
  }
  return commands;
}

function hasSuccessfulVerification(verificationLines: string[], pattern: RegExp): boolean {
  return verificationLines.some((line) => /->\s*passed\b/i.test(line) && pattern.test(line));
}

function hasSuccessfulAuthoritativeBuild(verificationLines: string[]): boolean {
  return hasSuccessfulVerification(verificationLines, /\bxcodebuild\s+build\b/i) ||
    hasSuccessfulVerification(verificationLines, /\b(?:\.\/gradlew\s+)?(?:assembleDebug|test|check|build)\b/i) ||
    hasSuccessfulVerification(verificationLines, /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|typecheck)\b/i) ||
    hasSuccessfulVerification(verificationLines, /\b(?:swift|cargo|go)\s+(?:build|test)\b/i);
}

function shellPathTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/[;,]$/g, ""))
    .filter((token) => /(?:^|\/)[\w.-]+\.[\w.-]+$/.test(token));
}

function hasSuccessfulCommandTouchingSamePath(line: string, verificationLines: string[], commandPattern: RegExp): boolean {
  const failedCommand = normalizeVerificationCommand(line);
  const failedPaths = shellPathTokens(failedCommand);
  if (!failedPaths.length) return false;
  return verificationLines.some((candidate) => {
    if (!/->\s*passed\b/i.test(candidate)) return false;
    const candidateCommand = normalizeVerificationCommand(candidate);
    if (!commandPattern.test(candidateCommand)) return false;
    const candidatePaths = shellPathTokens(candidateCommand);
    return failedPaths.some((failedPath) => candidatePaths.includes(failedPath));
  });
}

function isRecoveredVerificationFailure(line: string, verificationLines: string[]): boolean {
  if (!/->\s*failed\b/i.test(line)) return false;
  if (/Shell (?:script|verification) rejected by safety checks/i.test(line)) return true;
  if (/Shell script rejected: git restore of historical content is not allowed/i.test(line)) return true;
  if (/bundle\s+install\b/i.test(line) &&
    /Host Ruby gem mutation is not allowed|host mutation safety checks/i.test(line) &&
    hasSuccessfulVerification(verificationLines, /\bfastlane\s+\w+\s+build\b/i)) {
    return true;
  }
  if (/\bktlintCheck\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bktlintCheck\b/i)) return true;
  if (/ktlintFormat\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bktlintCheck\b/i)) return true;
  if (/\.swiftlint\.yml\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bswiftlint\b/i)) return true;
  if (/\bcp\s+/i.test(line) && hasSuccessfulCommandTouchingSamePath(line, verificationLines, /\bcp\s+/i)) return true;
  if (/\bmkdir\s+-p\s+/i.test(line) && hasSuccessfulCommandTouchingSamePath(line, verificationLines, /\bmkdir\s+-p\s+/i)) return true;
  if (/\bfastlane\s+(\w+)\s+build\b/i.test(line)) {
    const laneMatch = line.match(/\bfastlane\s+(\w+)\s+build\b/i);
    const lane = laneMatch?.[1];
    if (lane && hasSuccessfulVerification(verificationLines, new RegExp(`\\bfastlane\\s+${lane}\\s+build\\b`, "i"))) {
      return true;
    }
  }
  if (/git\s+(?:-C\s+\S+\s+)?add\b/i.test(line) &&
    (hasSuccessfulVerification(verificationLines, /git\s+(?:-C\s+\S+\s+)?add\b/i) ||
      verificationLines.some((candidate) => /->\s*passed\b/i.test(candidate) && /git\s+(?:-C\s+\S+\s+)?add\b/i.test(candidate)))) {
    return true;
  }
  if (/git\s+(?:-C\s+\S+\s+)?add[\s\S]*git\s+(?:-C\s+\S+\s+)?commit/i.test(line) &&
    hasSuccessfulVerification(verificationLines, /git\s+(?:-C\s+\S+\s+)?add[\s\S]*git\s+(?:-C\s+\S+\s+)?commit/i)) {
    return true;
  }
  if (/xcodebuild[\s\S]*destination/i.test(line) &&
    hasSuccessfulVerification(verificationLines, /xcodebuild[\s\S]*destination/i)) {
    return true;
  }
  if (/assembleDebug\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bassembleDebug\b/i)) return true;
  if (/\b(?:grep|rg)\s+-c\b[\s\S]*(?:project\.pbxproj|build\.gradle\.kts|package\.json|tsconfig\.json|Info\.plist)/i.test(line) &&
    hasSuccessfulAuthoritativeBuild(verificationLines)) {
    return true;
  }
  const npmScriptMatch = line.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)\b/i);
  if (npmScriptMatch?.[1]) {
    const script = npmScriptMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (hasSuccessfulVerification(verificationLines, new RegExp(`\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?${script}\\b`, "i"))) {
      return true;
    }
  }
  // Generic: same shell command later succeeded (with optional exit-echo suffix).
  // Salvaged from F-fix.5+8 — handles the `cmd` -> failed / `cmd 2>&1; echo "EXIT=$?"` -> passed pattern.
  const failedCmd = line.replace(/^Verification:\s*/i, "").replace(/\s*->\s*failed\b[\s\S]*$/i, "").trim();
  if (failedCmd) {
    const escaped = failedCmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reSamePassed = new RegExp(`^(?:Verification:\\s*)?${escaped}(?:\\s+2>&1;?\\s*echo\\s+"EXIT=\\$\\?")?\\s*->\\s*passed\\b`, "i");
    if (verificationLines.some((other) => other !== line && reSamePassed.test(other))) {
      return true;
    }
  }
  return false;
}

function isSuccessfulAbsenceSearch(line: string, finalText: string): boolean {
  if (!/->\s*failed\b/i.test(line)) return false;
  const command = normalizeVerificationCommand(line);
  if (!/\b(?:grep|rg)\b/i.test(command)) return false;
  if (!/\b(?:no|none|without|absent|not found|not present|zero)\b/i.test(finalText)) return false;
  if (!/\b(?:references?|matches?|occurrences?|old|legacy|forbidden|stale)\b/i.test(finalText)) return false;
  return true;
}

export function failedVerificationBlockers(verificationLines: string[], finalText = ""): string[] {
  const successfulCommands = successfulVerificationCommands(finalText);
  return verificationLines
    .filter((line) => /->\s*failed\b/i.test(line))
    .filter((line) => !successfulCommands.has(normalizeVerificationCommand(line)))
    .filter((line) => !isSuccessfulAbsenceSearch(line, finalText))
    .filter((line) => !isRecoveredVerificationFailure(line, verificationLines))
    .map((line) => `failed verification: ${line.replace(/^Verification:\s*/i, "")}`);
}

function explicitArtifactReuseNone(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => /^Artifact reused:\s*none\b/i.test(normalizeReportLabel(line)));
}

function explicitArtifactReuseNoneWithRationale(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => {
      const normalized = normalizeReportLabel(line);
      return /^Artifact reused:\s*none\b/i.test(normalized) &&
        /\b(?:read for context|not directly|doesn'?t directly|already in place|not used|no matched artifacts? relevant)\b/i.test(normalized);
    });
}

function cleanArtifactTargetPath(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/\s+[—-]\s+.*$/, "")
    .replace(/\s+\(.*$/, "")
    .replace(/;.*$/, "")
    .trim();
}

function isArtifactTargetPath(value: string): boolean {
  return value === "verification-only" ||
    value === "reusable artifact" ||
    /(?:^|\/)[^/\s]+\.[A-Za-z0-9]+$/.test(value);
}

function normalizeReportLabel(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/^\*\*(Artifact reused|Artifact created|Modified|Verification|Manual check|Blocked):\*\*/i, "$1:")
    .replace(/^`(Artifact reused|Artifact created|Modified|Verification|Manual check|Blocked):`/i, "$1:")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s*→\s*/g, " -> ")
    .trim();
}

function canonicalArtifactReuseLine(line: string): string {
  const cleaned = normalizeReportLabel(line);
  const match = cleaned.match(/^(Artifact reused:\s*.+?)\s*->\s*(.+)$/i);
  if (!match) return cleaned;
  const prefix = match[1]?.trim() ?? "";
  const rawTarget = (match[2] ?? "").trim();
  if (/^(?:none|n\/a|not used|unused)\b/i.test(rawTarget)) return "Artifact reused: none";
  const targets = (match[2] ?? "")
    .split(",")
    .map(cleanArtifactTargetPath)
    .filter(isArtifactTargetPath);
  return targets.length > 0 ? `${prefix} -> ${targets.join(", ")}` : "Artifact reused: none";
}

function explicitArtifactReuseLines(text: string): string[] {
  return uniqueSorted(text
    .split(/\r?\n/)
    .map(canonicalArtifactReuseLine)
    .filter((line) => /^Artifact reused:\s+/i.test(line))
    .filter((line) => !/^Artifact reused:\s*none\b/i.test(line)));
}

function explicitArtifactReuseLinesForManifest(
  text: string,
  manifest: Pick<TanyaFinalManifest, "artifactsRead" | "changedFiles">,
  runContext?: TanyaRunContext,
): string[] {
  if (manifest.artifactsRead.length === 0) return explicitArtifactReuseLines(text);
  const artifactPaths = new Set(manifest.artifactsRead.flatMap((artifactPath) => [
    artifactPath,
    sourceArtifactPath(artifactPath, runContext),
  ]));
  const changedFiles = new Set(manifest.changedFiles);
  return explicitArtifactReuseLines(text).filter((line) => {
    const match = line.match(/^Artifact reused:\s*(.+?)\s*->\s*(.+)$/i);
    if (!match) return false;
    const artifact = match[1]?.trim();
    if (!artifact || !artifactPaths.has(artifact)) return false;
    const targets = (match[2] ?? "")
      .split(",")
      .map((target) => target.trim())
      .filter(Boolean);
    return targets.length > 0 && targets.every((target) => target === "verification-only" || changedFiles.has(target));
  });
}

function artifactTargetFiles(artifactPath: string, changedFiles: string[]): string[] {
  if (/artifacts\/ios\/SplashScreenPattern\.swift$|\.tanya\/artifacts\/ios\/SplashScreenPattern\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)SplashScreenView\.swift$/.test(file));
  }
  if (/artifacts\/ios\/OnboardingFlowPattern\.swift$|\.tanya\/artifacts\/ios\/OnboardingFlowPattern\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:OnboardingView|OnboardingPageView)\.swift$|(?:^|\/)[^/]+App\.swift$/.test(file));
  }
  if (/artifacts\/ios\/ColorHex\.swift$|\.tanya\/artifacts\/ios\/ColorHex\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:ColorHex|Colors|ThemeSystem)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/ThemeSystem\.swift$|\.tanya\/artifacts\/ios\/ThemeSystem\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Theme\/)?(?:ThemeSystem|Colors|Typography|ViewModifiers)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/NavigationSetup\.swift$|\.tanya\/artifacts\/ios\/NavigationSetup\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Navigation\/)?(?:NavigationSetup|AppNavigation|NavigationView)\.swift$|(?:^|\/)ContentView\.swift$|(?:^|\/)[^/]+App\.swift$/.test(file));
  }
  if (/artifacts\/ios\/SwiftDataSetup\.swift$|\.tanya\/artifacts\/ios\/SwiftDataSetup\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Models\/)?(?:SwiftDataSetup|Models|.*Model)\.swift$|(?:^|\/)[^/]+App\.swift$/.test(file));
  }
  if (/artifacts\/ios\/MultiPlatformAppleSetup\.swift$|\.tanya\/artifacts\/ios\/MultiPlatformAppleSetup\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:ContentView|[^/]+App|Platform|Root)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/DebugLogger\.swift$|\.tanya\/artifacts\/ios\/DebugLogger\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:DebugLogger|Logger|Logging)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/Localization\.swift$|\.tanya\/artifacts\/ios\/Localization\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Localization|Localiz(?:able|ation)|Strings)\.swift$|(?:^|\/)[^/]+\.strings$/.test(file));
  }
  if (/artifacts\/ios\/OfflineCachePatterns\.swift$|\.tanya\/artifacts\/ios\/OfflineCachePatterns\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Offline|Cache|Sync|Repository|Store)[^/]*\.swift$/.test(file));
  }
  if (/artifacts\/android\/SplashScreenPattern\.kt$|\.tanya\/artifacts\/android\/SplashScreenPattern\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:SplashScreen|MainActivity)\.kt$/.test(file));
  }
  if (/artifacts\/android\/OnboardingFlowPattern\.kt$|\.tanya\/artifacts\/android\/OnboardingFlowPattern\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:OnboardingScreen|OnboardingDataStore|MainActivity|AppNavigation)\.kt$|(?:^|\/)app\/build\.gradle\.kts$/.test(file));
  }
  if (/artifacts\/android\/ThemeSystem\.kt$|\.tanya\/artifacts\/android\/ThemeSystem\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)ui\/theme\/(?:AppTheme|Color|Theme|Type)\.kt$/.test(file));
  }
  if (/artifacts\/android\/NavigationSetup\.kt$|\.tanya\/artifacts\/android\/NavigationSetup\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)navigation\/[^/]+\.kt$|(?:^|\/)MainActivity\.kt$/.test(file));
  }
  if (/artifacts\/android\/RoomSetup\.kt$|\.tanya\/artifacts\/android\/RoomSetup\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) =>
      /(?:^|\/)(?:app\/schemas\/|build\.gradle\.kts$|app\/build\.gradle\.kts$)/.test(file) ||
      /(?:^|\/)data\/.*(?:Database|Entity|Dao|Room|Migration|Repository)\.kt$/.test(file)
    );
  }
  if (/artifacts\/android\/FeatureScreenPatterns\.kt$|\.tanya\/artifacts\/android\/FeatureScreenPatterns\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)ui\/components\/[^/]+\.kt$|(?:^|\/)ui\/screens\/[^/]+\.kt$/.test(file));
  }
  if (/artifacts\/android\/OfflineCachePatterns\.kt$|\.tanya\/artifacts\/android\/OfflineCachePatterns\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:data\/.*(?:Cache|Sync|Offline)|work\/|network\/).*\.kt$/.test(file));
  }
  if (artifactPath.endsWith("artifacts/ios/FastlaneSetup.md") || artifactPath.endsWith(".tanya/artifacts/ios/FastlaneSetup.md")) {
    return changedFiles.filter((file) => file === "fastlane/Fastfile" || file === "fastlane/Appfile" || /(?:^|\/)ExportOptions-[^/]+\.plist$/.test(file));
  }
  if (/artifacts\/android\/FastlaneSetup\.md$|\.tanya\/artifacts\/android\/FastlaneSetup\.md$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)fastlane\/Fastfile$|(?:^|\/)fastlane\/Appfile$/.test(file));
  }
  if (/artifacts\/android\/PlayRelease_ManualSteps\.md$|\.tanya\/artifacts\/android\/PlayRelease_ManualSteps\.md$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)fastlane\/Fastfile$|(?:^|\/)gradle\.properties$/.test(file));
  }
  if (/artifacts\/backend\/JwtAuthRoutes\.ts$|\.tanya\/artifacts\/backend\/JwtAuthRoutes\.ts$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)app\/api\/[^/]+(?:\/.*)?\/route\.ts$|(?:^|\/)(?:lib\/(?:auth|.*Auth|routeWrappers)\.ts|middleware\.ts)$/.test(file));
  }
  if (/artifacts\/backend\/OpenApiSwaggerRoutes\.ts$|\.tanya\/artifacts\/backend\/OpenApiSwaggerRoutes\.ts$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:lib\/openapi\.ts|app\/api\/(?:docs|openapi\.json)\/route\.ts|API_FEATURES\.md|brand\/api_features\.md)$/.test(file));
  }
  if (/artifacts\/backend\/PrismaBase\.prisma$|\.tanya\/artifacts\/backend\/PrismaBase\.prisma$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)prisma\/schema\.prisma$/.test(file));
  }
  if (/artifacts\/backend\/EnvExample\.txt$|\.tanya\/artifacts\/backend\/EnvExample\.txt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)\.env\.example$/.test(file));
  }
  if (/artifacts\/testing\/MobileCIWorkflows\.md$|\.tanya\/artifacts\/testing\/MobileCIWorkflows\.md$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  }
  return [];
}

function stripConflictingArtifactReuseLines(text: string, manifest: TanyaFinalManifest, force = false): string {
  if (!force && manifest.artifactsRead.length === 0) return text;
  const zeroChangeVerificationOnly = manifest.changedFiles.length === 0;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^[-*]?\s*(?:\*\*)?`?Artifact reused:/i.test(trimmed)) return false;
      if (zeroChangeVerificationOnly && /\bArtifact reused:\s*/i.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

function normalizeArtifactReuseLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => {
      const normalized = normalizeReportLabel(line);
      if (/^Artifact reused:\s*/i.test(normalized)) return canonicalArtifactReuseLine(normalized);
      if (/^Manual check:\s*/i.test(normalized) && !/\s->\s/.test(normalized)) return `${normalized} -> required after CLI`;
      return /^(Artifact created|Modified|Verification|Manual check|Blocked):\s*/i.test(normalized) ? normalized : line;
    });
  const hasSpecificReuse = lines.some((line) => /^Artifact reused:\s+/i.test(line) && !/^Artifact reused:\s*none\b/i.test(line));
  return lines
    .filter((line) => !(hasSpecificReuse && /^Artifact reused:\s*none\b/i.test(line)))
    .join("\n");
}

function explicitManualCheckLines(text: string): string[] {
  const lines: string[] = [];
  let inManualSection = false;
  for (const line of text.split(/\r?\n/)) {
    const normalized = normalizeReportLabel(line);
    if (/^Manual check:\s*/i.test(normalized)) {
      lines.push(/\s->\s/.test(normalized) ? normalized : `${normalized} -> required after CLI`);
      continue;
    }
    if (
      /^#{1,6}\s*(?:Manual (?:checks?|testing)|What to test manually)\b/i.test(line.trim()) ||
      /^(?:Manual (?:checks?|testing)|What to test manually)\b/i.test(normalized)
    ) {
      inManualSection = true;
      continue;
    }
    if (inManualSection && /^#{1,6}\s+\S/.test(line.trim())) {
      inManualSection = false;
      continue;
    }
    if (!inManualSection) continue;
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/)?.[1];
    if (!item) continue;
    const cleaned = item
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) lines.push(`Manual check: ${cleaned}${/\s->\s/.test(cleaned) ? "" : " -> required after CLI"}`);
  }
  return uniqueSorted(lines);
}

function hasCompleteCodingReport(text: string): boolean {
  return hasRequiredCodingReport(text)
    && /Artifact reused:\s*/i.test(text)
    && /Artifact created:\s*/i.test(text)
    && (/Modified:\s*/i.test(text) || /Verification-only:\s*existing setup satisfied/i.test(text))
    && /Blocked:\s*/i.test(text);
}

function buildArtifactReportLines(
  manifest: Pick<TanyaFinalManifest, "artifactsRead" | "changedFiles">,
  runContext?: TanyaRunContext,
  finalText = "",
): string[] {
  const availableCallerArtifacts = runContext?.artifacts
    ?.filter((artifact) => artifact.status !== "missing")
    .map((artifact) => artifact.path) ?? [];
  const explicitReuseLines = explicitArtifactReuseLinesForManifest(finalText, manifest, runContext);
  const shouldRespectExplicitNone = explicitReuseLines.length === 0 && explicitArtifactReuseNone(finalText);
  if (manifest.changedFiles.length === 0) return ["Artifact reused: none"];
  const artifactReportPaths = shouldRespectExplicitNone
    ? []
    : manifest.artifactsRead.length > 0
      ? manifest.artifactsRead
      : availableCallerArtifacts;
  if (artifactReportPaths.length > 0) {
    const mapped = artifactReportPaths.flatMap((artifactPath) => {
      const targetFiles = artifactTargetFiles(artifactPath, manifest.changedFiles);
      if (targetFiles.length > 0) return [`Artifact reused: ${sourceArtifactPath(artifactPath, runContext)} -> ${targetFiles.join(", ")}`];
      return [];
    });
    if (mapped.length > 0) return mapped;
  }
  if (explicitReuseLines.length > 0) {
    return uniqueSorted(explicitReuseLines);
  }
  return ["Artifact reused: none"];
}

function structuredArtifactReuse(manifest: Pick<TanyaFinalManifest, "artifactsRead" | "changedFiles">, runContext?: TanyaRunContext, finalText = ""): StructuredArtifactReuse[] {
  const lines = buildArtifactReportLines(manifest, runContext, finalText);
  return lines
    .map((line): StructuredArtifactReuse | null => {
      const match = line.match(/^Artifact reused:\s*(.+?)\s*->\s*(.+)$/i);
      if (!match) return null;
      const artifact = match[1]?.trim();
      const targets = (match[2] ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean);
      if (!artifact || /^none$/i.test(artifact)) return null;
      return { artifact, targets };
    })
    .filter((entry): entry is StructuredArtifactReuse => entry !== null);
}

function buildStructuredReport(manifest: TanyaFinalManifest, runContext?: TanyaRunContext, finalText = ""): TanyaStructuredReport {
  const validationBlockers = (manifest.validation?.issues ?? [])
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.id}: ${issue.message}`);
  const blocked = uniqueSorted([...manifest.blockers, ...validationBlockers]);
  const artifactsReused = structuredArtifactReuse(manifest, runContext, finalText);
  const hasStrictArtifactMapping = manifest.artifactsRead.some((artifactPath) =>
    /artifacts\/(?:ios\/(?:FastlaneSetup\.md|SplashScreenPattern\.swift)|android\/(?:FastlaneSetup\.md|PlayRelease_ManualSteps\.md|SplashScreenPattern\.kt|ThemeSystem\.kt|NavigationSetup\.kt|RoomSetup\.kt|FeatureScreenPatterns\.kt|OfflineCachePatterns\.kt)|backend\/(?:JwtAuthRoutes\.ts|OpenApiSwaggerRoutes\.ts|PrismaBase\.prisma|EnvExample\.txt)|testing\/MobileCIWorkflows\.md)$|\.tanya\/artifacts\/(?:ios\/(?:FastlaneSetup\.md|SplashScreenPattern\.swift)|android\/(?:FastlaneSetup\.md|PlayRelease_ManualSteps\.md|SplashScreenPattern\.kt|ThemeSystem\.kt|NavigationSetup\.kt|RoomSetup\.kt|FeatureScreenPatterns\.kt|OfflineCachePatterns\.kt)|backend\/(?:JwtAuthRoutes\.ts|OpenApiSwaggerRoutes\.ts|PrismaBase\.prisma|EnvExample\.txt)|testing\/MobileCIWorkflows\.md)$/.test(artifactPath)
  );
  const explicitNoneOnly = explicitArtifactReuseNoneWithRationale(finalText)
    && explicitArtifactReuseLines(finalText).length === 0
    && artifactsReused.length === 0
    && !/Verification:\s*not completed\s*->\s*blocked before verification command was captured/i.test(finalText)
    && !manifest.artifactsRead.some((artifactPath) => finalText.includes(sourceArtifactPath(artifactPath, runContext)));
  const inferredArtifactsReused = manifest.artifactsRead.flatMap((artifactPath): StructuredArtifactReuse[] => {
      const targets = artifactTargetFiles(artifactPath, manifest.changedFiles);
      if (targets.length === 0) return [];
      return [{ artifact: sourceArtifactPath(artifactPath, runContext), targets }];
    });
  const repairedArtifactsReused = explicitNoneOnly
    ? []
    : inferredArtifactsReused.length > 0
      ? inferredArtifactsReused
      : artifactsReused;
  return {
    schemaVersion: 1,
    modified: manifest.changedFiles,
    artifactsReused: repairedArtifactsReused,
    artifactsCreated: manifest.artifactsCreated,
    verification: manifest.verification,
    manualChecks: explicitManualCheckLines(finalText),
    blocked,
    blockers: blocked,
    warnings: manifest.childWarnings ?? [],
    validation: manifest.validation ?? { passed: true, issues: [] },
    git: manifest.git,
    metrics: {
      toolErrors: manifest.toolErrors,
    },
  };
}

function buildDeterministicCodingFooter(manifest: TanyaFinalManifest, runContext?: TanyaRunContext, finalText = ""): string {
  const structuredReport = buildStructuredReport(manifest, runContext, finalText);
  const artifactLines = structuredReport.artifactsReused.length > 0
    ? structuredReport.artifactsReused.map((entry) => `Artifact reused: ${entry.artifact} -> ${entry.targets.length > 0 ? entry.targets.join(", ") : "verification-only"}`)
    : ["Artifact reused: none"];
  const artifactCreatedLines = structuredReport.artifactsCreated.length > 0
    ? structuredReport.artifactsCreated.map((artifactPath) => `Artifact created: ${artifactPath} -> reusable artifact`)
    : ["Artifact created: none"];
  const modifiedLines = structuredReport.modified.length > 0
    ? structuredReport.modified.map((filePath) => `Modified: ${filePath}`)
    : ["Modified: none", "Verification-only: existing setup satisfied"];
  const verification = structuredReport.verification.length > 0
    ? structuredReport.verification
    : ["Verification: not completed -> blocked before verification command was captured"];
  return [
    "## Tanya deterministic report",
    "_(authoritative — overrides any conflicting artifact reuse or modification claim above)_",
    ...artifactLines,
    ...artifactCreatedLines,
    ...modifiedLines,
    ...verification,
    ...(structuredReport.warnings.length > 0
      ? ["Warnings:", ...structuredReport.warnings.map((warning) => `- ${warning}`)]
      : []),
    ...(manifest.reasoningAnnotations && manifest.reasoningAnnotations.length > 0
      ? [
        "Reasoning annotations (advisory, not verifier authority):",
        ...manifest.reasoningAnnotations.map((annotation) =>
          `- Why the agent thought this (${annotation.provider}/${annotation.model}, ${annotation.confidence}): ${annotation.excerpt}`
        ),
      ]
      : []),
    ...structuredReport.manualChecks,
    `Verification: git rev-parse --show-toplevel -> ${structuredReport.git.root ?? "unavailable"}`,
    `Verification: git rev-parse --short HEAD -> ${structuredReport.git.head ?? "unavailable"}`,
    structuredReport.blocked.length > 0 ? `Blocked: ${structuredReport.blocked.join("; ")}` : "Blocked: none",
    "Tanya structured report:",
    JSON.stringify(structuredReport, null, 2),
    "Tanya manifest:",
    JSON.stringify(manifest, null, 2),
  ].join("\n");
}

function childVerdictMessage(verdict: ChildVerdict): string {
  const detail = verdict.blockers.join("; ") || verdict.summary || "failed";
  return `subtask ${verdict.subRunId} failed: ${detail}`;
}

function appendTaniaResultLine(text: string, verdict: "PASSED" | "FAIL"): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => !/^TANYA RESULT:\s*(?:PASSED|FAIL)\s*$/i.test(line.trim()));
  return [...lines, `TANYA RESULT: ${verdict}`].join("\n").trim();
}

function manifestVerdict(manifest: TanyaFinalManifest): "PASSED" | "FAIL" {
  if (manifest.blockers.length > 0) return "FAIL";
  const fsv = manifest.finalStateVerification;
  if (fsv && fsv.authoritativePassed === false) return "FAIL";
  return "PASSED";
}

export function ensureCodingReport(text: string, manifest: TanyaFinalManifest, runContext?: TanyaRunContext): string {
  const verdict = manifestVerdict(manifest);
  if (!manifest.changedFiles.length && !manifest.artifactsRead.length && !manifest.artifactsCreated.length && !manifest.verification.length && !manifest.git.root) return appendTaniaResultLine(text, verdict);
  const normalizedText = normalizeArtifactReuseLines(text);
  const bodyText = stripConflictingArtifactReuseLines(normalizedText, manifest, !!runContext?.expected_report?.artifact_reuse);
  const explicitReuseLines = explicitArtifactReuseLinesForManifest(normalizedText, manifest, runContext);
  const footerSourceText = explicitReuseLines.length > 0
    ? normalizedText
    : manifest.artifactsRead.length > 0 && !explicitArtifactReuseNone(normalizedText)
      ? bodyText
    : normalizedText;
  const footer = buildDeterministicCodingFooter(manifest, runContext, footerSourceText);
  if (isCodingTask(runContext) && runContext?.expected_report && runContextRequiresCommit(runContext) && manifest.git.head) return appendTaniaResultLine(footer, verdict);
  const needsManualCheckLines = /^#{1,6}\s*(?:Manual (?:checks?|testing)|What to test manually)\b/im.test(bodyText) && !/^Manual check:\s*/im.test(bodyText);
  if (/Tanya manifest:/i.test(bodyText) || /## Tanya deterministic report/i.test(bodyText)) return appendTaniaResultLine(bodyText, verdict);
  if (hasCompleteCodingReport(bodyText) && !needsManualCheckLines) return appendTaniaResultLine(`${bodyText.trim()}\n\n${footer}`, verdict);
  return appendTaniaResultLine(bodyText.trim() ? `${bodyText.trim()}\n\n${footer}` : footer, verdict);
}
