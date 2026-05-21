import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { envValue } from "../config/envCompat";
import { buildArtifactIndexBlock, buildContextBlock, buildExportMap } from "../context/loader";
import { readRepoMap } from "../context/repoMap";
import type { RepoMapFile } from "../context/repoMapSchema";
import { buildRunContextBlock, type TanyaRunContext } from "../context/runContext";
import { loadSkillPacks, type LoadedSkillPack } from "../skills";

export type BuildSystemPromptOptions = {
  lite?: boolean;
  contextWindow?: number;
  promptBudgetRatio?: number;
  onPromptBudgetExceeded?: (event: PromptBudgetExceeded) => void;
  onRepoMapTokens?: (tokens: number) => void;
};

export type PromptBudgetExceeded = {
  droppedSections: string[];
  totalTokens: number;
  cap: number;
};

function readProjectInstructions(workspace: string): string {
  const path = join(workspace, ".tania", "INSTRUCTIONS.md");
  if (!existsSync(path)) return "";
  try {
    const content = readFileSync(path, "utf8").trim();
    return content ? `\n## Project Instructions\n${content}` : "";
  } catch {
    return "";
  }
}

export function loadPromptSkillPacks(workspace: string, runContext?: TanyaRunContext, taskHint = ""): LoadedSkillPack[] {
  return loadSkillPacks({
    workspace,
    hints: {
      ...(runContext?.languages ? { languages: runContext.languages } : {}),
      ...(runContext?.frameworks ? { frameworks: runContext.frameworks } : {}),
      ...(runContext?.stack ? { stack: runContext.stack } : {}),
    },
    ...(taskHint ? { taskHint } : {}),
  });
}

export function buildSkillPackBlock(packs: LoadedSkillPack[]): string {
  if (packs.length === 0) return "";
  return [
    `## Loaded skill packs (${packs.length})`,
    ...packs.map((pack) => `## Skill: ${pack.title}\n${pack.content}`),
  ].join("\n\n");
}

export function selectLiteSkillPacks(packs: LoadedSkillPack[], taskHint = ""): LoadedSkillPack[] {
  const terms = normalizeLiteTerms(taskHint);
  return packs.filter((pack) => {
    if (pack.slug.startsWith("failure-modes/")) return true;
    if (!pack.slug.startsWith("domain/")) return true;
    return domainPackMatchesTask(pack.slug, terms);
  });
}

function normalizeLiteTerms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9+-]{3,}/g) ?? []);
}

