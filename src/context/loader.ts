import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ignoredNames = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache"]);
const artifactIgnoredNames = new Set([".DS_Store", ".git", "node_modules", "dist", "build"]);

const instructionFiles = ["TANYA.md", "TANYA.md", "AGENTS.md", "CLAUDE.md", "README.md", ".tanya/INSTRUCTIONS.md"];
const projectMarkers = [
  { file: "package.json", type: "node" },
  { file: "pyproject.toml", type: "python" },
  { file: "requirements.txt", type: "python" },
  { file: "Cargo.toml", type: "rust" },
  { file: "go.mod", type: "go" },
  { file: "Package.swift", type: "swift" },
] as const;

interface WorkspaceSummary {
  workspace: string;
  isGitRepo: boolean;
  gitStatus: string | null;
  projectTypes: string[];
  verificationSuggestions: string[];
  tree: string[];
  instructionReads: { path: string; content: string }[];
  packageScripts: Record<string, string>;
}

function readIfExists(filePath: string, maxChars = 4_000): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf8");
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content;
  } catch {
    return null;
  }
}

function readFullIfExists(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function normalizeTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_+-]{2,}/g) ?? [])];
}

const artifactDirectoryKeywords: Record<string, string[]> = {
  android: ["android", "kotlin", "compose", "gradle", "room", "play", "launcher", "mipmap", "manifest"],
  backend: ["backend", "api", "route", "endpoint", "server", "prisma", "database", "postgres", "auth", "jwt", "trpc", "openapi"],
  components: ["component", "components", "ui", "shared", "button", "card", "input"],
  configs: ["config", "configs", "eslint", "tailwind", "typescript", "tsconfig", "prettier"],
  ios: ["ios", "swift", "swiftui", "xcode", "apple", "appicon", "splash", "onboarding", "storekit"],
  landing: ["landing", "marketing", "hero", "pricing", "web", "seo", "store", "badge"],
  macos: ["macos", "mac", "appkit", "xcode", "apple"],
  prompts: ["prompt", "prompts", "instructions", "task", "spec"],
  resources: ["resource", "resources", "azure", "deploy", "email", "dns", "storage", "database"],
  styles: ["style", "styles", "theme", "color", "typography", "css"],
  testing: ["test", "testing", "ci", "lint", "typecheck", "vitest", "playwright", "workflow"],
  web: ["web", "react", "next", "nextjs", "frontend", "browser", "page", "route"],
};

function scoreArtifactDirectory(name: string, taskHint: string): number {
  const lowerName = name.toLowerCase();
  const taskTerms = normalizeTerms(taskHint);
  const keywords = new Set([
    ...normalizeTerms(name),
    ...(artifactDirectoryKeywords[lowerName] ?? []),
  ]);
  let score = 0;
  for (const term of taskTerms) {
    if (term === lowerName) score += 8;
    if (lowerName.includes(term) || term.includes(lowerName)) score += 4;
    if (keywords.has(term)) score += 3;
  }
  return score;
}

function artifactDirectoryPreview(artifactsRoot: string, directory: string, maxEntries = 10): string[] {
  try {
    return readdirSync(join(artifactsRoot, directory), { withFileTypes: true })
      .filter((entry) => !artifactIgnoredNames.has(entry.name))
      .sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, maxEntries)
      .map((entry) => entry.isDirectory() ? `${directory}/${entry.name}/` : `${directory}/${entry.name}`);
  } catch {
    return [];
  }
}

