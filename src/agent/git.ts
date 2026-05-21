import type { TanyaRunContext } from "../context/runContext";
import type { TanyaFinalManifest } from "./runner";
import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitSnapshot = {
  repoRoot: string;
  head: string | null;
  files: string[];
};

export function normalizeGitPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/^"|"$/g, "");
}

export function isIgnoredReportPath(filePath: string): boolean {
  return filePath === ".." ||
    filePath.startsWith("../") ||
    /\.(?:orig|bak|backup|tmp)$/i.test(filePath) ||
    /(?:^|\/)DerivedData[^/]*(?:\/|$)/.test(filePath) ||
    /(?:^|\/)[^/]+\.xcresult(?:\/|$)/.test(filePath) ||
    /(?:^|\/)ModuleCache\.noindex(?:\/|$)/.test(filePath) ||
    /(?:^|\/)SDKStatCaches\.noindex(?:\/|$)/.test(filePath) ||
    /(?:^|\/)\.(?:tania|tanya|cosmo)\//.test(filePath) ||
    filePath.startsWith(".git/") ||
    filePath.startsWith("node_modules/") ||
    filePath.startsWith(".next/") ||
    filePath.startsWith("dist/") ||
    filePath.startsWith("build/");
}

function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null;
  const rawPath = line.slice(3).trim();
  if (!rawPath) return null;
  const renameTarget = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  return renameTarget ? normalizeGitPath(renameTarget) : null;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export async function listFilesRecursive(root: string, current = root, maxDepth = 10, depth = 0, visited = new Set<string>()): Promise<string[]> {
  const files: string[] = [];
  if (depth > maxDepth) return files;
  let currentRealPath: string;
  try {
    currentRealPath = await realpath(current);
  } catch {
    return files;
  }
  if (visited.has(currentRealPath)) return files;
  visited.add(currentRealPath);
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = resolve(current, entry.name);
    if (entry.isDirectory()) {
      let fullRealPath: string;
      try {
        fullRealPath = await realpath(fullPath);
      } catch {
        continue;
      }
      if (visited.has(fullRealPath)) continue;
      files.push(...await listFilesRecursive(root, fullPath, maxDepth, depth + 1, visited));
    } else if (entry.isFile()) {
      files.push(normalizeGitPath(relative(root, fullPath)));
    }
  }
  return files;
}

export async function pathIsGitTracked(workspace: string, relPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", relPath], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export async function hasTrackedPathUnder(workspace: string, relPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", relPath], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function captureGitSnapshot(workspace: string): Promise<GitSnapshot | null> {
  try {
    const { stdout: rootOut } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const repoRoot = rootOut.trim();
    const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain=1"], {
      cwd: repoRoot,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    let head: string | null = null;
    try {
      const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      head = headOut.trim() || null;
    } catch {
      head = null;
    }
    const files: string[] = [];
    for (const filePath of statusOut
      .split(/\r?\n/)
      .map(parsePorcelainPath)
      .filter((pathValue): pathValue is string => !!pathValue && !isIgnoredReportPath(pathValue))) {
      const absolutePath = resolve(repoRoot, filePath);
      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.isDirectory()) {
          const nestedFiles = await listFilesRecursive(absolutePath);
          files.push(...nestedFiles.map((nestedPath) => normalizeGitPath(`${filePath.replace(/\/$/, "")}/${nestedPath}`)));
          continue;
        }
      } catch {
        // Keep the original porcelain path as fallback evidence.
      }
      files.push(filePath);
    }
    return {
      repoRoot,
      head,
      files: uniqueSorted(files.filter((filePath) => filePath && !isIgnoredReportPath(filePath))),
    };
  } catch {
    return null;
  }
}

function toWorkspaceReportPath(filePath: string, snapshot: GitSnapshot, workspace: string): string | null {
  const absPath = resolve(snapshot.repoRoot, filePath);
  const relPath = normalizeGitPath(relative(workspace, absPath));
  if (!relPath || relPath === "." || relPath.startsWith("../") || relPath === "..") {
    return null;
  }
  return relPath;
}

