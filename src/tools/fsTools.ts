import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { TanyaTool, ToolContext, ToolResult } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";
import {
  createAndroidLauncherIconSetTool,
  createAppleAppIconSetTool,
  renderSvgToPngTool,
  resizeImageTool,
  validateAndroidLauncherIconSetTool,
  validateAppleAppIconSetTool,
} from "./imageTools";
import { generateVideoAssetTool } from "./videoTools";
import { buildTaskBriefTool, findReusableArtifactsTool, inspectProjectContextTool } from "./projectContextTools";
import { searchObsidianNotesTool } from "./obsidianTools";
import { expandResultTool } from "./expandResult";
import { taskTool } from "./task";
import { editBlockTool } from "./editBlock";
import { inspectRepoMapTool } from "./repoMapTools";
import { recordMetricsDashboardHandoffTool } from "./metricsDashboardTools";

const ignoredNames = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache"]);
export const PROGRESS_THROTTLE_MS = 2_000;
export const MAX_WRITE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROCESS_BUFFER_BYTES = 16 * 1024 * 1024;

type CappedBuffer = {
  append: (chunk: string) => void;
  value: () => string;
  truncated: () => boolean;
};

// runShell historically hard-coded /bin/zsh, which ENOENTs on minimal Linux
// CI/dev containers. Resolve once at module load: prefer the user's $SHELL,
// then fall back to /bin/zsh and /bin/bash. The flags we pass (`-lc`) are
// portable across both shells.
function pickShellPath(): string {
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/bin/zsh";
}
const SHELL_PATH = pickShellPath();

// Hard ceiling on accumulated process output. A runaway shell command (watching
// build, a flaky test loop, `cat` of a huge log) would otherwise inflate the
// buffer until the worker OOMs even when timeouts eventually kill the process.
function makeCappedBuffer(cap: number = MAX_PROCESS_BUFFER_BYTES): CappedBuffer {
  let text = "";
  let truncated = false;
  return {
    append(chunk: string): void {
      if (!chunk || truncated) return;
      const remaining = cap - text.length;
      if (chunk.length <= remaining) {
        text += chunk;
        return;
      }
      text += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
    },
    value(): string {
      return truncated ? `${text}\n[output truncated at ${cap} bytes]` : text;
    },
    truncated(): boolean {
      return truncated;
    },
  };
}

function isProtectedLocalConfigPath(filePath: string): boolean {
  return basename(filePath.trim().replace(/\\/g, "/")) === "local.properties";
}

function localPropertiesWriteError(): ToolResult {
  return {
    ok: false,
    summary: "Rejected write to local.properties.",
    error: "local.properties is machine-local Android SDK configuration. Do not create or modify it; use ANDROID_HOME or ANDROID_SDK_ROOT for verification instead.",
  };
}

function shellSafetyBlock(summary: string, error: string): ToolResult {
  return {
    ok: false,
    summary,
    error,
    output: { ok: false, error, reason: "shell_safety_block" },
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing string field: ${key}`);
  return value;
}

function asOptionalNumber(input: unknown, key: string, fallback: number): number {
  const value = asRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalBoolean(input: unknown, key: string, fallback: boolean): boolean {
  const value = asRecord(input)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|1)$/i.test(value.trim());
  return fallback;
}

async function pathExists(path: string): Promise<boolean> {
  return existsSync(path);
}

function collectFiles(root: string, maxFiles: number, current = root, out: string[] = []): string[] {
  if (out.length >= maxFiles) return out;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, maxFiles, fullPath, out);
    } else if (entry.isFile()) {
      out.push(relative(root, fullPath));
    }
    if (out.length >= maxFiles) break;
  }
  return out;
}

function runProcess(
  command: string,
  args: string[],
  context: ToolContext,
  timeoutMs: number,
  cwd = context.workspace,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env,
    });
    const stdout = makeCappedBuffer();
    const stderr = makeCappedBuffer();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk.toString());
    });
    child.on("close", (code) => {
      cleanup();
      const stderrText = stderr.value();
      const output = `${stdout.value()}${stderrText ? `\n${stderrText}` : ""}`.trim();
      const truncated = output.length > 12_000 || stdout.truncated() || stderr.truncated();
      const baseResult: ToolResult = {
        ok: code === 0,
        summary: buildProcessSummary("Command", code, output, truncated),
        output,
      };
      resolve(code === 0 ? baseResult : { ...baseResult, error: output.slice(0, 2_000) });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, summary: "Command failed to start.", error: err.message });
    });
  });
}

function emitToolProgress(context: ToolContext, stream: "stdout" | "stderr", chunk: string): void {
  if (!context.onProgress || !chunk) return;
  try {
    void Promise.resolve(context.onProgress({
      stream,
      chunk,
      timestamp: new Date().toISOString(),
    })).catch(() => {});
  } catch {
    // Progress is observational; a sink failure must not fail the tool.
  }
}

function runShell(script: string, context: ToolContext, timeoutMs: number, cwd = context.workspace): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(SHELL_PATH, ["-lc", script], {
      cwd,
      shell: false,
      env: process.env,
      detached: process.platform !== "win32",
    });
    const stdout = makeCappedBuffer();
    const stderr = makeCappedBuffer();
    let cancelled = context.signal?.aborted ?? false;
    let cancelKillTimer: ReturnType<typeof setTimeout> | null = null;
    const progressBuffers: Record<"stdout" | "stderr", string> = {
      stdout: "",
      stderr: "",
    };
    const progressTimers: Record<"stdout" | "stderr", ReturnType<typeof setTimeout> | null> = {
      stdout: null,
      stderr: null,
    };
    const flushProgress = (stream: "stdout" | "stderr") => {
      const timer = progressTimers[stream];
      if (timer) clearTimeout(timer);
      progressTimers[stream] = null;
      const chunk = progressBuffers[stream];
      progressBuffers[stream] = "";
      emitToolProgress(context, stream, chunk);
    };
    const flushAllProgress = () => {
      flushProgress("stdout");
      flushProgress("stderr");
    };
    const queueProgress = (stream: "stdout" | "stderr", chunk: string) => {
      if (!context.onProgress || !chunk) return;
      progressBuffers[stream] += chunk;
      if (progressTimers[stream]) return;
      progressTimers[stream] = setTimeout(() => flushProgress(stream), PROGRESS_THROTTLE_MS);
      progressTimers[stream]?.unref?.();
    };
    const outputSoFar = () => {
      const stderrText = stderr.value();
      return `${stdout.value()}${stderrText ? `\n${stderrText}` : ""}`.trim();
    };
    const killShellProcess = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child if the process group is already gone.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    };
    const requestCancel = () => {
      cancelled = true;
      killShellProcess("SIGTERM");
      if (!cancelKillTimer) {
        cancelKillTimer = setTimeout(() => killShellProcess("SIGKILL"), 500);
        cancelKillTimer.unref?.();
      }
    };
    const cleanupShell = () => {
      clearTimeout(timer);
      if (cancelKillTimer) clearTimeout(cancelKillTimer);
      context.signal?.removeEventListener("abort", requestCancel);
      flushAllProgress();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      killShellProcess("SIGTERM");
    }, timeoutMs);
    if (context.signal?.aborted) requestCancel();
    else context.signal?.addEventListener("abort", requestCancel, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout.append(text);
      queueProgress("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.append(text);
      queueProgress("stderr", text);
    });
    child.on("close", (code) => {
      cleanupShell();
      const output = outputSoFar();
      if (cancelled || context.signal?.aborted) {
        const partialOutput = summarizeProcessOutput(output, 16_000).text;
        resolve({
          ok: false,
          summary: "Shell cancelled by user. Partial output captured.",
          output: { cancelled: true, partial_output: partialOutput },
          error: "Shell cancelled by user.",
          cancelled: true,
          partial_output: partialOutput,
        });
        return;
      }
      const truncated = output.length > 16_000 || stdout.truncated() || stderr.truncated();
      const baseResult: ToolResult = {
        ok: code === 0,
        summary: buildProcessSummary("Shell", code, output, truncated),
        output,
      };
      resolve(code === 0 ? baseResult : { ...baseResult, error: output.slice(0, 2_000) });
    });
    child.on("error", (err) => {
      cleanupShell();
      resolve({ ok: false, summary: "Shell failed to start.", error: err.message });
    });
  });
}

// The regex-based shell safety checks below (unsafeMaskedVerification,
// unsafeHostPackageMutation, and the inline guards in runShellTool.run) are
// ADVISORY ONLY. They are trivially bypassable via indirection (`eval $(cat)`,
// shell variables, `bash -c "..."`). The authoritative gate is the
// permissions engine in src/safety/permissions. Do not weaken or remove a
// permission rule on the assumption that these regexes already catch a case.
function unsafeMaskedVerification(script: string): string | null {
  const runsMobileBuildTool = /(?:^|[\s;&|])(?:\.\/gradlew|gradle|xcodebuild|fastlane)\b/.test(script);
  if (!runsMobileBuildTool) return null;
  const isReadOnlyXcodeDiscovery = /\bxcodebuild\s+-(?:list|showsdks|version)\b/i.test(script);
  if (isReadOnlyXcodeDiscovery) return null;
  if (/[|]/.test(script) && !/set\s+-o\s+pipefail/.test(script)) {
    return "Mobile build/test verification commands that use pipes must include `set -o pipefail` so failures are not masked.";
  }
  if (/;\s*echo\s+["']?EXIT_CODE=\$\?["']?/i.test(script)) {
    return "Do not append `; echo EXIT_CODE=$?` to verification commands because it makes the shell exit 0 even when the build command failed.";
  }
  return null;
}

function unsafeHostPackageMutation(script: string): string | null {
  if (/\bbrew\s+(?:install|reinstall|upgrade|uninstall|tap|extract)\b/i.test(script)) {
    return "Host package-manager mutation is not allowed during coding runs. Report the missing/broken Homebrew package as a manual environment blocker instead.";
  }
  if (/\bgem\s+(?:install|update|uninstall)\b/i.test(script) || /\bbundle\s+install\b/i.test(script)) {
    return "Host Ruby gem mutation is not allowed during coding runs. Report the missing/broken Ruby/Fastlane dependency as a manual environment blocker instead.";
  }
  return null;
}

function summarizeProcessOutput(output: string, maxChars: number): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 120;
  return {
    text: `${output.slice(0, headSize)}\n\n[output truncated: showing head and tail; exit code remains authoritative]\n\n${output.slice(-tailSize)}`,
    truncated: true,
  };
}

function buildProcessSummary(kind: "Command" | "Shell", code: number | null, output: string, truncated: boolean): string {
  const exit = code ?? "unknown";
  const successHint = code === 0 && /BUILD SUCCEEDED|Test Suite '.+' passed|0 failures|Process completed successfully/i.test(output)
    ? " Success marker found."
    : "";
  const truncatedHint = truncated ? " Output was truncated for display, but the exit code is authoritative." : "";
  return `${kind} exited ${exit}.${successHint}${truncatedHint}`;
}

function filterTypeScriptErrorOutput(output: unknown): string | null {
  if (typeof output !== "string" || !output.trim()) return null;
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  const errorPattern = /^[^:]+\.tsx?:\d+:\d+\s+-\s+error\s+TS\d+:/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!errorPattern.test(line)) continue;
    kept.push(line);
    const nextLine = lines[i + 1];
    if (nextLine !== undefined) kept.push(nextLine);
  }
  return kept.length > 0 ? `TypeScript errors (filtered):\n${kept.join("\n")}` : null;
}

function commandRunsTypeScript(command: string, args: string[]): boolean {
  return basename(command) === "tsc" || args.some((arg) => basename(arg) === "tsc");
}

function shellRunsTypeScript(script: string): boolean {
  return /(?:^|[\s;&|])(?:npx\s+|npm\s+exec\s+|pnpm\s+exec\s+|yarn\s+)?tsc(?:\s|$)/.test(script);
}

function maybeFilterTypeScriptErrorResult(result: ToolResult, shouldFilter: boolean): ToolResult {
  if (!shouldFilter || result.ok) return result;
  const filtered = filterTypeScriptErrorOutput(result.output);
  if (!filtered) return result;
  return {
    ...result,
    output: filtered,
    error: filtered,
  };
}

function normalizeRelativePathForGit(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function ensureRelativePath(path: string): string {
  if (path.startsWith("/")) throw new Error(`Path must be relative to the workspace: ${path}`);
  return path;
}

function resolveToolCwd(context: ToolContext, cwdInput?: string): string {
  if (!cwdInput) return context.workspace;
  return isAbsolute(cwdInput)
    ? resolveInsideWorkspace(context.workspace, cwdInput)
    : resolveInsideWorkspace(context.workspace, ensureRelativePath(cwdInput));
}

function runProcessWithInput(
  command: string,
  args: string[],
  input: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: context.workspace,
      shell: false,
      env: process.env,
    });
    const stdout = makeCappedBuffer();
    const stderr = makeCappedBuffer();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk.toString());
    });
    child.on("close", (code) => {
      cleanup();
      const stderrText = stderr.value();
      const output = `${stdout.value()}${stderrText ? `\n${stderrText}` : ""}`.trim();
      const baseResult: ToolResult = {
        ok: code === 0,
        summary: `Command exited ${code ?? "unknown"}.`,
        output: output.slice(0, 12_000),
      };
      resolve(code === 0 ? baseResult : { ...baseResult, error: output.slice(0, 2_000) });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, summary: "Command failed to start.", error: err.message });
    });
    child.stdin.end(input);
  });
}

function stripPatchPath(path: string, stripLevel: number): string | null {
  const clean = path.trim().split(/\s+/)[0];
  if (!clean || clean === "/dev/null") return null;
  const withoutQuotes = clean.replace(/^"|"$/g, "");
  const parts = withoutQuotes.split("/").filter(Boolean);
  const stripped = parts.slice(Math.max(0, stripLevel)).join("/");
  return stripped || withoutQuotes;
}

function inferPatchStripLevel(patch: string): number {
  return /^diff --git a\//m.test(patch) || /^--- a\//m.test(patch) || /^\+\+\+ b\//m.test(patch) ? 1 : 0;
}

function extractPatchFiles(patch: string, stripLevel: number): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const header = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (!header) continue;
    const stripped = stripPatchPath(header[1] ?? "", stripLevel);
    if (stripped) files.add(stripped);
  }
  return [...files];
}

async function removePatchBackupFiles(files: string[], context: ToolContext): Promise<string[]> {
  const removed: string[] = [];
  for (const file of files) {
    for (const suffix of [".orig", ".bak"]) {
      const backupPath = `${file}${suffix}`;
      try {
        const abs = resolveInsideWorkspace(context.workspace, backupPath);
        await unlink(abs);
        removed.push(backupPath);
      } catch {
        // No backup was created for this file.
      }
    }
  }
  return removed;
}

function pathInsideWorkspace(workspace: string, target: string): boolean {
  const rel = relative(workspace, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shellUnquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function shellSnippetMayMutateWorkspace(script: string): boolean {
  return /(?:^|[;&|]\s*)(?:cat\s+>|tee\s+|mkdir\b|touch\b|rm\b|mv\b|cp\b|ln\b|go\s+mod\s+(?:init|tidy|edit|download)\b|go\s+get\b|go\s+work\b|npm\s+(?:install|i|update|add)\b|pnpm\s+(?:install|add|update)\b|yarn\s+(?:add|install)\b|sqlc\s+generate\b|go\s+run\s+github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc(?:@\S+)?\s+generate\b|git\s+(?:add|commit|rm|mv|checkout|restore|reset|clean)\b)/i.test(script) ||
    /(?:^|[^2])>\s*(?!&)/.test(script);
}

function outsideWorkspaceShellMutationError(script: string, workspace: string, cwd: string): string | null {
  const match = script.match(/^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))\s*&&\s*([\s\S]+)$/);
  if (!match) return null;
  const rawTarget = shellUnquote(match[1] ?? "");
  if (!rawTarget || rawTarget === "-") return null;
  if (/[$`]/.test(rawTarget)) return null;
  const target = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(cwd, rawTarget);
  if (pathInsideWorkspace(workspace, target)) return null;
  const rest = match[2] ?? "";
  if (!shellSnippetMayMutateWorkspace(rest)) return null;
  return `Shell snippet changes directory outside the workspace before a mutating command: cd ${rawTarget}. Use structured file tools or run mutations from the workspace root.`;
}