export function buildArtifactIndexBlock(workspace: string, taskHint = ""): string {
  const artifactsRoot = join(workspace, "artifacts");
  if (!existsSync(artifactsRoot)) return "";

  let entries;
  try {
    entries = readdirSync(artifactsRoot, { withFileTypes: true });
  } catch {
    return "";
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !artifactIgnoredNames.has(entry.name) && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      score: scoreArtifactDirectory(entry.name, taskHint),
      preview: artifactDirectoryPreview(artifactsRoot, entry.name),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const rulesCandidates = [
    { path: "artifacts/prompts/RULES.md", absolutePath: join(artifactsRoot, "prompts", "RULES.md") },
    { path: "artifacts/RULES.md", absolutePath: join(artifactsRoot, "RULES.md") },
  ];
  const rulesRead = rulesCandidates
    .map((candidate) => ({ path: candidate.path, content: readFullIfExists(candidate.absolutePath) }))
    .find((candidate): candidate is { path: string; content: string } => candidate.content !== null && candidate.content.trim().length > 0);
  const indexReads = [
    { path: "artifacts/description.md", content: readIfExists(join(artifactsRoot, "description.md"), 12_000) },
    { path: "artifacts/README.md", content: readIfExists(join(artifactsRoot, "README.md"), 12_000) },
  ].filter((entry): entry is { path: string; content: string } => entry.content !== null && entry.content.trim().length > 0);

  if (!rulesRead && indexReads.length === 0 && directories.length === 0) return "";

  const lines: string[] = [
    "## Artifact Index",
    "Artifacts root: artifacts/",
    "Use this index to choose reusable artifacts before writing common app, backend, mobile, landing, deploy, store, auth, billing, onboarding, splash, icon, or testing code from scratch.",
  ];

  if (taskHint.trim()) {
    lines.push(`Task relevance hint: ${taskHint.trim().slice(0, 500)}`);
  }

  if (rulesRead) {
    lines.push("", `### Mandatory Artifact Rules (${rulesRead.path})`, rulesRead.content);
  }

  if (directories.length > 0) {
    lines.push("", "### Ranked Artifact Directories");
    for (const directory of directories.slice(0, 12)) {
      const relevance = directory.score > 0 ? `score=${directory.score}` : "fallback";
      lines.push(`- artifacts/${directory.name}/ (${relevance})`);
      for (const item of directory.preview.slice(0, 6)) {
        lines.push(`  - artifacts/${item}`);
      }
    }
  }

  const preReadParts: string[] = [];
  let totalPreReadChars = 0;
  const maxArtifactContentChars = 5_000;
  const maxArtifactFiles = 4;
  const scoredFiles: Array<{ path: string; fullPath: string; score: number }> = [];
  for (const directory of directories) {
    const subdirPath = join(artifactsRoot, directory.name);
    let mdFiles: string[] = [];
    try {
      mdFiles = readdirSync(subdirPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const mdFile of mdFiles) {
      const fileScore = directory.score + scoreArtifactDirectory(mdFile.replace(/\.md$/i, ""), taskHint);
      if (fileScore > 0) {
        scoredFiles.push({
          path: `artifacts/${directory.name}/${mdFile}`,
          fullPath: join(subdirPath, mdFile),
          score: fileScore,
        });
      }
    }
  }

  scoredFiles.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const { path, fullPath } of scoredFiles.slice(0, maxArtifactFiles)) {
    if (totalPreReadChars >= maxArtifactContentChars) break;
    const remaining = maxArtifactContentChars - totalPreReadChars;
    const content = readIfExists(fullPath, remaining);
    if (!content) continue;
    preReadParts.push(`#### ${path}\n${content}`);
    totalPreReadChars += content.length;
  }

  if (preReadParts.length > 0) {
    lines.push("", "### Pre-read artifact files (apply these patterns before implementing)", preReadParts.join("\n\n---\n\n"));
  }

  for (const { path, content } of indexReads) {
    lines.push("", `### ${path}`, content.trim());
  }

  const output = lines.join("\n");
  return output.length > 18_000 ? `${output.slice(0, 17_980)}\n[... truncated]` : output;
}

function runGit(workspace: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function collectTree(workspace: string, maxEntries = 120, maxDepth = 2): string[] {
  const entries: string[] = [];

  function walk(dir: string, depth: number): void {
    if (entries.length >= maxEntries || depth > maxDepth) return;

    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirents) {
      if (entries.length >= maxEntries) return;
      if (ignoredNames.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const rel = relative(workspace, fullPath).replace(/\\/g, "/");
      entries.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(fullPath, depth + 1);
    }
  }

  walk(workspace, 1);
  return entries;
}

export function detectProjectTypes(workspace: string): string[] {
  const types = new Set<string>();
  for (const marker of projectMarkers) {
    if (existsSync(join(workspace, marker.file))) types.add(marker.type);
  }
  if (existsSync(join(workspace, "gradlew")) || existsSync(join(workspace, "settings.gradle")) || existsSync(join(workspace, "settings.gradle.kts"))) {
    types.add("android");
  }
  try {
    const hasXcodeProject = readdirSync(workspace).some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
    if (hasXcodeProject) types.add("ios");
  } catch {
    // ignore unreadable workspace
  }
  return [...types];
}

type ExportMapEntry = {
  file: string;
  exports: Array<{ name: string; isDefault: boolean }>;
};

function collectTypeScriptFiles(workspace: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirents) {
      if (ignoredNames.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(relative(workspace, fullPath).replace(/\\/g, "/"));
      }
    }
  }

  walk(workspace);
  return files;
}