export async function changedFilesFromGit(before: GitSnapshot | null, workspace: string): Promise<string[]> {
  const after = await captureGitSnapshot(workspace);
  if (!after) return [];
  const beforeFiles = new Set(before?.files ?? []);
  const changed = after.files.filter((filePath) => !beforeFiles.has(filePath));

  if (before?.head && after.head && before.head !== after.head) {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", before.head, after.head], {
        cwd: after.repoRoot,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      changed.push(
        ...stdout
          .split(/\r?\n/)
          .map(normalizeGitPath)
          .filter((filePath) => filePath && !isIgnoredReportPath(filePath)),
      );
    } catch {
      // The live tool-tracked file list still provides useful fallback evidence.
    }
  }

  return uniqueSorted(
    changed
      .map((filePath) => toWorkspaceReportPath(filePath, after, workspace))
      .filter((filePath): filePath is string => !!filePath && !isIgnoredReportPath(filePath)),
  );
}

export async function committedFilesFromGit(before: GitSnapshot | null, after: GitSnapshot | null, workspace: string): Promise<string[]> {
  if (!before?.head || !after?.head || before.head === after.head) return [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", before.head, after.head], {
      cwd: after.repoRoot,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return uniqueSorted(
      stdout
        .split(/\r?\n/)
        .map(normalizeGitPath)
        .filter((filePath) => filePath && !isIgnoredReportPath(filePath))
        .map((filePath) => toWorkspaceReportPath(filePath, after, workspace))
        .filter((filePath): filePath is string => !!filePath && !isIgnoredReportPath(filePath)),
    );
  } catch {
    return [];
  }
}

export function uncommittedFilesSince(before: GitSnapshot | null, after: GitSnapshot | null, workspace: string): string[] {
  if (!after) return [];
  const beforeFiles = new Set(before?.files ?? []);
  return normalizeReportPathsForWorkspace(
    after.files.filter((filePath) => !beforeFiles.has(filePath)),
    after,
    workspace,
  );
}

export function normalizeReportFiles(files: string[]): string[] {
  return uniqueSorted(files.map(normalizeGitPath).filter((filePath) => filePath && !isIgnoredReportPath(filePath)));
}

export function normalizeReportPathsForWorkspace(files: string[], snapshot: GitSnapshot | null, workspace: string): string[] {
  if (!snapshot) return normalizeReportFiles(files);
  const workspacePrefix = normalizeGitPath(relative(snapshot.repoRoot, workspace));
  if (!workspacePrefix || workspacePrefix === "." || workspacePrefix.startsWith("../") || workspacePrefix === "..") {
    return normalizeReportFiles(files);
  }
  return normalizeReportFiles(files.map((filePath) => {
    const normalized = normalizeGitPath(filePath);
    return normalized.startsWith(`${workspacePrefix}/`)
      ? normalized.slice(workspacePrefix.length + 1)
      : normalized;
  }));
}

function runContextBoolean(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true;
}

function expectedReportIncludes(runContext: TanyaRunContext | undefined, key: string): boolean {
  const value = runContext?.expected_report?.[key];
  if (value === true) return true;
  if (Array.isArray(value)) return value.includes(key);
  if (typeof value === "string") return value.split(/[\s,]+/).includes(key);
  return false;
}

export function runContextRequiresCommit(runContext?: TanyaRunContext): boolean {
  return runContextBoolean(runContext?.metadata, "requireCommit") || expectedReportIncludes(runContext, "commit");
}

export function commitStillRequired(manifest: TanyaFinalManifest, beforeGitSnapshot: GitSnapshot | null, runContext?: TanyaRunContext): boolean {
  if (!runContextRequiresCommit(runContext)) return false;
  if (manifest.changedFiles.length === 0) return false;
  if (manifest.uncommittedFiles.length > 0) return true;
  if (!beforeGitSnapshot?.head || !manifest.git.head) return false;
  return manifest.git.head === beforeGitSnapshot.head.slice(0, 7);
}