export const listFilesTool: TanyaTool = {
  name: "list_files",
  description: "List workspace files, skipping dependency and build directories.",
  definition: {
    type: "function",
    function: {
      name: "list_files",
      description: "List workspace files, skipping dependency and build directories.",
      parameters: {
        type: "object",
        properties: {
          maxFiles: { type: "number", description: "Maximum number of files to return. Default 120." },
          path: { type: "string", description: "Optional directory path relative to the workspace. Default workspace root." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const maxFiles = Math.min(asOptionalNumber(input, "maxFiles", 120), 500);
    const path = asOptionalString(input, "path");
    const root = path ? resolveInsideWorkspace(context.workspace, ensureRelativePath(path)) : context.workspace;
    const files = collectFiles(root, maxFiles).map((file) => path ? `${path.replace(/\/+$/, "")}/${file}` : file);
    return { ok: true, summary: `Listed ${files.length} file${files.length === 1 ? "" : "s"}.`, output: files };
  },
};

export const readFileTool: TanyaTool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace.",
  truncateLargeResults: false,
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace." },
          maxChars: { type: "number", description: "Maximum characters to return. Default 12000." },
          force: { type: "boolean", description: "Return full content even if Tanya already read the same unchanged file in this run." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const path = asString(input, "path");
    const maxChars = Math.min(asOptionalNumber(input, "maxChars", 12_000), 40_000);
    const abs = resolveInsideWorkspace(context.workspace, path);
    const content = await readFile(abs, "utf8");
    return {
      ok: true,
      summary: `Read ${path}.`,
      output: content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content,
    };
  },
};

export const writeFileTool: TanyaTool = {
  name: "write_file",
  description: "Write a UTF-8 text file inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const path = asString(input, "path");
    const content = asString(input, "content");
    if (isProtectedLocalConfigPath(path)) return localPropertiesWriteError();
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WRITE_FILE_BYTES) {
      return {
        ok: false,
        summary: `Refused write to ${path}: content is ${bytes} bytes (cap ${MAX_WRITE_FILE_BYTES}).`,
        error: `write_file rejects payloads larger than ${MAX_WRITE_FILE_BYTES} bytes to avoid OOM/disk-fill. Split the file or stream it via run_shell.`,
      };
    }
    const abs = resolveInsideWorkspace(context.workspace, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const previewLines = content.split("\n");
    const lineCount = previewLines.length;
    const preview = previewLines.slice(0, 4).join("\n");
    return {
      ok: true,
      summary: `Wrote ${path} (${lineCount} lines).`,
      output: { path, lineCount, preview },
      files: [path],
    };
  },
};

export const searchTool: TanyaTool = {
  name: "search",
  description: "Search workspace text using ripgrep.",
  definition: {
    type: "function",
    function: {
      name: "search",
      description: "Search workspace text using ripgrep.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query or regex." },
          maxResults: { type: "number", description: "Maximum lines to return. Default 80." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const query = asString(input, "query");
    const maxResults = Math.min(asOptionalNumber(input, "maxResults", 80), 300);
    const result = await runProcess("rg", ["-n", "--hidden", "-g", "!node_modules", "-g", "!.git", query], context, 20_000);
    if (!result.ok && typeof result.output === "string" && !result.output) {
      return { ok: true, summary: "No matches.", output: [] };
    }
    const lines = String(result.output ?? "").split("\n").slice(0, maxResults);
    return { ok: true, summary: `Found ${lines.filter(Boolean).length} match line${lines.length === 1 ? "" : "s"}.`, output: lines };
  },
};

export const runCommandTool: TanyaTool = {
  name: "run_command",
  description: "Run a non-interactive command inside the workspace.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a non-interactive command inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command binary, for example npm." },
          args: { type: "array", items: { type: "string" }, description: "Command arguments." },
          cwd: { type: "string", description: "Optional subdirectory relative to the workspace." },
          timeoutMs: { type: "number", description: "Timeout in milliseconds. Default 120000." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const command = asString(input, "command");
    const rawArgs = asRecord(input).args;
    const args = Array.isArray(rawArgs) ? rawArgs.filter((arg): arg is string => typeof arg === "string") : [];
    const cwdInput = asOptionalString(input, "cwd");
    const cwd = resolveToolCwd(context, cwdInput);
    const timeoutMs = Math.min(asOptionalNumber(input, "timeoutMs", 120_000), 300_000);
    const result = await runProcess(command, args, context, timeoutMs, cwd);
    return maybeFilterTypeScriptErrorResult(result, commandRunsTypeScript(command, args));
  },
};

export const runShellTool: TanyaTool = {
  name: "run_shell",
  description: "Run a bounded non-interactive shell snippet inside the workspace.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a bounded non-interactive shell snippet inside the workspace. Use for mobile verification commands that need environment variables, pipes, or chained arguments.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "Non-interactive zsh script." },
          command: { type: "string", description: "Alias for script. Prefer script for new calls." },
          cwd: { type: "string", description: "Optional subdirectory relative to the workspace." },
          timeoutMs: { type: "number", description: "Timeout in milliseconds. Default 120000." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const script = asOptionalString(input, "script") ?? asString(input, "command");
    if (/\b(rm\s+-rf|sudo|ssh|scp|curl\s+[^|>]*\|\s*(?:sh|bash|zsh)|while\s+true|tail\s+-f)\b/.test(script)) {
      return shellSafetyBlock("Shell script rejected by safety checks.", "Use bounded, non-destructive, non-interactive commands only.");
    }
    if (
      /\bgit\s+show\s+\S+:[^\s|]+\s*>/.test(script) ||
      /\bgit\s+cat-file\s+-p\s+\S+:[^\s|]+\s*>/.test(script) ||
      /\bgit\s+(?:checkout|restore)\s+[^-\s][^\s]*\s+(?:--\s+)?\S/.test(script)
    ) {
      return shellSafetyBlock("Shell script rejected: git restore of historical content is not allowed.", "Do not use 'git show <ref>:<path> >', 'git cat-file -p <ref>:<path> >', or 'git checkout/restore <ref> -- <path>' to recover deleted files. Implement the file fresh using write_file/apply_patch following the artifacts and brief.");
    }
    if (/\bgit\s+(?:-C\s+\S+\s+)?reset\b/i.test(script)) {
      return { ok: false, summary: "Shell script rejected: git reset is not allowed.", error: "Do not use git reset during coding runs. Use commit_platform_changes with amend: true for task commit repairs, or edit files directly with workspace tools." };
    }
    const hostPackageMutationError = unsafeHostPackageMutation(script);
    if (hostPackageMutationError) {
      return { ok: false, summary: "Shell script rejected by host mutation safety checks.", error: hostPackageMutationError };
    }
    const maskedVerificationError = unsafeMaskedVerification(script);
    if (maskedVerificationError) {
      return shellSafetyBlock("Shell verification rejected by safety checks.", maskedVerificationError);
    }
    if (/(?:>\s*["']?[^&|;\n]*local\.properties\b|tee\s+[^|;\n]*local\.properties\b)/.test(script)) {
      return localPropertiesWriteError();
    }
    const cwdInput = asOptionalString(input, "cwd");
    const cwd = resolveToolCwd(context, cwdInput);
    const outsideMutationError = outsideWorkspaceShellMutationError(script, context.workspace, cwd);
    if (outsideMutationError) {
      return { ok: false, summary: "Shell script rejected: mutation outside workspace.", error: outsideMutationError };
    }
    const timeoutMs = Math.min(asOptionalNumber(input, "timeoutMs", 120_000), 300_000);
    const result = await runShell(script, context, timeoutMs, cwd);
    return maybeFilterTypeScriptErrorResult(result, shellRunsTypeScript(script));
  },
};

export const applyPatchTool: TanyaTool = {
  name: "apply_patch",
  description: "Apply a unified diff patch inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a unified diff patch inside the workspace. Prefer this for existing file edits.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
          stripLevel: { type: "number", description: "Path strip level for patch. Defaults to auto-detect." },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const patch = asString(input, "patch");
    const explicitStrip = asOptionalNumber(input, "stripLevel", Number.NaN);
    const stripLevel = Number.isFinite(explicitStrip) ? explicitStrip : inferPatchStripLevel(patch);
    const files = extractPatchFiles(patch, stripLevel);
    if (files.length === 0) {
      return { ok: false, summary: "Patch contains no file headers.", error: "Expected unified diff headers." };
    }
    try {
      for (const file of files) {
        if (isProtectedLocalConfigPath(file)) return { ...localPropertiesWriteError(), files };
        resolveInsideWorkspace(context.workspace, file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: "Patch rejected by workspace safety checks.", error: message, files };
    }

    const result = await runProcessWithInput(
      "patch",
      [`-p${stripLevel}`, "--batch", "--forward", "--reject-file=-"],
      patch,
      context,
      60_000,
    );
    const output = typeof result.output === "string" ? result.output : "";
    if (!result.ok) {
      return {
        ...result,
        summary: "Patch failed.",
        files,
      };
    }
    const removedBackups = await removePatchBackupFiles(files, context);
    const backupNote = removedBackups.length > 0
      ? ` Removed patch backup file${removedBackups.length === 1 ? "" : "s"}: ${removedBackups.join(", ")}.`
      : "";
    return {
      ok: true,
      summary: `Applied patch to ${files.length} file${files.length === 1 ? "" : "s"}.${backupNote}`,
      output,
      files,
    };
  },
};

export const searchReplaceTool: TanyaTool = {
  name: "search_replace",
  description: "Replace an exact string in a file. Fails if the string is not found or appears more times than expected.",
  definition: {
    type: "function",
    function: {
      name: "search_replace",
      description: "Replace an exact string in a file inside the workspace. Prefer this over apply_patch for targeted single-location edits. Fails if old_string is not found or appears more times than expected_count.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace." },
          old_string: { type: "string", description: "Exact string to find. Must be unique in the file unless expected_count is set." },
          new_string: { type: "string", description: "Replacement string." },
          expected_count: { type: "number", description: "How many occurrences to replace. Default 1. Use to allow replacing multiple occurrences." },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const path = asString(input, "path");
    const oldString = asString(input, "old_string");
    const newString = asRecord(input).new_string;
    if (typeof newString !== "string") throw new Error("Missing string field: new_string");
    const expectedCount = asOptionalNumber(input, "expected_count", 1);
    if (isProtectedLocalConfigPath(path)) return localPropertiesWriteError();
    let abs: string;
    try {
      abs = resolveInsideWorkspace(context.workspace, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: "Path rejected by workspace safety checks.", error: message };
    }
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return { ok: false, summary: `File not found: ${path}`, error: `Cannot read ${path}` };
    }
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return { ok: false, summary: "old_string not found in file.", error: `The exact string was not found in ${path}. Re-read the file and adjust old_string to match exactly.` };
    }
    if (count !== expectedCount) {
      return { ok: false, summary: `old_string appears ${count} time${count === 1 ? "" : "s"}, expected ${expectedCount}.`, error: `Found ${count} occurrence${count === 1 ? "" : "s"} in ${path}. Set expected_count: ${count} to replace all, or make old_string more specific.` };
    }
    const updated = content.split(oldString).join(newString);
    await writeFile(abs, updated, "utf8");
    const written = await readFile(abs, "utf8");
    const lines = written.split("\n");
    const lineCount = lines.length;
    const firstNewLine = newString.split("\n")[0] ?? "";
    const matchNeedle = firstNewLine.trim();
    const matchIdx = matchNeedle
      ? lines.findIndex((line) => line.includes(matchNeedle))
      : -1;
    const contextLines = matchIdx >= 0
      ? lines.slice(Math.max(0, matchIdx - 1), matchIdx + 3).join("\n")
      : "";
    return {
      ok: true,
      summary: `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${path} (${lineCount} lines).`,
      output: { path, count, lineCount, context: contextLines },
      files: [path],
    };
  },
};

export const copyFileTool: TanyaTool = {
  name: "copy_file",
  description: "Copy one file inside the workspace, including binary assets.",
  definition: {
    type: "function",
    function: {
      name: "copy_file",
      description: "Copy one file inside the workspace, including binary assets.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source path relative to the workspace." },
          destination: { type: "string", description: "Destination path relative to the workspace." },
          overwrite: { type: "boolean", description: "Overwrite destination if it exists. Default true." },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const destination = ensureRelativePath(asString(input, "destination"));
    const overwrite = asRecord(input).overwrite !== false;
    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
    await mkdir(dirname(destinationAbs), { recursive: true });
    await cp(sourceAbs, destinationAbs, { force: overwrite, errorOnExist: !overwrite });
    return { ok: true, summary: `Copied ${source} to ${destination}.`, output: { source, destination }, files: [destination] };
  },
};

export const copyDirTool: TanyaTool = {
  name: "copy_dir",
  description: "Copy a directory inside the workspace, including binary assets.",
  definition: {
    type: "function",
    function: {
      name: "copy_dir",
      description: "Copy a directory inside the workspace, including binary assets.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source directory relative to the workspace." },
          destination: { type: "string", description: "Destination directory relative to the workspace." },
          overwrite: { type: "boolean", description: "Overwrite destination files if they exist. Default true." },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const destination = ensureRelativePath(asString(input, "destination"));
    const overwrite = asRecord(input).overwrite !== false;
    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
    await cp(sourceAbs, destinationAbs, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    return { ok: true, summary: `Copied directory ${source} to ${destination}.`, output: { source, destination }, files: [destination] };
  },
};

function parseMarkdownApiRoutes(markdown: string): string[] {
  return [...new Set(
    [...markdown.matchAll(/`(?:GET|POST|PUT|PATCH|DELETE)\s+([^`\s]+)`/g)]
      .map((match) => String(match[1] ?? "").trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

export const validateApiContractRoutesTool: TanyaTool = {
  name: "validate_api_contract_routes",
  description: "Compare HTTP route slugs between two markdown API contract files inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "validate_api_contract_routes",
      description: "Compare HTTP route slugs between two markdown API contract files. Useful for backend/API_FEATURES.md vs brand/api_features.md.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Canonical markdown contract path relative to the workspace." },
          target: { type: "string", description: "Generated markdown contract path relative to the workspace." },
        },
        required: ["source", "target"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const target = ensureRelativePath(asString(input, "target"));
    const sourceText = await readFile(resolveInsideWorkspace(context.workspace, source), "utf8");
    const targetText = await readFile(resolveInsideWorkspace(context.workspace, target), "utf8");
    const sourceRoutes = parseMarkdownApiRoutes(sourceText);
    const targetRoutes = parseMarkdownApiRoutes(targetText);
    const missing = sourceRoutes.filter((route) => !targetRoutes.includes(route));
    const extra = targetRoutes.filter((route) => !sourceRoutes.includes(route));
    const ok = missing.length === 0 && extra.length === 0;
    return {
      ok,
      summary: ok
        ? `API route contracts match (${sourceRoutes.length} route${sourceRoutes.length === 1 ? "" : "s"}).`
        : `API route contract mismatch: ${missing.length} missing, ${extra.length} extra.`,
      output: { source, target, sourceRoutes, targetRoutes, missing, extra },
      ...(ok ? {} : { error: `Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.` }),
    };
  },
};

function numberFromGradle(text: string, name: string): number | null {
  const match = new RegExp(`${name}\\s*(?:=|\\()\\s*(\\d+)`, "m").exec(text);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export const validateAndroidProjectConfigTool: TanyaTool = {
  name: "validate_android_project_config",
  description: "Validate Android Manifest launcher icon references and Gradle SDK levels.",
  definition: {
    type: "function",
    function: {
      name: "validate_android_project_config",
      description: "Validate AndroidManifest.xml launcher icon references and build.gradle(.kts) SDK levels.",
      parameters: {
        type: "object",
        properties: {
          manifestPath: { type: "string", description: "AndroidManifest.xml path relative to the workspace." },
          gradlePath: { type: "string", description: "Module build.gradle or build.gradle.kts path relative to the workspace." },
          minCompileSdk: { type: "number", description: "Minimum compileSdk. Default 35." },
          minTargetSdk: { type: "number", description: "Minimum targetSdk. Default 35." },
          minSdk: { type: "number", description: "Minimum minSdk. Default 26." },
          expectedIcon: { type: "string", description: "Expected android:icon value. Default @mipmap/ic_launcher." },
          expectedRoundIcon: { type: "string", description: "Expected android:roundIcon value. Default @mipmap/ic_launcher_round." },
        },
        required: ["manifestPath", "gradlePath"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const manifestPath = ensureRelativePath(asString(input, "manifestPath"));
    const gradlePath = ensureRelativePath(asString(input, "gradlePath"));
    const minCompileSdk = asOptionalNumber(input, "minCompileSdk", 35);
    const minTargetSdk = asOptionalNumber(input, "minTargetSdk", 35);
    const minSdk = asOptionalNumber(input, "minSdk", 26);
    const expectedIcon = asOptionalString(input, "expectedIcon") ?? "@mipmap/ic_launcher";
    const expectedRoundIcon = asOptionalString(input, "expectedRoundIcon") ?? "@mipmap/ic_launcher_round";
    const manifest = await readFile(resolveInsideWorkspace(context.workspace, manifestPath), "utf8");
    const gradle = await readFile(resolveInsideWorkspace(context.workspace, gradlePath), "utf8");
    const problems: string[] = [];

    if (!new RegExp(`android:icon=["']${expectedIcon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(manifest)) {
      problems.push(`Manifest android:icon must be ${expectedIcon}.`);
    }
    if (!new RegExp(`android:roundIcon=["']${expectedRoundIcon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(manifest)) {
      problems.push(`Manifest android:roundIcon must be ${expectedRoundIcon}.`);
    }

    const compileSdk = numberFromGradle(gradle, "compileSdk");
    const targetSdk = numberFromGradle(gradle, "targetSdk");
    const parsedMinSdk = numberFromGradle(gradle, "minSdk");
    if (compileSdk === null || compileSdk < minCompileSdk) problems.push(`compileSdk must be >= ${minCompileSdk}.`);
    if (targetSdk === null || targetSdk < minTargetSdk) problems.push(`targetSdk must be >= ${minTargetSdk}.`);
    if (parsedMinSdk === null || parsedMinSdk < minSdk) problems.push(`minSdk must be >= ${minSdk}.`);

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? "Android project config validated." : `Android project config has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { manifestPath, gradlePath, compileSdk, targetSdk, minSdk: parsedMinSdk, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validateAppleProjectFilesTool: TanyaTool = {
  name: "validate_apple_project_files",
  description: "Validate basic Apple/Xcode project file presence and optional pbxproj references.",
  definition: {
    type: "function",
    function: {
      name: "validate_apple_project_files",
      description: "Validate Xcode project presence, required files/assets, and optional project.pbxproj references.",
      parameters: {
        type: "object",
        properties: {
          xcodeprojPath: { type: "string", description: "Optional .xcodeproj directory relative to the workspace." },
          requiredPaths: { type: "array", items: { type: "string" }, description: "Files or directories that must exist relative to the workspace." },
          requireProjectReferences: { type: "boolean", description: "Check project.pbxproj contains each required path basename. Default false." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const xcodeprojPath = asOptionalString(input, "xcodeprojPath");
    const requiredPaths = Array.isArray(record.requiredPaths)
      ? record.requiredPaths.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const requireProjectReferences = record.requireProjectReferences === true;
    const problems: string[] = [];
    let pbxprojText = "";

    if (xcodeprojPath) {
      const projectDir = resolveInsideWorkspace(context.workspace, ensureRelativePath(xcodeprojPath));
      if (!existsSync(projectDir)) {
        problems.push(`Missing ${xcodeprojPath}.`);
      } else {
        const pbxprojPath = resolveInsideWorkspace(context.workspace, `${xcodeprojPath.replace(/\/+$/, "")}/project.pbxproj`);
        if (existsSync(pbxprojPath)) pbxprojText = await readFile(pbxprojPath, "utf8");
      }
    }

    for (const requiredPath of requiredPaths) {
      const relPath = ensureRelativePath(requiredPath);
      if (!existsSync(resolveInsideWorkspace(context.workspace, relPath))) {
        problems.push(`Missing ${relPath}.`);
      }
      if (requireProjectReferences && pbxprojText) {
        const basename = relPath.split("/").filter(Boolean).pop() ?? relPath;
        if (!pbxprojText.includes(basename)) problems.push(`project.pbxproj does not reference ${basename}.`);
      }
    }

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? "Apple project files validated." : `Apple project validation found ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { xcodeprojPath, requiredPaths, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validateFastlaneConfigTool: TanyaTool = {
  name: "validate_fastlane_config",
  description: "Validate Fastlane files, required lanes, required files, and optional forbidden files.",
  definition: {
    type: "function",
    function: {
      name: "validate_fastlane_config",
      description: "Validate a Fastlane setup by inspecting Fastfile lane names, required files, and forbidden files such as Gemfile.",
      parameters: {
        type: "object",
        properties: {
          fastfilePath: { type: "string", description: "Fastfile path relative to the workspace. Default fastlane/Fastfile." },
          requiredLanes: { type: "array", items: { type: "string" }, description: "Lane names that must exist, without the lane : prefix." },
          requiredFiles: { type: "array", items: { type: "string" }, description: "Files that must exist relative to the workspace." },
          forbiddenFiles: { type: "array", items: { type: "string" }, description: "Files that must not exist relative to the workspace." },
          requireProjectDirAnchoredToDirname: { type: "boolean", description: "Require File.expand_path(\"..\", __dir__) in Fastfile. Default false." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const fastfilePath = asOptionalString(input, "fastfilePath") ?? "fastlane/Fastfile";
    const requiredLanes = Array.isArray(record.requiredLanes)
      ? record.requiredLanes.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const requiredFiles = Array.isArray(record.requiredFiles)
      ? record.requiredFiles.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const forbiddenFiles = Array.isArray(record.forbiddenFiles)
      ? record.forbiddenFiles.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const requireProjectDirAnchoredToDirname = record.requireProjectDirAnchoredToDirname === true;
    const problems: string[] = [];
    let fastfile = "";

    const fastfileRel = ensureRelativePath(fastfilePath);
    const fastfileAbs = resolveInsideWorkspace(context.workspace, fastfileRel);
    if (!existsSync(fastfileAbs)) {
      problems.push(`Missing ${fastfileRel}.`);
    } else {
      fastfile = await readFile(fastfileAbs, "utf8");
    }

    const lanes = [...new Set([...fastfile.matchAll(/^\s*lane\s+:([A-Za-z0-9_]+)\s+do\b/gm)].map((match) => String(match[1] ?? "")))].sort();
    const platformLanes: string[] = [];
    let currentPlatform: string | null = null;
    for (const line of fastfile.split(/\r?\n/)) {
      const platformMatch = /^\s*platform\s+:([A-Za-z0-9_]+)\s+do\b/.exec(line);
      if (platformMatch) currentPlatform = platformMatch[1] ?? null;
      const laneMatch = /^\s*lane\s+:([A-Za-z0-9_]+)\s+do\b/.exec(line);
      if (currentPlatform && laneMatch?.[1]) platformLanes.push(`${currentPlatform} ${laneMatch[1]}`);
    }
    platformLanes.sort();
    for (const lane of requiredLanes) {
      const normalized = lane.replace(/^:/, "").replace(/[:.]/g, " ").replace(/\s+/g, " ").trim();
      if (normalized.includes(" ")) {
        if (!platformLanes.includes(normalized)) problems.push(`Missing Fastlane platform lane ${normalized}.`);
      } else if (!lanes.includes(normalized)) {
        problems.push(`Missing Fastlane lane :${normalized}.`);
      }
    }
    if (requiredLanes.map((lane) => lane.replace(/^:/, "").trim()).includes("bump")) {
      const lines = fastfile.split(/\r?\n/);
      const bumpIndex = lines.findIndex((line) => /^\s*lane\s+:bump\s+do\b/.test(line));
      if (bumpIndex >= 0) {
        const firstBodyLine = lines.slice(bumpIndex + 1).find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() ?? "";
        if (/^if\s+options\[:version\]/.test(firstBodyLine)) {
          problems.push("Fastlane lane :bump must increment versionCode by default; options[:version] may only control versionName.");
        }
      }
    }
    if (requireProjectDirAnchoredToDirname && !fastfile.includes('File.expand_path("..", __dir__)')) {
      problems.push('Fastfile must anchor Gradle project_dir with File.expand_path("..", __dir__).');
    }
    for (const file of requiredFiles) {
      const relPath = ensureRelativePath(file);
      if (!existsSync(resolveInsideWorkspace(context.workspace, relPath))) problems.push(`Missing ${relPath}.`);
    }
    for (const file of forbiddenFiles) {
      const relPath = ensureRelativePath(file);
      if (existsSync(resolveInsideWorkspace(context.workspace, relPath))) problems.push(`Forbidden file exists: ${relPath}.`);
    }

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? `Fastlane config validated (${lanes.length} lane${lanes.length === 1 ? "" : "s"}).` : `Fastlane config has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { fastfilePath: fastfileRel, lanes, platformLanes, requiredLanes, requiredFiles, forbiddenFiles, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validatePrismaSchemaTool: TanyaTool = {
  name: "validate_prisma_schema",
  description: "Validate Prisma schema model presence and forbidden drift names.",
  definition: {
    type: "function",
    function: {
      name: "validate_prisma_schema",
      description: "Validate required and forbidden Prisma model names in schema.prisma.",
      parameters: {
        type: "object",
        properties: {
          schemaPath: { type: "string", description: "Prisma schema path relative to the workspace. Default prisma/schema.prisma." },
          requiredModels: { type: "array", items: { type: "string" }, description: "Model names that must exist." },
          forbiddenModels: { type: "array", items: { type: "string" }, description: "Model names that must not exist." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const schemaPath = ensureRelativePath(asOptionalString(input, "schemaPath") ?? "prisma/schema.prisma");
    const requiredModels = Array.isArray(record.requiredModels)
      ? record.requiredModels.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const forbiddenModels = Array.isArray(record.forbiddenModels)
      ? record.forbiddenModels.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const schema = await readFile(resolveInsideWorkspace(context.workspace, schemaPath), "utf8");
    const models = [...schema.matchAll(/^\s*model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{/gm)].map((match) => String(match[1]));
    const problems: string[] = [];
    for (const model of requiredModels) if (!models.includes(model)) problems.push(`Missing model ${model}.`);
    for (const model of forbiddenModels) if (models.includes(model)) problems.push(`Forbidden model ${model} is present.`);
    const openModelBlocks = (schema.match(/\bmodel\s+[A-Za-z][A-Za-z0-9_]*\s*\{/g) ?? []).length;
    const closeBraces = (schema.match(/\}/g) ?? []).length;
    if (closeBraces < openModelBlocks) problems.push("Schema appears to have an unclosed model block.");

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? `Prisma schema validated (${models.length} model${models.length === 1 ? "" : "s"}).` : `Prisma schema has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { schemaPath, models, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const applyArtifactTool: TanyaTool = {
  name: "apply_artifact",
  description: "Copy a materialized artifact file or directory to a target path inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "apply_artifact",
      description: "Apply a local materialized artifact by copying it to a target path. Use after reading an artifact that should become the starting point for an implementation.",
      parameters: {
        type: "object",
        properties: {
          artifactPath: { type: "string", description: "Materialized artifact path relative to the workspace, for example .tania/artifacts/ios/Foo.swift." },
          targetPath: { type: "string", description: "Target file or directory path relative to the workspace." },
          overwrite: { type: "boolean", description: "Overwrite target if it exists. Default true." },
        },
        required: ["artifactPath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const artifactPath = ensureRelativePath(asString(input, "artifactPath"));
    const targetPath = ensureRelativePath(asString(input, "targetPath"));
    if (isProtectedLocalConfigPath(targetPath)) return localPropertiesWriteError();
    const overwrite = asRecord(input).overwrite !== false;
    const sourceAbs = resolveInsideWorkspace(context.workspace, artifactPath);
    const targetAbs = resolveInsideWorkspace(context.workspace, targetPath);
    await mkdir(dirname(targetAbs), { recursive: true });
    await cp(sourceAbs, targetAbs, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    return {
      ok: true,
      summary: `Applied artifact ${artifactPath} to ${targetPath}.`,
      output: { artifactPath, targetPath },
      files: [targetPath],
    };
  },
};

function inferIosSplashAssetSetDir(viewPath: string): string {
  const viewDir = dirname(viewPath).replace(/\\/g, "/");
  return `${viewDir}/Assets.xcassets/SplashIcon.imageset`;
}

async function firstExistingWorkspacePath(context: ToolContext, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const clean = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = resolveInsideWorkspace(context.workspace, clean);
    if (await pathExists(abs)) return clean;
  }
  return null;
}

async function findLargestAppIconPng(context: ToolContext, viewPath: string): Promise<string | null> {
  const viewDir = dirname(viewPath).replace(/\\/g, "/");
  const appIconDir = `${viewDir}/Assets.xcassets/AppIcon.appiconset`;
  const appIconAbs = resolveInsideWorkspace(context.workspace, appIconDir);
  if (!existsSync(appIconAbs)) return null;
  const pngs = readdirSync(appIconAbs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
    .map((entry) => `${appIconDir}/${entry.name}`);
  if (pngs.length === 0) return null;
  const score = (path: string) => {
    const size = path.match(/(\d{2,4})x\1|-(\d{2,4})\.png|@(\d)x/i);
    return Number(size?.[1] ?? size?.[2] ?? size?.[3] ?? 0);
  };
  return pngs.sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function createFallbackSplashIconPng(destinationAbs: string, brandHex: string, appName: string): Promise<void> {
  const label = appName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "A";
  const safeLabel = label.replace(/[<>&"]/g, "");
  const safeBrand = /^#[0-9a-f]{6}$/i.test(brandHex) ? brandHex : "#000000";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">`,
    `<rect width="1024" height="1024" rx="220" fill="${safeBrand}"/>`,
    `<circle cx="512" cy="512" r="312" fill="rgba(0,0,0,0.28)"/>`,
    `<circle cx="512" cy="512" r="244" fill="rgba(255,255,255,0.12)"/>`,
    `<text x="512" y="570" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="260" font-weight="800" fill="#ffffff">${safeLabel}</text>`,
    `</svg>`,
  ].join("");
  await mkdir(dirname(destinationAbs), { recursive: true });
  await sharp(Buffer.from(svg)).png({ force: true }).toFile(destinationAbs);
}

export const createIosSplashTool: TanyaTool = {
  name: "create_ios_splash",
  description: "Create a standard SwiftUI iOS splash view and SplashIcon asset from a source image or deterministic fallback.",
  definition: {
    type: "function",
    function: {
      name: "create_ios_splash",
      description: "Create SplashScreenView.swift and Assets.xcassets/SplashIcon.imageset resources using explicit brand color.",
      parameters: {
        type: "object",
        properties: {
          viewPath: { type: "string", description: "Destination Swift file, for example CosaNostra/SplashScreenView.swift." },
          assetSetDir: { type: "string", description: "Optional SplashIcon.imageset directory relative to workspace. Defaults beside viewPath under Assets.xcassets." },
          sourceIcon: { type: "string", description: "Optional source image path relative to workspace. If omitted, Tanya searches common brand/AppIcon paths, then creates a fallback PNG." },
          appName: { type: "string", description: "Optional app name shown below the icon." },
          brandHex: { type: "string", description: "Brand background color, for example #A52A2A. Default #000000." },
          durationMs: { type: "number", description: "Splash delay in milliseconds. Default 1200." },
        },
        required: ["viewPath"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const viewPath = ensureRelativePath(asString(input, "viewPath"));
    const assetSetDir = (asOptionalString(input, "assetSetDir") ?? inferIosSplashAssetSetDir(viewPath)).replace(/\/+$/, "");
    const sourceIcon = asOptionalString(input, "sourceIcon");
    const appName = asOptionalString(input, "appName") ?? "App";
    const brandHex = asOptionalString(input, "brandHex") ?? "#000000";
    const durationMs = Math.max(0, Math.round(asOptionalNumber(input, "durationMs", 1200)));
    const durationNs = durationMs * 1_000_000;
    const rgb = brandHex.replace("#", "").match(/.{1,2}/g)?.slice(0, 3).map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0];
    const view = [
      "import SwiftUI",
      "",
      "struct SplashScreenView<Content: View>: View {",
      "    @State private var isReady = false",
      "    @State private var iconVisible = false",
      "    let content: () -> Content",
      "",
      "    private let brandColor = Color(",
      `        red: ${rgb[0] ?? 0} / 255,`,
      `        green: ${rgb[1] ?? 0} / 255,`,
      `        blue: ${rgb[2] ?? 0} / 255`,
      "    )",
      "",
      "    var body: some View {",
      "        ZStack {",
      "            if isReady {",
      "                content()",
      "            } else {",
      "                brandColor",
      "                    .ignoresSafeArea()",
      "                    .overlay(",
      "                        Image(\"SplashIcon\")",
      "                            .resizable()",
      "                            .scaledToFit()",
      "                            .frame(width: 120, height: 120)",
      "                            .opacity(iconVisible ? 1 : 0)",
      "                            .animation(.easeOut(duration: 0.6), value: iconVisible)",
      "                            .accessibilityLabel(\"" + appName.replace(/"/g, "\\\"") + "\")",
      "                    )",
      "            }",
      "        }",
      "        .onAppear {",
      "            iconVisible = true",
      "            Task {",
      `                try? await Task.sleep(nanoseconds: ${durationNs})`,
      "                isReady = true",
      "            }",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");

    const viewAbs = resolveInsideWorkspace(context.workspace, viewPath);
    await mkdir(dirname(viewAbs), { recursive: true });
    await writeFile(viewAbs, view, "utf8");
    const files = [viewPath];

    const cleanAssetSetDir = ensureRelativePath(assetSetDir);
    const iconPath = `${cleanAssetSetDir}/SplashIcon.png`;
    const resolvedSourceIcon = sourceIcon
      ? sourceIcon
      : await firstExistingWorkspacePath(context, [
        "brand/icons/icon-1024.png",
        "brand/icons/ios/AppStore-1024x1024.png",
        ".tania/context/brand/icons/icon-1024.png",
        ".tania/context/brand/icons/ios/AppStore-1024x1024.png",
      ]) ?? await findLargestAppIconPng(context, viewPath);

    if (resolvedSourceIcon) {
      const sourceAbs = isAbsolute(resolvedSourceIcon)
        ? resolvedSourceIcon
        : resolveInsideWorkspace(context.workspace, ensureRelativePath(resolvedSourceIcon));
      if (!existsSync(sourceAbs)) {
        return { ok: false, summary: "Source splash icon not found.", error: `Missing source icon: ${resolvedSourceIcon}` };
      }
      await mkdir(dirname(resolveInsideWorkspace(context.workspace, iconPath)), { recursive: true });
      await sharp(sourceAbs)
        .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(resolveInsideWorkspace(context.workspace, iconPath));
    } else {
      await createFallbackSplashIconPng(resolveInsideWorkspace(context.workspace, iconPath), brandHex, appName);
    }
    const contentsPath = `${cleanAssetSetDir}/Contents.json`;
    await mkdir(dirname(resolveInsideWorkspace(context.workspace, contentsPath)), { recursive: true });
    await writeFile(resolveInsideWorkspace(context.workspace, contentsPath), `${JSON.stringify({
      images: [{ idiom: "universal", filename: "SplashIcon.png", scale: "1x" }],
      info: { author: "xcode", version: 1 },
    }, null, 2)}\n`, "utf8");
    files.push(iconPath, contentsPath);

    return { ok: true, summary: `Created iOS splash view and SplashIcon asset at ${viewPath}.`, output: { viewPath, assetSetDir, sourceIcon: resolvedSourceIcon ?? "generated-fallback", brandHex, durationMs, appName }, files };
  },
};

export const createAndroidSplashTool: TanyaTool = {
  name: "create_android_splash",
  description: "Create Android SplashScreen API resources and optional drawable icon from a source image.",
  definition: {
    type: "function",
    function: {
      name: "create_android_splash",
      description: "Create splash_theme.xml and a drawable PNG for Android SplashScreen API wiring.",
      parameters: {
        type: "object",
        properties: {
          resDir: { type: "string", description: "Android res directory, for example app/src/main/res." },
          sourceIcon: { type: "string", description: "Optional source image path relative to workspace." },
          brandHex: { type: "string", description: "Brand background color. Default #000000." },
          themeName: { type: "string", description: "Splash theme name. Default Theme.App.Starting." },
          iconName: { type: "string", description: "Drawable icon resource name. Default ic_splash_logo." },
        },
        required: ["resDir"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const resDir = ensureRelativePath(asString(input, "resDir")).replace(/\/+$/, "");
    const sourceIcon = asOptionalString(input, "sourceIcon");
    const brandHex = asOptionalString(input, "brandHex") ?? "#000000";
    const themeName = asOptionalString(input, "themeName") ?? "Theme.App.Starting";
    const iconName = (asOptionalString(input, "iconName") ?? "ic_splash_logo").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    const valuesPath = `${resDir}/values/splash_theme.xml`;
    const drawablePath = `${resDir}/drawable/${iconName}.png`;
    const xml = [
      "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
      "<resources>",
      `    <style name="${themeName}" parent="Theme.SplashScreen">`,
      `        <item name="windowSplashScreenBackground">${brandHex}</item>`,
      `        <item name="windowSplashScreenAnimatedIcon">@drawable/${iconName}</item>`,
      "        <item name=\"postSplashScreenTheme\">@style/Theme.App</item>",
      "    </style>",
      "</resources>",
      "",
    ].join("\n");
    await mkdir(dirname(resolveInsideWorkspace(context.workspace, valuesPath)), { recursive: true });
    await writeFile(resolveInsideWorkspace(context.workspace, valuesPath), xml, "utf8");
    const files = [valuesPath];
    if (sourceIcon) {
      const resizeResult = await resizeImageTool.run(
        { source: ensureRelativePath(sourceIcon), destination: drawablePath, width: 432, height: 432, background: "transparent" },
        context,
      );
      if (!resizeResult.ok) return resizeResult;
      files.push(drawablePath);
    }
    return { ok: true, summary: `Created Android splash resources in ${resDir}.`, output: { resDir, themeName, iconName, brandHex }, files };
  },
};

export const generateAppIconsTool: TanyaTool = {
  name: "generate_app_icons",
  description: "Generate Apple and/or Android app icon resources from one source image.",
  definition: {
    type: "function",
    function: {
      name: "generate_app_icons",
      description: "Generate app icon resources for Apple AppIcon.appiconset and Android launcher icons.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source image path relative to workspace. Prefer 1024x1024 PNG." },
          appleOutputDir: { type: "string", description: "Optional AppIcon.appiconset output directory." },
          applePlatforms: { type: "array", items: { type: "string", enum: ["ios", "macos"] }, description: "Apple platforms. Default ['ios', 'macos']." },
          androidResDir: { type: "string", description: "Optional Android res output directory." },
          background: { type: "string", description: "Background color used to remove alpha. Default #ffffff." },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const appleOutputDir = asOptionalString(input, "appleOutputDir");
    const androidResDir = asOptionalString(input, "androidResDir");
    const background = asOptionalString(input, "background") ?? "#ffffff";
    const rawApplePlatforms = asRecord(input).applePlatforms;
    const applePlatforms = Array.isArray(rawApplePlatforms)
      ? rawApplePlatforms.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : ["ios", "macos"];
    const files: string[] = [];
    const outputs: Record<string, unknown> = {};

    if (appleOutputDir) {
      const result = await createAppleAppIconSetTool.run({ source, outputDir: ensureRelativePath(appleOutputDir), platforms: applePlatforms, background }, context);
      if (!result.ok) return result;
      files.push(...(result.files ?? []));
      outputs.apple = result.output;
    }
    if (androidResDir) {
      const result = await createAndroidLauncherIconSetTool.run({ source, resDir: ensureRelativePath(androidResDir), background }, context);
      if (!result.ok) return result;
      files.push(...(result.files ?? []));
      outputs.android = result.output;
    }
    if (!appleOutputDir && !androidResDir) {
      return { ok: false, summary: "No app icon output selected.", error: "Provide appleOutputDir, androidResDir, or both." };
    }

    return { ok: true, summary: `Generated ${files.length} app icon resource file${files.length === 1 ? "" : "s"}.`, output: outputs, files };
  },
};

function packageToDir(packageName: string): string {
  return packageName.split(".").map((part) => part.replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).join("/");
}

function kotlinIdentifier(input: string, fallback: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_]/g, "").replace(/^[0-9]+/, "");
  return cleaned || fallback;
}

function addLineBeforeClosingPluginsBlock(gradle: string, line: string): string {
  if (gradle.includes(line)) return gradle;
  return gradle.replace(/plugins\s*\{([\s\S]*?)\n\}/, (match, body) => `plugins {${body}\n    ${line}\n}`);
}

function addDependencyLine(gradle: string, line: string): string {
  if (gradle.includes(line)) return gradle;
  return gradle.replace(/dependencies\s*\{/, `dependencies {\n    ${line}`);
}

async function maybePatchAndroidGradle(context: ToolContext, rootGradlePath: string, moduleGradlePath: string): Promise<string[]> {
  const files: string[] = [];
  const rootAbs = resolveInsideWorkspace(context.workspace, rootGradlePath);
  if (existsSync(rootAbs)) {
    const rootGradle = await readFile(rootAbs, "utf8");
    const nextRootGradle = addLineBeforeClosingPluginsBlock(rootGradle, "id(\"com.google.devtools.ksp\") version \"1.9.24-1.0.20\" apply false");
    if (nextRootGradle !== rootGradle) {
      await writeFile(rootAbs, nextRootGradle, "utf8");
      files.push(rootGradlePath);
    }
  }

  const moduleAbs = resolveInsideWorkspace(context.workspace, moduleGradlePath);
  if (existsSync(moduleAbs)) {
    let moduleGradle = await readFile(moduleAbs, "utf8");
    const before = moduleGradle;
    moduleGradle = addLineBeforeClosingPluginsBlock(moduleGradle, "id(\"com.google.devtools.ksp\")");
    for (const dependency of [
      "implementation(\"androidx.navigation:navigation-compose:2.8.3\")",
      "implementation(\"androidx.compose.material:material-icons-extended\")",
      "implementation(\"androidx.room:room-runtime:2.6.1\")",
      "implementation(\"androidx.room:room-ktx:2.6.1\")",
      "ksp(\"androidx.room:room-compiler:2.6.1\")",
    ]) {
      moduleGradle = addDependencyLine(moduleGradle, dependency);
    }
    if (moduleGradle !== before) {
      await writeFile(moduleAbs, moduleGradle, "utf8");
      files.push(moduleGradlePath);
    }
  }
  return files;
}

export const createAndroidFoundationTool: TanyaTool = {
  name: "create_android_foundation",
  description: "Create a generic Kotlin/Compose Android foundation with Material 3 theme, Navigation Compose, Room, and base UI states.",
  definition: {
    type: "function",
    function: {
      name: "create_android_foundation",
      description: "Create deterministic Android foundation files for a Kotlin/Compose app. Optionally updates Gradle with Navigation Compose and Room/KSP dependencies.",
      parameters: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "Android package name, for example com.example.app." },
          appName: { type: "string", description: "Human app name. Default App." },
          sourceRoot: { type: "string", description: "Kotlin source root. Default app/src/main/java." },
          rootGradlePath: { type: "string", description: "Root build.gradle.kts path. Default build.gradle.kts." },
          moduleGradlePath: { type: "string", description: "App module build.gradle.kts path. Default app/build.gradle.kts." },
          brandPrimaryHex: { type: "string", description: "Primary brand color, for example #A52A2A. Default #A52A2A." },
          brandSecondaryHex: { type: "string", description: "Secondary brand color. Default #2D3748." },
          updateGradle: { type: "boolean", description: "Update Gradle plugins/dependencies. Default true." },
          preserveExisting: { type: "boolean", description: "Preserve existing foundation source files instead of overwriting them. Default true." },
          overwriteExisting: { type: "boolean", description: "Overwrite existing foundation source files. Default false." },
        },
        required: ["packageName"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const packageName = asString(input, "packageName").trim();
    const appName = asOptionalString(input, "appName") ?? "App";
    const sourceRoot = ensureRelativePath(asOptionalString(input, "sourceRoot") ?? "app/src/main/java").replace(/\/+$/, "");
    const rootGradlePath = ensureRelativePath(asOptionalString(input, "rootGradlePath") ?? "build.gradle.kts");
    const moduleGradlePath = ensureRelativePath(asOptionalString(input, "moduleGradlePath") ?? "app/build.gradle.kts");
    const brandPrimaryHex = (asOptionalString(input, "brandPrimaryHex") ?? "#A52A2A").replace(/^#?/, "0xFF");
    const brandSecondaryHex = (asOptionalString(input, "brandSecondaryHex") ?? "#2D3748").replace(/^#?/, "0xFF");
    const updateGradle = asOptionalBoolean(input, "updateGradle", true);
    const overwriteExisting = asOptionalBoolean(input, "overwriteExisting", false);
    const preserveExisting = overwriteExisting ? false : asOptionalBoolean(input, "preserveExisting", true);
    const packageDir = packageToDir(packageName);
    if (!packageDir) return { ok: false, summary: "Invalid package name.", error: "packageName must contain at least one valid package segment." };

    const classPrefix = kotlinIdentifier(appName, "App");
    const baseDir = `${sourceRoot}/${packageDir}`;
    const files: string[] = [];
    const outputs: Array<[string, string]> = [
      [`${baseDir}/ui/theme/AppTheme.kt`, buildAndroidThemeFile(packageName, brandPrimaryHex, brandSecondaryHex)],
      [`${baseDir}/navigation/AppNavigation.kt`, buildAndroidNavigationFile(packageName)],
      [`${baseDir}/data/AppDatabase.kt`, buildAndroidDatabaseFile(packageName, classPrefix)],
      [`${baseDir}/ui/components/FoundationStates.kt`, buildAndroidFoundationStatesFile(packageName)],
    ];

    for (const [path, content] of outputs) {
      const target = resolveInsideWorkspace(context.workspace, path);
      if (preserveExisting && existsSync(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      files.push(path);
    }
    if (updateGradle) files.push(...await maybePatchAndroidGradle(context, rootGradlePath, moduleGradlePath));

    return {
      ok: true,
      summary: preserveExisting
        ? `Created missing Android foundation files for ${packageName}; preserved existing source files.`
        : `Created Android foundation for ${packageName}.`,
      output: { packageName, appName, sourceRoot, updateGradle, preserveExisting },
      files,
    };
  },
};

function buildAndroidThemeFile(packageName: string, brandPrimaryHex: string, brandSecondaryHex: string): string {
  return [
    `package ${packageName}.ui.theme`,
    "",
    "import android.os.Build",
    "import androidx.compose.foundation.isSystemInDarkTheme",
    "import androidx.compose.material3.MaterialTheme",
    "import androidx.compose.material3.Typography",
    "import androidx.compose.material3.darkColorScheme",
    "import androidx.compose.material3.dynamicDarkColorScheme",
    "import androidx.compose.material3.dynamicLightColorScheme",
    "import androidx.compose.material3.lightColorScheme",
    "import androidx.compose.runtime.Composable",
    "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.platform.LocalContext",
    "",
    "object BrandColors {",
    `    val Primary = Color(${brandPrimaryHex})`,
    `    val Secondary = Color(${brandSecondaryHex})`,
    "    val Background = Color(0xFF0B0B0F)",
    "    val Surface = Color(0xFF16161D)",
    "    val OnPrimary = Color.White",
    "    val OnBackground = Color(0xFFF8FAFC)",
    "    val OnSurface = Color(0xFFE5E7EB)",
    "}",
    "",
    "private val DarkColors = darkColorScheme(",
    "    primary = BrandColors.Primary,",
    "    secondary = BrandColors.Secondary,",
    "    background = BrandColors.Background,",
    "    surface = BrandColors.Surface,",
    "    onPrimary = BrandColors.OnPrimary,",
    "    onBackground = BrandColors.OnBackground,",
    "    onSurface = BrandColors.OnSurface,",
    ")",
    "",
    "private val LightColors = lightColorScheme(",
    "    primary = BrandColors.Primary,",
    "    secondary = BrandColors.Secondary,",
    ")",
    "",
    "@Composable",
    "fun AppTheme(",
    "    darkTheme: Boolean = isSystemInDarkTheme(),",
    "    dynamicColor: Boolean = false,",
    "    content: @Composable () -> Unit,",
    ") {",
    "    val colorScheme = when {",
    "        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {",
    "            val context = LocalContext.current",
    "            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)",
    "        }",
    "        darkTheme -> DarkColors",
    "        else -> LightColors",
    "    }",
    "",
    "    MaterialTheme(",
    "        colorScheme = colorScheme,",
    "        typography = Typography(),",
    "        content = content,",
    "    )",
    "}",
    "",
  ].join("\n");
}

function buildAndroidNavigationFile(packageName: string): string {
  return [
    `package ${packageName}.navigation`,
    "",
    "import androidx.compose.foundation.layout.padding",
    "import androidx.compose.material.icons.Icons",
    "import androidx.compose.material.icons.filled.Home",
    "import androidx.compose.material.icons.filled.List",
    "import androidx.compose.material.icons.filled.Settings",
    "import androidx.compose.material3.Icon",
    "import androidx.compose.material3.NavigationBar",
    "import androidx.compose.material3.NavigationBarItem",
    "import androidx.compose.material3.Scaffold",
    "import androidx.compose.material3.Text",
    "import androidx.compose.runtime.Composable",
    "import androidx.compose.runtime.getValue",
    "import androidx.compose.ui.Modifier",
    "import androidx.compose.ui.graphics.vector.ImageVector",
    "import androidx.navigation.NavHostController",
    "import androidx.navigation.compose.NavHost",
    "import androidx.navigation.compose.composable",
    "import androidx.navigation.compose.currentBackStackEntryAsState",
    "import androidx.navigation.compose.rememberNavController",
    `import ${packageName}.ui.components.EmptyState`,
    "",
    "sealed class AppRoute(val path: String, val label: String, val icon: ImageVector) {",
    "    data object Home : AppRoute(\"home\", \"Home\", Icons.Filled.Home)",
    "    data object Features : AppRoute(\"features\", \"Features\", Icons.Filled.List)",
    "    data object Settings : AppRoute(\"settings\", \"Settings\", Icons.Filled.Settings)",
    "}",
    "",
    "private val bottomNavItems = listOf(AppRoute.Home, AppRoute.Features, AppRoute.Settings)",
    "",
    "@Composable",
    "fun AppScaffold() {",
    "    val navController = rememberNavController()",
    "    val backStackEntry by navController.currentBackStackEntryAsState()",
    "    val currentPath = backStackEntry?.destination?.route",
    "",
    "    Scaffold(",
    "        bottomBar = {",
    "            NavigationBar {",
    "                bottomNavItems.forEach { route ->",
    "                    NavigationBarItem(",
    "                        selected = currentPath == route.path,",
    "                        onClick = {",
    "                            navController.navigate(route.path) {",
    "                                popUpTo(navController.graph.startDestinationId) { saveState = true }",
    "                                launchSingleTop = true",
    "                                restoreState = true",
    "                            }",
    "                        },",
    "                        icon = { Icon(route.icon, contentDescription = route.label) },",
    "                        label = { Text(route.label) },",
    "                    )",
    "                }",
    "            }",
    "        },",
    "    ) { padding ->",
    "        AppNavHost(navController = navController, modifier = Modifier.padding(padding))",
    "    }",
    "}",
    "",
    "@Composable",
    "fun AppNavHost(navController: NavHostController, modifier: Modifier = Modifier) {",
    "    NavHost(navController = navController, startDestination = AppRoute.Home.path, modifier = modifier) {",
    "        composable(AppRoute.Home.path) { EmptyState(title = \"Home\", message = \"Foundation ready\") }",
    "        composable(AppRoute.Features.path) { EmptyState(title = \"Features\", message = \"Add feature screens here\") }",
    "        composable(AppRoute.Settings.path) { EmptyState(title = \"Settings\", message = \"Configure preferences here\") }",
    "    }",
    "}",
    "",
  ].join("\n");
}

function buildAndroidDatabaseFile(packageName: string, classPrefix: string): string {
  return [
    `package ${packageName}.data`,
    "",
    "import android.content.Context",
    "import androidx.room.Dao",
    "import androidx.room.Database",
    "import androidx.room.Entity",
    "import androidx.room.Insert",
    "import androidx.room.OnConflictStrategy",
    "import androidx.room.PrimaryKey",
    "import androidx.room.Query",
    "import androidx.room.Room",
    "import androidx.room.RoomDatabase",
    "import kotlinx.coroutines.flow.Flow",
    "",
    "@Entity(tableName = \"local_items\")",
    "data class LocalItemEntity(",
    "    @PrimaryKey(autoGenerate = true) val id: Long = 0,",
    "    val title: String,",
    "    val createdAt: Long = System.currentTimeMillis(),",
    "    val updatedAt: Long = System.currentTimeMillis(),",
    "    val isDeleted: Boolean = false,",
    ")",
    "",
    "@Dao",
    "interface LocalItemDao {",
    "    @Query(\"SELECT * FROM local_items WHERE isDeleted = 0 ORDER BY createdAt DESC\")",
    "    fun observeAll(): Flow<List<LocalItemEntity>>",
    "",
    "    @Insert(onConflict = OnConflictStrategy.REPLACE)",
    "    suspend fun upsert(item: LocalItemEntity): Long",
    "",
    "    @Query(\"UPDATE local_items SET isDeleted = 1, updatedAt = :now WHERE id = :id\")",
    "    suspend fun softDelete(id: Long, now: Long = System.currentTimeMillis())",
    "}",
    "",
    "@Database(",
    "    entities = [LocalItemEntity::class],",
    "    version = 1,",
    "    exportSchema = true,",
    ")",
    "abstract class AppDatabase : RoomDatabase() {",
    "    abstract fun localItemDao(): LocalItemDao",
    "",
    "    companion object {",
    "        @Volatile",
    "        private var instance: AppDatabase? = null",
    "",
    "        fun getInstance(context: Context): AppDatabase =",
    "            instance ?: synchronized(this) {",
    "                instance ?: Room.databaseBuilder(",
    "                    context.applicationContext,",
    "                    AppDatabase::class.java,",
    `                    "${classPrefix.toLowerCase()}_database",`,
    "                )",
    "                    .fallbackToDestructiveMigration()",
    "                    .build()",
    "                    .also { instance = it }",
    "            }",
    "    }",
    "}",
    "",
  ].join("\n");
}

function buildAndroidFoundationStatesFile(packageName: string): string {
  return [
    `package ${packageName}.ui.components`,
    "",
    "import androidx.compose.foundation.layout.Arrangement",
    "import androidx.compose.foundation.layout.Box",
    "import androidx.compose.foundation.layout.Column",
    "import androidx.compose.foundation.layout.fillMaxSize",
    "import androidx.compose.foundation.layout.padding",
    "import androidx.compose.material3.Button",
    "import androidx.compose.material3.CircularProgressIndicator",
    "import androidx.compose.material3.MaterialTheme",
    "import androidx.compose.material3.Text",
    "import androidx.compose.runtime.Composable",
    "import androidx.compose.ui.Alignment",
    "import androidx.compose.ui.Modifier",
    "import androidx.compose.ui.unit.dp",
    "",
    "@Composable",
    "fun LoadingState(modifier: Modifier = Modifier) {",
    "    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {",
    "        CircularProgressIndicator()",
    "    }",
    "}",
    "",
    "@Composable",
    "fun EmptyState(",
    "    title: String,",
    "    message: String,",
    "    modifier: Modifier = Modifier,",
    ") {",
    "    Column(",
    "        modifier = modifier.fillMaxSize().padding(24.dp),",
    "        horizontalAlignment = Alignment.CenterHorizontally,",
    "        verticalArrangement = Arrangement.Center,",
    "    ) {",
    "        Text(text = title, style = MaterialTheme.typography.headlineSmall)",
    "        Text(text = message, style = MaterialTheme.typography.bodyMedium)",
    "    }",
    "}",
    "",
    "@Composable",
    "fun ErrorState(",
    "    message: String,",
    "    onRetry: () -> Unit,",
    "    modifier: Modifier = Modifier,",
    ") {",
    "    Column(",
    "        modifier = modifier.fillMaxSize().padding(24.dp),",
    "        horizontalAlignment = Alignment.CenterHorizontally,",
    "        verticalArrangement = Arrangement.Center,",
    "    ) {",
    "        Text(text = message, color = MaterialTheme.colorScheme.error)",
    "        Button(onClick = onRetry) { Text(\"Retry\") }",
    "    }",
    "}",
    "",
  ].join("\n");
}

export const commitPlatformChangesTool: TanyaTool = {
  name: "commit_platform_changes",
  description: "Stage selected files and create a git commit from the workspace or repository root.",
  definition: {
    type: "function",
    function: {
      name: "commit_platform_changes",
      description: "Stage explicit changed files and create a git commit. Use this instead of hand-written git add/commit shell commands when possible.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Files to stage, relative to the workspace." },
          message: { type: "string", description: "Commit message." },
          amend: { type: "boolean", description: "If true, amend the current HEAD with these staged paths instead of creating a new commit." },
        },
        required: ["files", "message"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const message = asString(input, "message");
    const amend = asOptionalBoolean(input, "amend", false);
    const record = asRecord(input);
    const rawPaths = Array.isArray(record.files) ? record.files : record.paths;
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0).map(ensureRelativePath)
      : [];
    if (paths.length === 0) return { ok: false, summary: "No paths provided for commit.", error: "Provide at least one path to stage." };
    for (const path of paths) if (isProtectedLocalConfigPath(path)) return localPropertiesWriteError();

    const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], context, 20_000);
    if (!rootResult.ok || typeof rootResult.output !== "string") {
      return { ok: false, summary: "Could not resolve git root.", error: rootResult.error ?? String(rootResult.output ?? "") };
    }
    const repoRoot = rootResult.output.split(/\r?\n/)[0]?.trim();
    if (!repoRoot) return { ok: false, summary: "Could not resolve git root.", error: "git rev-parse returned empty output." };
    const realRepoRoot = await realpath(repoRoot);
    const realWorkspace = await realpath(context.workspace);
    const repoPaths = await Promise.all(paths.map(async (path) => {
      const cleanPath = normalizeRelativePathForGit(path);
      const workspaceCandidate = resolveInsideWorkspace(realWorkspace, cleanPath);
      const repoCandidate = resolveInsideWorkspace(realRepoRoot, cleanPath);
      if (existsSync(repoCandidate)) return relative(realRepoRoot, await realpath(repoCandidate)).replace(/\\/g, "/");
      if (existsSync(workspaceCandidate)) return relative(realRepoRoot, await realpath(workspaceCandidate)).replace(/\\/g, "/");
      const workspacePrefix = normalizeRelativePathForGit(relative(realRepoRoot, realWorkspace));
      if (workspacePrefix && workspacePrefix !== "." && (cleanPath === workspacePrefix || cleanPath.startsWith(`${workspacePrefix}/`))) return cleanPath;
      const workspaceRelative = normalizeRelativePathForGit(relative(realRepoRoot, workspaceCandidate));
      if (!workspaceRelative.startsWith("../") && workspaceRelative !== "..") return workspaceRelative;
      return cleanPath;
    }));
    if (repoPaths.some((path) => path === ".." || path.startsWith("../"))) {
      return { ok: false, summary: "Commit paths rejected.", error: "All commit paths must be inside the git repository root." };
    }
    const addResult = await runProcess("git", ["add", ...repoPaths], context, 60_000, realRepoRoot);
    if (!addResult.ok) return { ...addResult, summary: "git add failed.", files: paths };
    const commitArgs = amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message];
    const commitResult = await runProcess("git", commitArgs, context, 60_000, realRepoRoot);
    if (!commitResult.ok) return { ...commitResult, summary: "git commit failed.", files: paths };
    const headResult = await runProcess("git", ["rev-parse", "--short", "HEAD"], context, 20_000, realRepoRoot);
    return {
      ok: true,
      summary: `${amend ? "Amended commit with" : "Committed"} ${paths.length} path${paths.length === 1 ? "" : "s"}.`,
      output: { repoRoot: realRepoRoot, head: typeof headResult.output === "string" ? headResult.output.trim().split(/\r?\n/)[0] : null, message, amend },
      files: paths,
    };
  },
};

const secretFileExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".env", ".example", ".md", ".swift", ".kt", ".kts", ".gradle", ".rb", ".yml", ".yaml"]);

function looksLikeSecret(line: string): boolean {
  if (/placeholder|example|changeme|your_|<[^>]+>|\$\{|process\.env|env\(/i.test(line)) return false;
  return /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|database_url)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i.test(line);
}

export const scanSecretsTool: TanyaTool = {
  name: "scan_secrets",
  description: "Scan workspace text files for likely hardcoded secrets.",
  definition: {
    type: "function",
    function: {
      name: "scan_secrets",
      description: "Scan workspace text files for likely hardcoded secrets while ignoring obvious placeholders.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace. Default workspace root." },
          maxFiles: { type: "number", description: "Maximum files to scan. Default 500." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const scanPath = asOptionalString(input, "path");
    const maxFiles = Math.min(asOptionalNumber(input, "maxFiles", 500), 2000);
    const root = scanPath ? resolveInsideWorkspace(context.workspace, ensureRelativePath(scanPath)) : context.workspace;
    const files = collectFiles(root, maxFiles);
    const findings: Array<{ file: string; line: number; key: string }> = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      if (!secretFileExtensions.has(lower.slice(lower.lastIndexOf(".")))) continue;
      let text = "";
      try {
        text = await readFile(resolveInsideWorkspace(root, file), "utf8");
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        if (!looksLikeSecret(line)) return;
        const key = line.match(/\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|database_url)[A-Za-z0-9_-]*)\b/i)?.[1] ?? "secret";
        findings.push({ file: scanPath ? `${scanPath.replace(/\/+$/, "")}/${file}` : file, line: index + 1, key });
      });
    }

    return {
      ok: findings.length === 0,
      summary: findings.length === 0 ? "No likely hardcoded secrets found." : `Found ${findings.length} likely hardcoded secret${findings.length === 1 ? "" : "s"}.`,
      output: { findings },
      ...(findings.length > 0 ? { error: findings.map((finding) => `${finding.file}:${finding.line} ${finding.key}`).join("; ") } : {}),
    };
  },
};

export function defaultTools(): TanyaTool[] {
  const verificationPreferredModel = {
    provider: "deepseek",
    model: "deepseek-reasoner",
    match: "verification" as const,
  };
  const tools = [
    listFilesTool,
    expandResultTool,
    taskTool,
    readFileTool,
    searchTool,
    inspectRepoMapTool,
    inspectProjectContextTool,
    findReusableArtifactsTool,
    buildTaskBriefTool,
    searchObsidianNotesTool,
    writeFileTool,
    applyPatchTool,
    editBlockTool,
    searchReplaceTool,
    copyFileTool,
    copyDirTool,
    applyArtifactTool,
    createIosSplashTool,
    createAndroidSplashTool,
    generateAppIconsTool,
    createAndroidFoundationTool,
    commitPlatformChangesTool,
    resizeImageTool,
    renderSvgToPngTool,
    createAppleAppIconSetTool,
    createAndroidLauncherIconSetTool,
    validateAppleAppIconSetTool,
    validateAndroidLauncherIconSetTool,
    validateApiContractRoutesTool,
    validateAndroidProjectConfigTool,
    validateAppleProjectFilesTool,
    validateFastlaneConfigTool,
    validatePrismaSchemaTool,
    scanSecretsTool,
    generateVideoAssetTool,
    recordMetricsDashboardHandoffTool,
    runCommandTool,
    runShellTool,
  ].map((tool): TanyaTool => (
    /^validate_/.test(tool.name) || tool.name === "scan_secrets"
      ? { ...tool, preferredModel: verificationPreferredModel }
      : tool
  ));
  return tools.filter((tool) => tool.name !== "search" || existsSync("/usr/bin/rg") || existsSync("/opt/homebrew/bin/rg") || existsSync("/usr/local/bin/rg"));
}