function exportMapPriority(file: string): number {
  if (file.startsWith("src/lib/")) return 0;
  if (file.startsWith("src/app/api/")) return 1;
  if (file.startsWith("src/server/")) return 2;
  if (file.startsWith("lib/")) return 3;
  return 4;
}

function formatExportName(entry: { name: string; isDefault: boolean }): string {
  return entry.isDefault ? `${entry.name} (default)` : entry.name;
}

function parseFileExports(workspace: string, file: string): ExportMapEntry | null {
  const content = readIfExists(join(workspace, file), 200_000);
  if (!content) return null;
  const exports: Array<{ name: string; isDefault: boolean }> = [];
  const seen = new Set<string>();
  const namedExportPattern = /^\s*export\s+(default\s+function|default\s+class|function|const|class|type|interface)\s+(\w+)/;
  const defaultExportPattern = /^\s*export\s+default(?:\s+(\w+))?/;

  for (const line of content.split(/\r?\n/)) {
    const namedMatch = line.match(namedExportPattern);
    if (namedMatch?.[2]) {
      const isDefault = namedMatch[1]?.startsWith("default") ?? false;
      const key = `${namedMatch[2]}:${isDefault ? "default" : "named"}`;
      if (!seen.has(key)) {
        seen.add(key);
        exports.push({ name: namedMatch[2], isDefault });
      }
      continue;
    }

    const defaultMatch = line.match(defaultExportPattern);
    if (defaultMatch) {
      const name = defaultMatch[1] ?? "default";
      const key = `${name}:default`;
      if (!seen.has(key)) {
        seen.add(key);
        exports.push({ name, isDefault: true });
      }
    }
  }

  return exports.length > 0 ? { file, exports } : null;
}

export function buildExportMap(workspace: string): string {
  const typeScriptFiles = collectTypeScriptFiles(workspace);
  if (typeScriptFiles.length === 0) return "";

  const entries = typeScriptFiles
    .sort((a, b) => exportMapPriority(a) - exportMapPriority(b) || a.localeCompare(b))
    .map((file) => parseFileExports(workspace, file))
    .filter((entry): entry is ExportMapEntry => entry !== null)
    .slice(0, 80);

  if (entries.length === 0) return "";

  const totalExportingFiles = typeScriptFiles
    .map((file) => parseFileExports(workspace, file))
    .filter((entry): entry is ExportMapEntry => entry !== null)
    .length;
  const lines = [
    "## Workspace export map",
    ...entries.map((entry) => `${entry.file}: ${entry.exports.map(formatExportName).join(", ")}`),
  ];
  if (totalExportingFiles > entries.length) {
    lines.push(`[... ${totalExportingFiles - entries.length} more files]`);
  }

  let output = lines.join("\n");
  if (output.length <= 3_000) return output;

  const truncatedLines = ["## Workspace export map"];
  let included = 0;
  for (const line of lines.slice(1)) {
    const remaining = entries.length - included;
    const candidate = [...truncatedLines, line, `[... ${Math.max(remaining - 1, 0)} more files]`].join("\n");
    if (candidate.length > 3_000) break;
    truncatedLines.push(line);
    included += 1;
  }
  const omitted = entries.length - included + Math.max(0, totalExportingFiles - entries.length);
  if (omitted > 0) truncatedLines.push(`[... ${omitted} more files]`);
  output = truncatedLines.join("\n");
  return output.length > 3_000 ? `${output.slice(0, 2_980)}\n[... truncated]` : output;
}