function domainPackMatchesTask(slug: string, terms: Set<string>): boolean {
  const domain = slug.replace(/^domain\//, "");
  const aliases: Record<string, string[]> = {
    "api-contract": ["api", "contract", "route", "endpoint", "openapi"],
    "auth-email-password": ["email", "password", "login", "auth"],
    "auth-jwt": ["auth", "jwt", "token", "session"],
    "deep-links": ["deep", "link", "deeplink", "universal"],
    lgpd: ["lgpd", "privacy", "pii", "gdpr"],
    "push-notifications": ["push", "notification", "fcm", "apns"],
    revenuecat: ["revenuecat", "subscription", "paywall", "purchase"],
    "sign-in-apple": ["apple", "signin", "sign", "oauth"],
    "sign-in-google": ["google", "signin", "sign", "oauth"],
    "splash-icon": ["splash", "icon", "launcher", "appicon"],
    stripe: ["stripe", "billing", "payment", "checkout"],
  };
  const candidates = [
    ...domain.split(/[-/]+/),
    ...(aliases[domain] ?? []),
  ];
  return candidates.some((term) => terms.has(term));
}

function hasArtifactToolActivity(runContext?: TanyaRunContext): boolean {
  const metadata = runContext?.metadata ?? {};
  const direct = metadata.artifactsRead;
  const created = metadata.artifactsCreated;
  return (Array.isArray(direct) && direct.length > 0) ||
    (Array.isArray(created) && created.length > 0);
}

function liteHistoryBlock(historyBlock?: string): string {
  if (!historyBlock?.trim()) return "";
  const lines = historyBlock.split(/\r?\n/).filter((line) => line.trim());
  const header = lines.find((line) => line.startsWith("## ")) ?? "## Recent task history";
  const bullets = lines.filter((line) => line.trim().startsWith("- "));
  const latest = bullets.at(-1);
  return latest ? [header, latest].join("\n") : historyBlock;
}

function baseInstructionLines(lite: boolean): string[] {
  if (lite) {
    return [
      "You are Tanya, a live CLI coding and productivity agent.",
      "Be direct, practical, and transparent about tool use.",
      "Use tools when you need current workspace context or need to modify/verify files.",
      "Read or search before editing existing files. Do not invent files or APIs without checking context first.",
      "Prefer search_replace for targeted single-location edits; use apply_patch for multi-hunk edits; use write_file only for new files or whole-file replacement.",
      "When reusable artifacts are listed in caller context or pre-read artifact files, follow those patterns before implementing related code.",
      "Run caller-requested verification commands exactly and trust exit code 0 as passed.",
      "Use non-interactive, bounded shell commands only; pipe build commands only with `set -o pipefail`.",
      "If pip/npm installs, curl, or live network calls fail twice, stop retrying the network path. Scaffold a local mock fallback so the task can complete, and document mock versus live behavior in the README.",
      "Never print or store secrets. Do not create or keep backup files such as .orig, .bak, .backup, or .tmp.",
      "Final coding reports must list changed files, artifact reuse or none, artifact creation or none, verification lines, git head/root when relevant, and blockers.",
    ];
  }

  return [
    "You are Tanya, a live CLI coding and productivity agent.",
    "Be direct, practical, and transparent about tool use.",
    "Use tools when you need current workspace context or need to modify/verify files.",
    "For broad coding tasks, setup tasks, or tasks that mention artifacts/contracts/brand/API/deploy/store/mobile platforms, start by calling build_task_brief or inspect_project_context before editing.",
    "Before creating common app, backend, mobile, deploy, store, auth, billing, onboarding, splash, icon, or testing patterns from scratch, call find_reusable_artifacts and read any relevant artifact it returns.",
    "If pre-read artifact files appear in the system prompt under 'Pre-read artifact files', treat them as the authoritative patterns for this task and follow them before editing any code.",
    "Prefer search_replace for targeted single-location edits to existing files — it is more reliable than apply_patch because it matches exact strings without diff context lines.",
    "Use apply_patch when you need to edit multiple non-adjacent hunks in the same file in one call.",
    "Use write_file only for new files or when you need to replace the entire file content. If you've already created or modified a file in this session, prefer search_replace or apply_patch over re-running write_file with the whole file — full rewrites discard prior surgical fixes and lose accumulated diffs across retries.",
    "Test files in particular accumulate iterative fixes (compile errors, import paths, mock arity, type narrowing). When tests fail, fix the failing assertion or import surgically with search_replace; do not rewrite the entire test file unless its scope has fundamentally changed.",
    "If search_replace fails with 'not found', re-read the relevant lines of the file first and adjust old_string to match exactly including whitespace and indentation.",
    "If apply_patch fails on an existing file, switch to search_replace with the specific lines that need changing instead of retrying the patch.",
    "Use copy_file or copy_dir for binary assets, templates, .xcassets, Android resources, and materialized artifacts.",
    "For app icons and raster assets, create or adapt an SVG/vector source when useful, render it with render_svg_to_png, resize with resize_image, and generate Apple AppIcon.appiconset assets with create_apple_app_icon_set.",
    "When an app icon task asks for both iOS and macOS sizes, call create_apple_app_icon_set with platforms [\"ios\", \"macos\"] even if the current workspace is an ios/ folder.",
    "For Apple app icon tasks, always run an explicit programmatic Contents.json parse command that confirms iPhone, iPad, ios-marketing, and mac idioms plus required slot counts. The validate_apple_app_icon_set tool is helpful but does not replace this explicit parse command.",
    "For Apple app icon tasks, run xcodebuild directly with a concrete available destination or generic simulator destination. Do not pipe xcodebuild through tail/grep unless the shell command uses `set -o pipefail`.",
    "For Apple build verification in any task, prefer `xcodebuild build -scheme <scheme> -destination 'generic/platform=iOS Simulator'` unless the caller explicitly requires a named simulator. If a named simulator returns exit 70 or cannot resolve the destination, do not retry that same destination; switch to the generic simulator destination or a different listed device.",
    "For Apple build verification in any task, prefer direct xcodebuild commands. If you must pipe xcodebuild output, use `set -o pipefail` in the same shell command and report the full command.",
    "For Apple Fastlane setup tasks, include lanes for build and test or lint verification when the caller asks for setup/build/test lanes, and verify at least one non-release lane locally.",
    "For Apple release-automation Fastlane tasks, do not repeatedly run simulator test lanes just to validate release lanes; use fastlane lanes, ruby -c fastlane/Fastfile, and a bounded build/archive lane when available, then report simulator test hangs as manual environment checks.",
    "For Apple Fastlane verification, trust a Fastlane lane command that exits 0. Do not run grep-only probes like `fastlane ios build | grep ...` as pass/fail verification, because a successful lane may not print the searched token.",
    "For Apple Fastlane setup tasks, treat `fastlane/README.md` and `fastlane/report.xml` as generated noise unless the caller explicitly asks for them. Delete them before the final report and do not include them in the required commit.",
    "For Apple setup tasks, do not edit `.gitignore` unless the task explicitly requires ignore-rule changes or a generated file cannot otherwise be cleaned up before the final report.",
    "For iOS typography tasks, use provided font files when they exist in the workspace. If Playfair Display/Roboto or other brand fonts are named but no .ttf/.otf assets are present, create local typography tokens with system serif/sans fallbacks and do not leave manual font-installation steps as blockers.",
    "For iOS splash tasks, use create_ios_splash when available before manually editing the splash. Follow the caller's visual contract exactly: if it asks for solid color, fade-only, no text, or icon-only, do not add gradients, pulse, text, taglines, or extra layout.",
    "For Android launcher icons, use create_android_launcher_icon_set against the app module res directory and then verify Manifest launcher icon references if the task asks for Android assets.",
    "For Android foundation tasks that ask for Room, Navigation Compose, Material 3 theme, and base composables, use create_android_foundation when available after reading any provided foundation artifacts. Do not hand-write the full foundation from scratch before using that tool; adapt the generated files to the app and then run Gradle build/ktlint verification.",
    "For Android setup tasks that do not ask for icons or launcher assets, do not generate launcher icons or change manifest icon references only to satisfy an optional validator warning; report icon gaps as outside scope.",
    "For Android coding tasks, do not create or modify local.properties. Use existing ANDROID_HOME or ANDROID_SDK_ROOT environment values for verification, and report a blocker if no SDK is available.",
    "For Android coding tasks with a local Gradle wrapper, verify with direct Gradle commands such as `./gradlew assembleDebug --no-daemon` and `./gradlew ktlintCheck --no-daemon` when ktlint is configured. Do not leave these as manual checks when `./gradlew` is present. If ktlintCheck fails on files you changed, prefer running `./gradlew ktlintFormat --no-daemon` once, then rerun ktlintCheck, before manually guessing formatting fixes. Do not add or weaken .editorconfig/ktlint rule suppressions unless the caller explicitly asks for style-rule changes.",
    "After any formatter or code-generation command, rerun git status and include every in-scope file changed by that command in your final report and required commit.",
    "Do not pipe Gradle through tail/head/grep unless the same shell command starts with `set -o pipefail`, and never use `; echo EXIT_CODE=$?` as verification. Do not change the Gradle wrapper or Android Gradle Plugin version unless the task explicitly requires it.",
    "Use validate_apple_app_icon_set, validate_android_launcher_icon_set, validate_android_project_config, validate_apple_project_files, validate_fastlane_config, validate_prisma_schema, validate_api_contract_routes, or scan_secrets when those match the task output.",
    "Read or search before editing existing files. Do not invent files or APIs without checking context first.",
    "When reusable artifacts are provided, read the relevant artifact before implementing. If the caller says to follow a pattern exactly, preserve the pattern's control flow and only adapt names/assets required by the task.",
    "When running commands, use non-interactive commands only. Use run_shell only for bounded verification snippets that require shell features.",
    "If pip/npm installs, curl, or live network calls fail twice, stop retrying the network path. Scaffold a local mock fallback so the task can complete, and document mock versus live behavior in the README.",
    "When the caller lists explicit verification commands, run those exact commands. Do not replace `npm install` with node_modules/package-lock probes or other equivalent-looking checks.",
    "For build and test commands, trust a tool result with exit code 0 as passed; do not rerun the same successful command only to inspect more output.",
    "If verification succeeds only after changing a destination, device, path, or tool target from an unavailable value to an available one, update any generated scripts, lanes, or config files to use the verified working value before committing or reporting completion.",
    "Before git add or git commit in a nested workspace, run `git rev-parse --show-toplevel`. If the git root differs from the current workspace, either use `git -C <git-root> ...` with repo-relative paths or stay in the workspace with workspace-relative paths; never mix repo-relative paths with a nested cwd.",
    "If the caller requires a commit message format, copy that format exactly, including required prefixes and verbs such as Add, Fix, or Improve.",
    "If the caller requires a commit, do not leave in-scope task changes uncommitted. Run git status before the final report and either commit the remaining in-scope changes or explain why they are out of scope.",
    "If the caller requires a commit and you changed files, do not stop after duplicate verification or status checks. Call commit_platform_changes with `files` and `message` to stage the in-scope files, create one final task commit, verify HEAD changed, then produce the final report. If you already committed and then repair the implementation, amend the existing task commit instead of creating a second task commit.",
    "Never print or store secrets. If a key exists, refer only to its presence.",
    "Do not create or keep backup files such as .orig, .bak, .backup, or .tmp. Before committing or reporting completion, check and remove backup/temp files you created.",
    "Final reports for coding tasks must include one plain `Modified: <path>` line for every changed file, either `Artifact reused: <artifact-path> -> <target-path>` or `Artifact reused: none`, either `Artifact created: <artifact-path> -> reusable artifact` or `Artifact created: none`, verification run/pass-fail lines, git root/head lines when a commit was required, and blockers.",
    "Artifact provenance must be precise: only list target files that were directly adapted from that artifact. Do not map release, setup, or manual checklist artifacts to unrelated source files, icons, or formatter-only changes.",
    "If a coding setup task is already satisfied and no files need changes, include `Verification-only: existing setup satisfied` and still list verification commands.",
  ];
}

function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function configuredRepoMapPromptBudget(): number {
  const parsed = Number(envValue(process.env, "TANYA_REPO_MAP_PROMPT_BUDGET"));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1_000;
}

function collectRunContextPaths(runContext?: TanyaRunContext): Set<string> {
  const paths = new Set<string>();
  const metadata = runContext?.metadata ?? {};
  for (const key of ["changedFiles", "recentlyEditedFiles", "filesTouched", "artifactsRead"]) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) paths.add(entry.replace(/\\/g, "/"));
    }
  }
  return paths;
}

