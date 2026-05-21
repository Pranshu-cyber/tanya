import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { discoverIntegrationEntries } from "../integrations/discovery";
import type {
  LoadedSkillPack,
  SkillPackContext,
  SkillPackFrontmatter,
} from "./types";

export const SKILL_PACK_TOKEN_BUDGET = 5_800;
const TOKEN_BUDGET = SKILL_PACK_TOKEN_BUDGET;
const moduleRoot = dirname(fileURLToPath(import.meta.url));
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "DerivedData",
  "build",
  "dist",
  "node_modules",
]);

type SkillPackLoadWhen = SkillPackFrontmatter["loadWhen"][number];

type ParsedSkillPackFrontmatter = SkillPackFrontmatter & {
  title: string;
};

type SkillPackFile = {
  frontmatter: ParsedSkillPackFrontmatter;
  relativePath: string;
  title: string;
  body: string;
  tokens: number;
};

type WorkspaceSignals = {
  files: string[];
  dirs: string[];
  contentFiles: string[];
  go: boolean;
  goHouse: boolean;
  goHuma: boolean;
  ios: boolean;
  swiftData: boolean;
  revenueCatIos: boolean;
  android: boolean;
  room: boolean;
  retrofit: boolean;
  revenueCatAndroid: boolean;
  next: boolean;
  tailwindV4: boolean;
  shadcn: boolean;
  fastlane: boolean;
};