function detectVerificationSuggestions(workspace: string, projectTypes: string[], packageScripts: Record<string, string>): string[] {
  const suggestions = new Set<string>();
  if (projectTypes.includes("android")) {
    const gradle = existsSync(join(workspace, "gradlew")) ? "./gradlew" : "gradle";
    suggestions.add(`${gradle} test`);
    suggestions.add(`${gradle} assembleDebug`);
  }
  if (projectTypes.includes("ios")) {
    suggestions.add("xcodebuild -list");
    suggestions.add("xcodebuild build -scheme <scheme> -destination 'platform=iOS Simulator,name=iPhone 16'");
  }
  if (projectTypes.includes("swift")) {
    suggestions.add("swift test");
    suggestions.add("swift build");
  }
  for (const name of ["typecheck", "test", "build", "lint"]) {
    if (packageScripts[name]) suggestions.add(`npm run ${name}`);
  }
  return [...suggestions].slice(0, 8);
}

function readPackageScripts(workspace: string): Record<string, string> {
  const content = readIfExists(join(workspace, "package.json"), 80_000);
  if (!content) return {};

  try {
    const parsed = JSON.parse(content) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return {};
    const scripts: Record<string, string> = {};
    for (const [name, command] of Object.entries(parsed.scripts)) {
      if (typeof command === "string") scripts[name] = command;
    }
    return scripts;
  } catch {
    return {};
  }
}

export function loadWorkspaceSummary(workspace: string): WorkspaceSummary {
  const gitRoot = runGit(workspace, ["rev-parse", "--show-toplevel"]);
  const isGitRepo = Boolean(gitRoot);
  const gitStatus = isGitRepo ? runGit(workspace, ["status", "--short"]) ?? "" : null;
  const instructionReads: { path: string; content: string }[] = [];

  for (const fileName of instructionFiles) {
    const filePath = join(workspace, fileName);
    const content = readIfExists(filePath, fileName === "README.md" ? 6_000 : 4_000);
    if (content !== null) {
      instructionReads.push({ path: fileName, content });
    }
  }
  const packageScripts = readPackageScripts(workspace);
  const projectTypes = detectProjectTypes(workspace);

  return {
    workspace,
    isGitRepo,
    gitStatus,
    projectTypes,
    verificationSuggestions: detectVerificationSuggestions(workspace, projectTypes, packageScripts),
    tree: collectTree(workspace),
    instructionReads,
    packageScripts,
  };
}

export function buildContextBlock(workspace: string): string {
  const summary = loadWorkspaceSummary(workspace);
  const lines: string[] = [];

  lines.push("## Workspace Context");
  lines.push(`Path: ${summary.workspace}`);
  lines.push(`Git repo: ${summary.isGitRepo ? "yes" : "no"}`);
  if (summary.gitStatus !== null) {
    lines.push("Git status:");
    lines.push(summary.gitStatus || "  clean");
  }
  lines.push(`Project type: ${summary.projectTypes.length ? summary.projectTypes.join(", ") : "unknown"}`);

  if (summary.verificationSuggestions.length > 0) {
    lines.push("Verification suggestions:");
    for (const command of summary.verificationSuggestions) {
      lines.push(`  ${command}`);
    }
  }

  if (Object.keys(summary.packageScripts).length > 0) {
    lines.push("Package scripts:");
    for (const [name, command] of Object.entries(summary.packageScripts)) {
      lines.push(`  ${name}: ${command}`);
    }
  }

  if (summary.tree.length > 0) {
    lines.push("File tree:");
    for (const name of summary.tree) {
      lines.push(`  ${name}`);
    }
  }

  for (const { path, content } of summary.instructionReads) {
    lines.push(`\n--- ${path} ---`);
    lines.push(content);
  }

  return lines.join("\n");
}