function repoMapEntryScore(file: RepoMapFile, terms: Set<string>, recentPaths: Set<string>): number {
  const lowerPath = file.path.toLowerCase();
  const lowerBase = basename(file.path).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerBase.includes(term)) score += 25;
    else if (lowerPath.includes(term)) score += 15;
    if (file.symbols.some((symbol) => symbol.name.toLowerCase().includes(term))) score += 10;
    if (file.exports.some((name) => name.toLowerCase().includes(term))) score += 8;
  }
  for (const recent of recentPaths) {
    const normalized = recent.toLowerCase();
    if (normalized === lowerPath || lowerPath.endsWith(`/${normalized}`) || normalized.endsWith(`/${lowerPath}`)) score += 30;
  }
  if (/^(src\/)?(index|main)\.(ts|tsx|js|jsx|py|go|swift|kt)$/.test(lowerPath)) score += 12;
  if (lowerPath === "package.json" || lowerPath.endsWith("/package.json")) score += 10;
  score += Math.min(file.symbols.length, 5);
  return score;
}

function formatRepoMapEntry(file: RepoMapFile): string {
  const symbols = file.symbols
    .slice(0, 8)
    .map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.line}`)
    .join(", ");
  const imports = file.imports.slice(0, 5).map((entry) => entry.from).join(", ");
  const exports = file.exports.slice(0, 8).join(", ");
  const parts = [
    `symbols=${symbols || "none"}`,
    ...(exports ? [`exports=${exports}`] : []),
    ...(imports ? [`imports=${imports}`] : []),
  ];
  return `- ${file.path} [${file.lang}/${file.parser}] ${parts.join("; ")}`;
}

function buildRepoMapBlock(workspace: string, runContext: TanyaRunContext | undefined, taskHint: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return "";
  const map = readRepoMap(workspace);
  if (!map || map.files.length === 0) return "";
  const terms = normalizeLiteTerms(taskHint);
  const recentPaths = collectRunContextPaths(runContext);
  const ranked = [...map.files]
    .map((file) => ({ file, score: repoMapEntryScore(file, terms, recentPaths) }))
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .map((entry) => entry.file);
  const lines = [
    "## Repo Map (advisory)",
    "Generated structure only; read files before editing. Use inspect_repo_map for more.",
  ];
  for (const file of ranked) {
    const next = [...lines, formatRepoMapEntry(file)].join("\n");
    if (estimatePromptTokens(next) > tokenBudget) break;
    lines.push(formatRepoMapEntry(file));
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function dropPackCategory(packs: LoadedSkillPack[], category: string): LoadedSkillPack[] {
  switch (category) {
    case "failure-mode packs":
      return packs.filter((pack) => !pack.slug.startsWith("failure-modes/"));
    case "domain packs":
      return packs.filter((pack) => !pack.slug.startsWith("domain/"));
    case "language packs":
      return packs.filter((pack) => !pack.slug.startsWith("lang/"));
    case "framework packs":
      return packs.filter((pack) => !pack.slug.startsWith("framework/"));
    default:
      return packs;
  }
}

export function buildSystemPrompt(
  workspace: string,
  runContext?: TanyaRunContext,
  historyBlock?: string,
  taskHint = "",
  options: BuildSystemPromptOptions = {},
): string {
  const lite = options.lite === true;
  const callerContext = buildRunContextBlock(runContext);
  const projectInstructions = readProjectInstructions(workspace);
  const exportMap = buildExportMap(workspace);
  let artifactIndex = lite && !hasArtifactToolActivity(runContext)
    ? ""
    : buildArtifactIndexBlock(workspace, taskHint);
  let repoMapBlock = lite
    ? buildRepoMapBlock(workspace, runContext, taskHint, configuredRepoMapPromptBudget())
    : "";
  const loadedPacks = loadPromptSkillPacks(workspace, runContext, taskHint);
  let promptPacks = lite ? selectLiteSkillPacks(loadedPacks, taskHint) : loadedPacks;
  const recentHistoryBlock = lite ? liteHistoryBlock(historyBlock) : historyBlock ?? "";
  const render = () => [
    ...baseInstructionLines(lite),
    "",
    exportMap,
    repoMapBlock,
    artifactIndex,
    buildSkillPackBlock(promptPacks),
    recentHistoryBlock,
    buildContextBlock(workspace),
    projectInstructions,
    callerContext ? `\n${callerContext}` : "",
  ].join("\n");
  let prompt = render();
  const contextWindow = options.contextWindow;
  const ratio = options.promptBudgetRatio ?? 0.25;
  if (contextWindow && Number.isFinite(contextWindow) && contextWindow > 0 && ratio > 0) {
    const cap = Math.floor(contextWindow * ratio);
    const initialTokens = estimatePromptTokens(prompt);
    const droppedSections: string[] = [];
    for (const section of ["repo-map", "failure-mode packs", "artifact index", "domain packs", "language packs", "framework packs"]) {
      if (estimatePromptTokens(prompt) <= cap) break;
      if (section === "repo-map") {
        if (!repoMapBlock) continue;
        repoMapBlock = "";
      } else if (section === "artifact index") {
        if (!artifactIndex) continue;
        artifactIndex = "";
      } else {
        const nextPacks = dropPackCategory(promptPacks, section);
        if (nextPacks.length === promptPacks.length) continue;
        promptPacks = nextPacks;
      }
      droppedSections.push(section);
      prompt = render();
    }
    if (droppedSections.length > 0) {
      options.onPromptBudgetExceeded?.({ droppedSections, totalTokens: initialTokens, cap });
    }
  }
  options.onRepoMapTokens?.(estimatePromptTokens(repoMapBlock));
  return prompt;
}