type MatchReason = LoadedSkillPack["reason"] | null;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalize).filter(Boolean))];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function resolveDefaultSkillsRoot(): string {
  const candidates = [
    moduleRoot,
    join(moduleRoot, "skills"),
    join(moduleRoot, "..", "src", "skills"),
    join(moduleRoot, "..", "skills"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory() && collectSkillFiles(candidate).length > 0) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return moduleRoot;
}

function safeRead(path: string, maxChars = 250_000): string {
  try {
    const content = readFileSync(path, "utf8");
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return "";
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const content = safeRead(path);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function walkWorkspace(workspace: string, maxEntries = 8_000): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];

  function walk(current: string): void {
    if (files.length + dirs.length >= maxEntries) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length + dirs.length >= maxEntries) return;
      if (ignoredDirectories.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      const relPath = relative(workspace, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        dirs.push(relPath);
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  walk(workspace);
  return { files, dirs };
}

function collectSkillFiles(skillsRoot: string): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walk(skillsRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function splitFrontmatter(content: string): { rawFrontmatter: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match?.[1]) return null;
  return {
    rawFrontmatter: match[1].trim(),
    body: content.slice(match[0].length).trim(),
  };
}

function isLoadWhen(value: Record<string, unknown>): value is SkillPackLoadWhen {
  switch (value.kind) {
    case "always":
      return true;
    case "workspace.has":
      return typeof value.path === "string";
    case "workspace.hasGlob":
      return typeof value.glob === "string";
    case "workspace.packageJson":
      return typeof value.dep === "string";
    case "hint.language":
    case "hint.framework":
    case "hint.stack":
      return typeof value.value === "string";
    default:
      return false;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function titleFromSlug(slug: string): string {
  return slug
    .split("/")
    .at(-1)!
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFrontmatter(raw: string): ParsedSkillPackFrontmatter | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }
  const data = asObject(parsed);
  if (!data) return null;

  const parsedLoadWhen = Array.isArray(data.loadWhen)
    ? data.loadWhen
      .map(asObject)
      .filter((condition): condition is SkillPackLoadWhen => condition !== null && isLoadWhen(condition))
    : [];
  const sizeTarget = parseNumber(data.sizeTarget);
  const priority = parseNumber(data.priority);
  if (
    typeof data.slug !== "string" ||
    sizeTarget === null ||
    priority === null
  ) {
    return null;
  }

  return {
    slug: data.slug,
    title: typeof data.title === "string" && data.title.trim() ? data.title : titleFromSlug(data.slug),
    loadWhen: parsedLoadWhen,
    sizeTarget,
    priority,
  };
}

function readSkillPackFile(skillsRoot: string, filePath: string): SkillPackFile | null {
  const parsed = splitFrontmatter(safeRead(filePath));
  if (!parsed) return null;
  const frontmatter = parseFrontmatter(parsed.rawFrontmatter);
  if (!frontmatter) {
    console.warn(`[skill-packs] Failed to parse frontmatter: ${filePath}`);
    return null;
  }
  const relativePath = relative(skillsRoot, filePath).replace(/\\/g, "/").replace(/\.md$/i, "");
  return {
    frontmatter,
    relativePath,
    title: frontmatter.title,
    body: parsed.body,
    tokens: estimateTokens(parsed.body),
  };
}

function pathMatchesGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function packageJsonHasDependency(workspace: string, dep: string): boolean {
  const parsed = readJson(join(workspace, "package.json"));
  if (!parsed) return false;
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = parsed[key];
    if (deps && typeof deps === "object" && !Array.isArray(deps) && dep in deps) return true;
  }
  return false;
}

function fileHas(files: string[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file));
}

function hasRootFile(files: string[], name: string): boolean {
  return files.includes(name);
}

function hasRootDir(dirs: string[], pattern: RegExp): boolean {
  return dirs.some((dir) => pattern.test(dir));
}

function selectContentFiles(files: string[]): string[] {
  return files.filter((file) => {
    if (/\.(?:swift|kt|kts|go|ts|tsx|js|mjs|css|md|toml|xml|json|resolved|sum|mod)$/i.test(file)) return true;
    return file === "Podfile" || file.endsWith("/Podfile");
  });
}

function anyContentContains(workspace: string, files: string[], needle: string | RegExp): boolean {
  return files.some((file) => {
    const content = safeRead(join(workspace, file), 120_000);
    return typeof needle === "string" ? content.includes(needle) : needle.test(content);
  });
}

function detectWorkspaceSignals(ctx: SkillPackContext): WorkspaceSignals {
  const workspace = ctx.workspace;
  const { files, dirs } = walkWorkspace(workspace);
  const contentFiles = selectContentFiles(files);
  const go = hasRootFile(files, "go.mod");
  const pkgMigrations = files.some((file) => /^pkg\/[^/]+\/migrations\//.test(file));
  const goHouse = go && pkgMigrations && anyContentContains(workspace, contentFiles, "Module.Attach");
  const goHuma = go && (
    safeRead(join(workspace, "go.sum")).includes("github.com/danielgtaylor/huma") ||
    dirs.includes("internal/store/gen") ||
    normalize(ctx.hints.stack ?? "") === "backend-go-huma" ||
    /artifacts\/backend-go|backend-go-huma/i.test(ctx.taskHint ?? "")
  );

  const ios = hasRootFile(files, "Package.swift") || hasRootDir(dirs, /(?:^|\/)[^/]+\.xcodeproj$/);
  const swiftData = ios && anyContentContains(workspace, contentFiles, "@Model");
  const revenueCatIos = ios && (
    anyContentContains(workspace, contentFiles, "import RevenueCat") ||
    anyContentContains(workspace, contentFiles, /RevenueCat/i)
  );

  const gradleFiles = files.filter((file) => /(?:^|\/)build\.gradle(?:\.kts)?$/.test(file));
  const android = hasRootFile(files, "build.gradle.kts") ||
    gradleFiles.some((file) => file.endsWith("build.gradle.kts") || /kotlin/i.test(safeRead(join(workspace, file), 80_000)));
  const libsVersions = safeRead(join(workspace, "gradle/libs.versions.toml"), 120_000);
  const room = android && /room/i.test(libsVersions);
  const retrofit = android && anyContentContains(workspace, contentFiles, /import\s+retrofit2\b/);
  const revenueCatAndroid = android && anyContentContains(workspace, contentFiles, "com.revenuecat.purchases");

  const packageJson = safeRead(join(workspace, "package.json"), 120_000);
  const next = (hasRootFile(files, "next.config.js") || hasRootFile(files, "next.config.ts") || hasRootFile(files, "next.config.mjs")) &&
    /"next"\s*:/.test(packageJson);
  const tailwindV4 = anyContentContains(workspace, files.filter((file) => file.endsWith(".css")), '@import "tailwindcss"') ||
    packageJsonHasDependency(workspace, "@tailwindcss/postcss");
  const shadcn = hasRootFile(files, "components.json") ||
    safeExists(join(workspace, "components/ui")) ||
    safeExists(join(workspace, "src/components/ui")) ||
    dirs.includes("components/ui") ||
    dirs.includes("src/components/ui");
  const fastlane = hasRootFile(files, "fastlane/Fastfile");

  return {
    files,
    dirs,
    contentFiles,
    go,
    goHouse,
    goHuma,
    ios,
    swiftData,
    revenueCatIos,
    android,
    room,
    retrofit,
    revenueCatAndroid,
    next,
    tailwindV4,
    shadcn,
    fastlane,
  };
}

function frontmatterConditionReason(
  condition: SkillPackLoadWhen,
  ctx: SkillPackContext,
  signals: WorkspaceSignals,
): MatchReason {
  const languages = normalizeList(ctx.hints.languages);
  const frameworks = normalizeList(ctx.hints.frameworks);
  const stack = normalize(ctx.hints.stack ?? "");

  switch (condition.kind) {
    case "always":
      return "always";
    case "workspace.has":
      return safeExists(join(ctx.workspace, condition.path)) ? "workspace" : null;
    case "workspace.hasGlob":
      return [...signals.files, ...signals.dirs].some((path) => pathMatchesGlob(path, condition.glob)) ? "workspace" : null;
    case "workspace.packageJson":
      return packageJsonHasDependency(ctx.workspace, condition.dep) ? "workspace" : null;
    case "hint.language":
      return languages.includes(normalize(condition.value)) ? "hint" : null;
    case "hint.framework":
      return frameworks.includes(normalize(condition.value)) ? "hint" : null;
    case "hint.stack":
      return stack === normalize(condition.value) ? "hint" : null;
  }
}

function frameworkHintMatches(frameworks: string[], values: string[]): boolean {
  const normalizedValues = values.map(normalize);
  return frameworks.some((framework) => normalizedValues.includes(framework));
}

function languageHintMatches(languages: string[], values: string[]): boolean {
  const normalizedValues = values.map(normalize);
  return languages.some((language) => normalizedValues.includes(language));
}

function stackHintMatches(stack: string, values: string[]): boolean {
  const normalizedValues = values.map(normalize);
  return normalizedValues.includes(stack);
}

function activeStackReason(
  languages: string[],
  frameworks: string[],
  stack: string,
  signals: WorkspaceSignals,
): MatchReason {
  if (
    languageHintMatches(languages, ["go", "swift", "kotlin", "typescript", "ts"]) ||
    stackHintMatches(stack, [
      "backend-go-huma",
      "backend-go-house",
      "ios",
      "macos",
      "android",
      "landing",
      "web",
    ]) ||
    frameworkHintMatches(frameworks, [
      "chi-pgx",
      "chi",
      "pgx",
      "huma-sqlc",
      "huma",
      "sqlc",
      "swiftui",
      "swiftdata",
      "storekit2",
      "storekit",
      "revenuecat-ios",
      "jetpack-compose",
      "compose",
      "room-hilt",
      "room",
      "hilt",
      "retrofit-okhttp",
      "retrofit",
      "okhttp",
      "revenuecat-android",
      "nextjs-app-router",
      "nextjs15",
      "nextjs",
      "next",
      "tailwind-v4",
      "tailwind",
      "shadcn-ui",
      "shadcn",
    ])
  ) {
    return "hint";
  }
  return signals.go || signals.ios || signals.android || signals.next ? "workspace" : null;
}

function implicitReason(packPath: string, ctx: SkillPackContext, signals: WorkspaceSignals): MatchReason {
  if (packPath.startsWith("failure-modes/")) return "always";

  const languages = normalizeList(ctx.hints.languages);
  const frameworks = normalizeList(ctx.hints.frameworks);
  const stack = normalize(ctx.hints.stack ?? "");
  if (packPath.startsWith("domain/")) return activeStackReason(languages, frameworks, stack, signals);

  switch (packPath) {
    case "lang/go":
      if (languages.includes("go")) return "hint";
      return signals.go ? "workspace" : null;
    case "lang/swift":
      if (languages.includes("swift")) return "hint";
      return signals.ios ? "workspace" : null;
    case "lang/kotlin":
      if (languages.includes("kotlin")) return "hint";
      return signals.android ? "workspace" : null;
    case "lang/typescript":
      if (languages.includes("typescript") || languages.includes("ts")) return "hint";
      return signals.next ? "workspace" : null;
    case "framework/chi-pgx":
      if (frameworkHintMatches(frameworks, ["chi-pgx", "chi", "pgx"])) return "hint";
      return signals.goHouse ? "workspace" : null;
    case "framework/huma-sqlc":
      if (frameworkHintMatches(frameworks, ["huma-sqlc", "huma", "sqlc"]) || stack === "backend-go-huma") return "hint";
      return signals.goHuma ? "workspace" : null;
    case "framework/goose-migrations":
      if (frameworkHintMatches(frameworks, ["goose", "goose-migrations"])) return "hint";
      return signals.go && (signals.files.some((file) => /migrations\/.*\.sql$/.test(file)) || anyContentContains(ctx.workspace, signals.contentFiles, "+goose")) ? "workspace" : null;
    case "framework/service-tokens":
      if (frameworkHintMatches(frameworks, ["service-tokens", "service-token"])) return "hint";
      return signals.go && anyContentContains(ctx.workspace, signals.contentFiles, /X-Service-Token|ServiceToken|service token/i) ? "workspace" : null;
    case "framework/swiftui":
      if (frameworkHintMatches(frameworks, ["swiftui"])) return "hint";
      return signals.ios ? "workspace" : null;
    case "framework/swiftdata":
      if (frameworkHintMatches(frameworks, ["swiftdata"])) return "hint";
      return signals.swiftData ? "workspace" : null;
    case "framework/revenuecat-ios":
      if (frameworkHintMatches(frameworks, ["revenuecat-ios", "revenuecat"])) return "hint";
      return signals.revenueCatIos ? "workspace" : null;
    case "framework/storekit2":
      if (frameworkHintMatches(frameworks, ["storekit2", "storekit"])) return "hint";
      return signals.ios && !signals.revenueCatIos ? "workspace" : null;
    case "framework/jetpack-compose":
      if (frameworkHintMatches(frameworks, ["jetpack-compose", "compose"]) || languageHintMatches(languages, ["kotlin"]) || stackHintMatches(stack, ["android"])) return "hint";
      return signals.android ? "workspace" : null;
    case "framework/room-hilt":
      if (frameworkHintMatches(frameworks, ["room-hilt", "room", "hilt"])) return "hint";
      return signals.room ? "workspace" : null;
    case "framework/retrofit-okhttp":
      if (frameworkHintMatches(frameworks, ["retrofit-okhttp", "retrofit", "okhttp"])) return "hint";
      return signals.retrofit ? "workspace" : null;
    case "framework/revenuecat-android":
      if (frameworkHintMatches(frameworks, ["revenuecat-android", "revenuecat"])) return "hint";
      return signals.revenueCatAndroid ? "workspace" : null;
    case "framework/nextjs-app-router":
      if (frameworkHintMatches(frameworks, ["nextjs-app-router", "nextjs15", "nextjs", "next", "app-router"])) return "hint";
      return signals.next ? "workspace" : null;
    case "framework/tailwind-v4":
      if (frameworkHintMatches(frameworks, ["tailwind-v4", "tailwind"])) return "hint";
      return signals.tailwindV4 ? "workspace" : null;
    case "framework/shadcn-ui":
      if (frameworkHintMatches(frameworks, ["shadcn-ui", "shadcn"])) return "hint";
      return signals.shadcn ? "workspace" : null;
    case "platform-ops/fastlane-apple":
      if (frameworkHintMatches(frameworks, ["fastlane-apple"])) return "hint";
      return signals.fastlane && (signals.ios || !signals.android) ? "workspace" : null;
    case "platform-ops/fastlane-android":
      if (frameworkHintMatches(frameworks, ["fastlane-android"])) return "hint";
      return signals.fastlane && (signals.android || !signals.ios) ? "workspace" : null;
    case "platform-ops/apple-signing":
      if (frameworkHintMatches(frameworks, ["apple-signing"])) return "hint";
      return signals.ios ? "workspace" : null;
    case "platform-ops/deploy-go-backend":
      if (frameworkHintMatches(frameworks, ["deploy-go-backend"])) return "hint";
      return signals.go ? "workspace" : null;
    case "platform-ops/windows-signing":
      if (frameworkHintMatches(frameworks, ["windows-signing", "code-signing"])) return "hint";
      return null;
    case "platform-ops/packaging-cli":
      if (frameworkHintMatches(frameworks, ["packaging-cli", "homebrew", "winget", "scoop"])) return "hint";
      return null;
    default:
      return null;
  }
}

function preferredReason(reasons: LoadedSkillPack["reason"][]): LoadedSkillPack["reason"] {
  if (reasons.includes("always")) return "always";
  if (reasons.includes("hint")) return "hint";
  return "workspace";
}

function matchPack(pack: SkillPackFile, ctx: SkillPackContext, signals: WorkspaceSignals): MatchReason {
  const reasons: LoadedSkillPack["reason"][] = [];
  const implicit = implicitReason(pack.relativePath, ctx, signals);
  if (implicit) reasons.push(implicit);

  for (const condition of pack.frontmatter.loadWhen) {
    const reason = frontmatterConditionReason(condition, ctx, signals);
    if (reason) reasons.push(reason);
  }

  return reasons.length > 0 ? preferredReason(reasons) : null;
}

function compareMatchedPacks(
  a: SkillPackFile & { reason: LoadedSkillPack["reason"] },
  b: SkillPackFile & { reason: LoadedSkillPack["reason"] },
): number {
  if (a.reason === "always" && b.reason !== "always") return -1;
  if (b.reason === "always" && a.reason !== "always") return 1;
  return a.frontmatter.priority - b.frontmatter.priority ||
    a.relativePath.localeCompare(b.relativePath);
}

function enforceBudget(packs: Array<SkillPackFile & { reason: LoadedSkillPack["reason"] }>): Array<SkillPackFile & { reason: LoadedSkillPack["reason"] }> {
  const sorted = [...packs].sort(compareMatchedPacks);
  let total = sorted.reduce((sum, pack) => sum + pack.tokens, 0);
  if (total <= TOKEN_BUDGET) return sorted;

  const kept = [...sorted];
  for (const pack of [...kept].sort((a, b) => b.frontmatter.priority - a.frontmatter.priority || b.relativePath.localeCompare(a.relativePath))) {
    if (total <= TOKEN_BUDGET) break;
    if (pack.reason === "always" || pack.relativePath.startsWith("stack/")) continue;
    const index = kept.indexOf(pack);
    if (index >= 0) {
      kept.splice(index, 1);
      total -= pack.tokens;
    }
  }

  return kept.sort(compareMatchedPacks);
}

function loadSkillPacksFromFiles(ctx: SkillPackContext, skillsRoot: string, files: string[]): LoadedSkillPack[] {
  const normalizedCtx: SkillPackContext = {
    workspace: ctx.workspace,
    hints: {
      ...(ctx.hints.languages ? { languages: normalizeList(ctx.hints.languages) } : {}),
      ...(ctx.hints.frameworks ? { frameworks: normalizeList(ctx.hints.frameworks) } : {}),
      ...(ctx.hints.stack ? { stack: normalize(ctx.hints.stack) } : {}),
    },
    ...(ctx.taskHint ? { taskHint: ctx.taskHint } : {}),
  };
  const signals = detectWorkspaceSignals(normalizedCtx);
  const matched = files
    .map((filePath) => readSkillPackFile(skillsRoot, filePath))
    .filter((pack): pack is SkillPackFile => pack !== null)
    .map((pack) => {
      const reason = matchPack(pack, normalizedCtx, signals);
      return reason ? { ...pack, reason } : null;
    })
    .filter((pack): pack is SkillPackFile & { reason: LoadedSkillPack["reason"] } => pack !== null);

  return enforceBudget(matched).map((pack) => ({
    slug: pack.frontmatter.slug,
    title: pack.title,
    sourcePath: join(skillsRoot, `${pack.relativePath}.md`),
    content: pack.body,
    tokens: pack.tokens,
    reason: pack.reason,
  }));
}

export function loadSkillPacksFromRoot(ctx: SkillPackContext, skillsRoot: string): LoadedSkillPack[] {
  if (!safeExists(skillsRoot)) return [];
  try {
    const stats = statSync(skillsRoot);
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }

  return loadSkillPacksFromFiles(ctx, skillsRoot, collectSkillFiles(skillsRoot));
}

function loadSkillPacksFromPath(ctx: SkillPackContext, path: string): LoadedSkillPack[] {
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) return loadSkillPacksFromRoot(ctx, path);
    if (stats.isFile() && path.toLowerCase().endsWith(".md")) {
      return loadSkillPacksFromFiles(ctx, dirname(path), [path]);
    }
  } catch {
    return [];
  }
  return [];
}

function loadIntegrationSkillPacks(ctx: SkillPackContext): LoadedSkillPack[] {
  return discoverIntegrationEntries("skills")
    .flatMap((entry) => loadSkillPacksFromPath(ctx, entry.path));
}

function mergeSkillPacks(bundled: LoadedSkillPack[], discovered: LoadedSkillPack[]): LoadedSkillPack[] {
  const seen = new Set(bundled.map((pack) => pack.slug));
  const merged = [...bundled];
  for (const pack of discovered) {
    if (seen.has(pack.slug)) continue;
    seen.add(pack.slug);
    merged.push(pack);
  }
  return merged;
}

export function loadSkillPacks(ctx: SkillPackContext): LoadedSkillPack[] {
  const bundled = loadSkillPacksFromRoot(ctx, resolveDefaultSkillsRoot());
  return mergeSkillPacks(bundled, loadIntegrationSkillPacks(ctx));
}
