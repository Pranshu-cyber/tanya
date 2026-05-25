import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { TanyaTool, ToolContext } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";

const ignoredNames = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".claude",
  ".cursor",
  ".playwright-mcp",
  ".venv",
  "venv",
  "coverage",
  "out",
  "vendor",
  "Pods",
  "full-ad-renders",
  "video-tmp",
  "tmp",
  "DerivedData",
  ".gradle",
  "ComfyUI",
]);

const queryStopwords = new Set([
  "a",
  "an",
  "and",
  "app",
  "as",
  "at",
  "by",
  "create",
  "creating",
  "for",
  "from",
  "implement",
  "in",
  "into",
  "new",
  "of",
  "on",
  "or",
  "set",
  "task",
  "tasks",
  "the",
  "this",
  "to",
  "up",
  "use",
  "using",
  "v2",
  "verification",
  "verify",
  "build",
  "typecheck",
  "script",
  "scripts",
  "with",
]);

const instructionNames = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "TANYA.md",
  "TANYA.md",
  "README.md",
  "PROJECT.md",
  "CONTRIBUTING.md",
]);

const artifactFileExtensions = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".swift",
  ".kt",
  ".kts",
  ".gradle",
  ".prisma",
  ".json",
  ".xml",
  ".yml",
  ".yaml",
  ".css",
]);

type ArtifactIndexEntry = {
  path: string;
  category?: string;
  description?: string;
  useWhen?: string;
};

type ArtifactCandidate = ArtifactIndexEntry & {
  root: string;
  extension: string;
  score: number;
  reason: string;
};

export type CapabilityPackBrief = {
  id: string;
  reason: string;
  tools: string[];
  artifactHints: string[];
  validators: string[];
  verificationHints: string[];
};

export type TanyaTaskBrief = {
  task: string;
  signals: {
    platforms: string[];
    domains: string[];
  };
  contextFiles: Array<{
    path: string;
    role: string;
  }>;
  artifacts: ArtifactCandidate[];
  verification: string[];
  recommendedTools: string[];
  capabilityPacks: CapabilityPackBrief[];
  cautions: string[];
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing string field: ${key}`);
  return value.trim();
}

function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(input: unknown, key: string, fallback: number): number {
  const value = asRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalBoolean(input: unknown, key: string, fallback: boolean): boolean {
  const value = asRecord(input)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|1)$/i.test(value.trim());
  return fallback;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function cleanMarkdownCell(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\\\|/g, "|")
    .trim();
}

function termList(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_+-]{2,}/g) ?? [])]
    .filter((term) => !queryStopwords.has(term));
}

function resolveOptionalWorkspacePath(context: ToolContext, inputPath?: string): string {
  if (!inputPath) return context.workspace;
  if (inputPath.startsWith("/")) return resolveInsideWorkspace(context.workspace, inputPath);
  return resolveInsideWorkspace(context.workspace, inputPath);
}

async function collectFiles(root: string, maxFiles: number, current = root, out: string[] = []): Promise<string[]> {
  if (out.length >= maxFiles) return out;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (ignoredNames.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    const rel = normalizePath(relative(root, fullPath));
    if (entry.isDirectory()) {
      if (entry.name === ".tanya") {
        out.push(`${rel}/`);
        await collectTanyaFiles(root, fullPath, maxFiles, out);
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      out.push(`${rel}/`);
      await collectFiles(root, maxFiles, fullPath, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function collectTanyaFiles(root: string, tanyaDir: string, maxFiles: number, out: string[]): Promise<void> {
  for (const rel of ["INSTRUCTIONS.md", "artifacts/manifest.json"]) {
    if (out.length >= maxFiles) return;
    const abs = join(tanyaDir, rel);
    try {
      if ((await stat(abs)).isFile()) out.push(normalizePath(relative(root, abs)));
    } catch {
      // Optional local Tanya files are often absent.
    }
  }
  const contextDir = join(tanyaDir, "context");
  try {
    if ((await stat(contextDir)).isDirectory()) {
      out.push(normalizePath(relative(root, contextDir)) + "/");
      await collectFiles(root, maxFiles, contextDir, out);
    }
  } catch {
    // Optional materialized context is often absent.
  }
}

async function readExcerpt(path: string, maxChars: number): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content;
  } catch {
    return null;
  }
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  const path = join(root, "package.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function classifyContextFile(relPath: string): string | null {
  const normalized = normalizePath(relPath);
  const name = basename(normalized);
  const lower = normalized.toLowerCase();
  if (normalized === ".tanya/INSTRUCTIONS.md" || instructionNames.has(name)) return "instruction";
  if (lower === "artifacts/description.md" || lower === "artifacts/readme.md" || lower === ".tanya/artifacts/manifest.json") return "artifact-index";
  if (lower.startsWith(".tanya/context/")) return "materialized-context";
  if (lower.startsWith("brand/") && /\.(md|json|txt)$/i.test(lower)) return "project-contract";
  if (/(^|\/)(api_features\.md|api-features\.md|openapi\.json|openapi\.yaml|openapi\.yml)$/i.test(normalized)) return "api-contract";
  if (/(^|\/)(schema\.prisma|prisma\.schema)$/i.test(normalized)) return "data-contract";
  if (/(^|\/)(safety\.md|architecture\.md|product\.md|features\.md|deploy\.md|store\.md)$/i.test(normalized)) return "project-contract";
  if (/^docs\/[^/]+\.md$/i.test(normalized)) return "doc";
  if (!normalized.includes("/") && /\.md$/i.test(normalized)) return "doc";
  return null;
}

function detectPlatforms(files: string[]): string[] {
  const text = files.join("\n").toLowerCase();
  const platforms = new Set<string>();
  if (/\.xcodeproj|\.xcworkspace|\/ios\/|\.swift\b/.test(text)) platforms.add("ios");
  if (/\/macos\/|\.entitlements\b|appkit|\.xcodeproj/.test(text)) platforms.add("macos");
  if (/gradlew|settings\.gradle|build\.gradle|androidmanifest\.xml|\/android\//.test(text)) platforms.add("android");
  if (/package\.json|next\.config|src\/app|src\/pages/.test(text)) platforms.add("node");
  if (/schema\.prisma|\/prisma\//.test(text)) platforms.add("prisma");
  if (/\/landing\/|next\.config|astro\.config|vite\.config/.test(text)) platforms.add("web");
  return [...platforms].sort();
}

function parseArtifactDescription(markdown: string): ArtifactIndexEntry[] {
  const entries: ArtifactIndexEntry[] = [];
  let category = "";
  let prefix = "";
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)(?:\s+\(`([^`]+)`\))?\s*$/.exec(line);
    if (heading) {
      category = heading[1]?.replace(/#+$/, "").trim() ?? "";
      prefix = normalizePath(heading[2] ?? "");
      if (prefix && !prefix.endsWith("/")) prefix += "/";
      continue;
    }
    if (!/^\|/.test(line) || /^(\|\s*-+)/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(cleanMarkdownCell);
    if (cells.length < 3 || /^file$/i.test(cells[0] ?? "")) continue;
    const fileName = cells[0] ?? "";
    if (!fileName || fileName.includes(" ")) continue;
    const path = prefix ? `${prefix}${fileName}` : fileName;
    entries.push({
      path: normalizePath(path),
      category,
      ...(cells[1] ? { description: cells[1] } : {}),
      ...(cells[2] ? { useWhen: cells[2] } : {}),
    });
  }
  return entries;
}

async function artifactMetadataByPath(workspace: string, rootRel: string): Promise<Map<string, ArtifactIndexEntry>> {
  const result = new Map<string, ArtifactIndexEntry>();
  const descriptionPath = resolveInsideWorkspace(workspace, `${rootRel}/description.md`);
  const description = await readExcerpt(descriptionPath, 80_000);
  if (!description) return result;
  for (const entry of parseArtifactDescription(description)) {
    const normalizedEntryPath = normalizePath(entry.path);
    result.set(normalizedEntryPath, entry);
    if (normalizedEntryPath.startsWith("artifacts/")) {
      result.set(normalizePath(`${rootRel}/${normalizedEntryPath.replace(/^artifacts\//, "")}`), entry);
    } else {
      result.set(normalizePath(`${rootRel}/${normalizedEntryPath}`), entry);
    }
  }
  return result;
}

async function artifactRoots(workspace: string, preferredRoot?: string): Promise<Array<{ rel: string; abs: string }>> {
  const candidates = preferredRoot
    ? [preferredRoot]
    : ["artifacts", ".tanya/artifacts"];
  const roots: Array<{ rel: string; abs: string }> = [];
  for (const candidate of candidates) {
    const rel = normalizePath(candidate);
    const abs = resolveInsideWorkspace(workspace, rel);
    try {
      if ((await stat(abs)).isDirectory()) roots.push({ rel, abs });
    } catch {
      // Missing artifact roots are normal.
    }
  }
  return roots;
}

function platformMatches(path: string, platform?: string): boolean {
  if (!platform) return true;
  const lowerPath = path.toLowerCase();
  const normalized = platform.toLowerCase();
  if (normalized === "apple") return /\/(?:ios|macos)\//.test(lowerPath);
  return lowerPath.includes(`/${normalized}/`) || lowerPath.includes(`${normalized}/`);
}

function scoreArtifact(entry: ArtifactIndexEntry, rootRel: string, query: string): { score: number; reason: string } {
  const terms = termList(query);
  const haystack = [
    entry.path,
    entry.category,
    entry.description,
    entry.useWhen,
  ].filter(Boolean).join("\n").toLowerCase();
  if (terms.length === 0) return { score: 1, reason: "listed from artifact root" };

  let score = 0;
  const reasons: string[] = [];
  for (const term of terms) {
    if (entry.path.toLowerCase().includes(term)) {
      score += 5;
      reasons.push(`path:${term}`);
    }
    if ((entry.description ?? "").toLowerCase().includes(term)) {
      score += 3;
      reasons.push(`description:${term}`);
    }
    if ((entry.useWhen ?? "").toLowerCase().includes(term)) {
      score += 3;
      reasons.push(`useWhen:${term}`);
    }
    if ((entry.category ?? "").toLowerCase().includes(term)) {
      score += 2;
      reasons.push(`category:${term}`);
    }
  }
  if (entry.path.startsWith(`${rootRel}/`)) score += 1;
  return { score, reason: reasons.length ? [...new Set(reasons)].join(", ") : "weak filename/category match" };
}

async function findArtifacts(params: {
  workspace: string;
  artifactRoot?: string;
  query?: string;
  platform?: string;
  maxResults: number;
}): Promise<ArtifactCandidate[]> {
  const roots = await artifactRoots(params.workspace, params.artifactRoot);
  const candidates: ArtifactCandidate[] = [];
  for (const root of roots) {
    const metadata = await artifactMetadataByPath(params.workspace, root.rel);
    const files = await collectFiles(root.abs, 1_000);
    for (const relFile of files) {
      if (relFile.endsWith("/")) continue;
      if (/(\.orig|\.bak|\.backup|\.tmp|\.DS_Store)$/i.test(relFile)) continue;
      const extension = extname(relFile);
      if (extension && !artifactFileExtensions.has(extension)) continue;
      const fullPath = normalizePath(`${root.rel}/${relFile}`);
      if (!platformMatches(fullPath, params.platform)) continue;
      const metadataEntry = metadata.get(fullPath)
        ?? metadata.get(normalizePath(`artifacts/${relFile}`))
        ?? metadata.get(relFile);
      const entry: ArtifactIndexEntry = {
        path: fullPath,
        ...(metadataEntry?.category ? { category: metadataEntry.category } : {}),
        ...(metadataEntry?.description ? { description: metadataEntry.description } : {}),
        ...(metadataEntry?.useWhen ? { useWhen: metadataEntry.useWhen } : {}),
      };
      const scored = scoreArtifact(entry, root.rel, params.query ?? "");
      if ((params.query ?? "").trim() && scored.score <= 0) continue;
      candidates.push({
        ...entry,
        root: root.rel,
        extension,
        score: scored.score,
        reason: scored.reason,
      });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, params.maxResults);
}

function inferPlatformFromWorkspacePath(workspace: string): string | null {
  const m = workspace.toLowerCase().match(/\/(ios|macos|android|backend|landing|web|script|cli)(?:\/|$)/);
  if (!m) return null;
  // Normalize cli → script (the backing folder may be named either way).
  return m[1] === "cli" ? "script" : m[1] ?? null;
}

function inferTaskSignals(task: string, workspace?: string): { platforms: string[]; domains: string[] } {
  const text = task.toLowerCase();
  const platforms = new Set<string>();
  const domains = new Set<string>();
  const platformMatchers: Array<[string, RegExp]> = [
    ["ios", /\bios\b|swiftui|xcode|appicon\.appiconset/],
    ["macos", /\bmacos\b|\bmac\b|appkit/],
    ["android", /\bandroid\b|kotlin|compose|gradle|play store/],
    ["backend", /\bbackend\b|api route|endpoint|server|prisma|postgres|database/],
    ["web", /\bweb\b|next\.js|react|landing|vercel/],
    // Script/CLI signals: subcommands, packagers, completions, signing.
    ["script", /\bcli\b|\bscript\b|commander|clap|click\b|cobra|homebrew|winget|launchd|systemd|pkgbuild|flatpak|notariz|authenticode|sigstore|cargo install|npm install -g|pipx/],
  ];
  const domainMatchers: Array<[string, RegExp]> = [
    ["setup", /\bsetup\b|scaffold|initialize|environment|foundation/],
    ["artifact-reuse", /\bartifact|template|pattern|reuse|reusable/],
    ["api-contract", /\bapi\b|openapi|endpoint|route|contract|api_features/],
    ["auth", /\bauth\b|login|sign in|oauth|session|jwt/],
    ["billing", /revenuecat|storekit|subscription|premium|paywall|stripe|billing/],
    ["icons", /\bicon\b|appicon|launcher/],
    ["splash", /\bsplash\b|launch screen/],
    ["onboarding", /\bonboarding\b|first launch/],
    ["localization", /\blocali[sz]ation\b|translate|language|i18n/],
    ["notifications", /notification|push|fcm|apns/],
    ["deep-links", /deep link|universal link|app links|url scheme/],
    ["landing", /\blanding\b|marketing page|hero section|store badges|pricing/],
    ["deploy", /\bdeploy\b|azure|railway|vercel|app service/],
    ["store", /app store|play store|fastlane|release|submission/],
    ["testing", /\btest\b|ci|lint|typecheck|build|verify/],
    ["data", /room|swiftdata|prisma|database|offline|sync/],
  ];
  for (const [platform, matcher] of platformMatchers) if (matcher.test(text)) platforms.add(platform);
  for (const [domain, matcher] of domainMatchers) if (matcher.test(text)) domains.add(domain);
  const workspacePlatform = workspace ? inferPlatformFromWorkspacePath(workspace) : null;
  if (workspacePlatform) {
    return { platforms: [workspacePlatform], domains: [...domains].sort() };
  }
  return { platforms: [...platforms].sort(), domains: [...domains].sort() };
}

function recommendedVerificationCommands(files: string[], packageScripts: Record<string, string>, signals: { platforms: string[]; domains: string[] }): string[] {
  const commands = new Set<string>();
  const hasExplicitPlatformSignal = signals.platforms.length > 0;
  const hasScript = (name: string) => Object.prototype.hasOwnProperty.call(packageScripts, name);
  // Only recommend npm-script verifications when the workspace actually has
  // a package.json with that script. The previous `|| signals.domains.includes("data")`
  // fallback misfired on iOS/Android workspaces where prompts mention session/sync/db
  // for context, which falsely triggered the data domain and made the agent run
  // `npm run prisma:generate` from a workspace with no package.json — leading to
  // a verify-blocker loop. See 2026-05-01 setup/1 incident.
  if (hasScript("prisma:generate")) commands.add("npm run prisma:generate");
  if (hasScript("typecheck")) commands.add("npm run typecheck");
  if (hasScript("test")) commands.add("npm test");
  if (hasScript("lint")) commands.add("npm run lint");
  if (hasScript("build")) commands.add("npm run build");
  const text = files.join("\n").toLowerCase();
  if (signals.platforms.includes("android") || (!hasExplicitPlatformSignal && /gradlew|settings\.gradle|androidmanifest\.xml/.test(text))) {
    commands.add("./gradlew test --no-daemon");
    commands.add("./gradlew assembleDebug --no-daemon");
    if (/ktlint/.test(text)) commands.add("./gradlew ktlintCheck --no-daemon");
  }
  if (signals.platforms.includes("ios") || signals.platforms.includes("macos") || (!hasExplicitPlatformSignal && /\.xcodeproj|\.xcworkspace/.test(text))) {
    commands.add("xcodebuild -list");
  }
  // Script/CLI verifications — stack-aware. Detect the build system from
  // marker files in the workspace; never assume `npm run build` for non-Node
  // script projects, that's the same misfire pattern as the prisma:generate
  // bug fixed earlier in this session.
  if (signals.platforms.includes("script")) {
    if (/cargo\.toml/.test(text)) {
      commands.add("cargo build --release");
      commands.add("cargo test");
    }
    if (/pyproject\.toml|setup\.py/.test(text)) {
      commands.add("python -m pytest");
      commands.add("python -m build");
    }
    if (/go\.mod/.test(text)) {
      commands.add("go build ./...");
      commands.add("go test ./...");
    }
    // Node CLI workspaces just reuse the npm-script recommendations above.
  }
  return [...commands];
}

function capabilityPacksForSignals(signals: { platforms: string[]; domains: string[] }): CapabilityPackBrief[] {
  const packs: CapabilityPackBrief[] = [];
  const hasPlatform = (platform: string) => signals.platforms.includes(platform);
  const hasDomain = (domain: string) => signals.domains.includes(domain);
  const add = (pack: CapabilityPackBrief) => packs.push(pack);

  if (hasPlatform("backend") || hasDomain("api-contract") || hasDomain("data")) {
    add({
      id: "backend-api",
      reason: "Task touches backend, API contract, routes, Prisma, database, or endpoint behavior.",
      tools: ["find_reusable_artifacts", "validate_api_contract_routes", "validate_prisma_schema", "scan_secrets"],
      artifactHints: ["backend/ApiRoutePattern", "backend/HealthRoute", "backend/OpenApiSwaggerRoutes", "backend/PrismaBase", "backend/MockDataSeedScript"],
      validators: ["api contract parity", "Prisma model presence", "secret scan", "backend health route"],
      verificationHints: ["typecheck", "test", "build", "prisma generate"],
    });
  }
  if (hasPlatform("ios") || hasPlatform("macos")) {
    add({
      id: "mobile-apple",
      reason: "Task touches iOS, macOS, SwiftUI, Xcode, app icons, StoreKit, or Apple release work.",
      tools: ["find_reusable_artifacts", "generate_app_icons", "create_ios_splash", "validate_apple_project_files", "validate_apple_app_icon_set"],
      artifactHints: ["ios/ThemeSystem", "ios/NavigationSetup", "ios/APIClient", "ios/FastlaneSetup", "ios/SplashScreenPattern"],
      validators: ["Xcode project files", "app icon slots", "Fastlane config", "splash contract"],
      verificationHints: ["xcodebuild -list", "xcodebuild build"],
    });
  }
  if (hasPlatform("android")) {
    add({
      id: "mobile-android",
      reason: "Task touches Android, Kotlin, Compose, Gradle, Room, launcher assets, or Play release work.",
      tools: ["find_reusable_artifacts", "create_android_foundation", "create_android_splash", "generate_app_icons", "validate_android_project_config"],
      artifactHints: ["android/ThemeSystem", "android/NavigationSetup", "android/RoomSetup", "android/FastlaneSetup", "android/SplashScreenPattern"],
      validators: ["Gradle project config", "launcher icon resources", "foundation files", "Fastlane config"],
      verificationHints: ["./gradlew assembleDebug --no-daemon", "./gradlew test --no-daemon", "./gradlew ktlintCheck --no-daemon"],
    });
  }
  if (hasPlatform("web") || hasDomain("landing")) {
    add({
      id: "landing-web",
      reason: "Task touches web app, landing page, React/Next.js, marketing sections, or frontend build behavior.",
      tools: ["find_reusable_artifacts", "scan_secrets"],
      artifactHints: ["landing/hero", "landing/features", "landing/pricing", "components/store-badges", "web/WebAppFoundation"],
      validators: ["responsive page structure", "SEO/store links", "secret scan"],
      verificationHints: ["typecheck", "test", "build"],
    });
  }
  if (hasDomain("store") || hasDomain("billing")) {
    add({
      id: "store-release",
      reason: "Task touches store submission, Fastlane, subscriptions, paywalls, RevenueCat, StoreKit, Stripe, or release automation.",
      tools: ["find_reusable_artifacts", "validate_fastlane_config", "scan_secrets"],
      artifactHints: ["ios/FastlaneSetup", "android/FastlaneSetup", "ios/PaywallView", "ios/SubscriptionManagerFull", "android/RevenueCatBilling"],
      validators: ["Fastlane lanes", "secret placeholders", "subscription entitlement wiring"],
      verificationHints: ["Fastlane lane validation", "build lane", "syntax check"],
    });
  }
  if (hasDomain("deploy")) {
    add({
      id: "deployment",
      reason: "Task touches deploy infrastructure, Azure/Railway/Vercel, DNS, email setup, or live endpoint checks.",
      tools: ["find_reusable_artifacts", "validate_api_contract_routes", "scan_secrets"],
      artifactHints: ["resources/azure-setup", "resources/email-setup", "backend/AzureBackendDeployChecklist", "testing/MobileCIWorkflows"],
      validators: ["env placeholder safety", "live endpoint smoke checks", "secret scan"],
      verificationHints: ["provider-specific dry run", "health endpoint", "build"],
    });
  }

  return packs;
}

function artifactPlatformFilters(signals: { platforms: string[]; domains: string[] }): string[] {
  const filters: string[] = [];
  if (signals.platforms.includes("backend")) filters.push("backend");
  if (signals.platforms.includes("android")) filters.push("android");
  if (signals.platforms.includes("ios") || signals.platforms.includes("macos")) filters.push("apple");
  if (signals.platforms.includes("web")) filters.push("web");
  if (signals.domains.includes("landing")) filters.push("landing");
  if (signals.domains.includes("store")) filters.push("resources", "testing");
  return [...new Set(filters)];
}

async function findArtifactsForSignals(params: {
  workspace: string;
  query: string;
  signals: { platforms: string[]; domains: string[] };
  maxResults: number;
}): Promise<ArtifactCandidate[]> {
  const filters = artifactPlatformFilters(params.signals);
  if (filters.length === 0) {
    return findArtifacts({
      workspace: params.workspace,
      query: params.query,
      maxResults: params.maxResults,
    });
  }

  const lists = await Promise.all(filters.map((platform) =>
    findArtifacts({
      workspace: params.workspace,
      query: params.query,
      platform,
      maxResults: params.maxResults,
    })
  ));
  const merged: ArtifactCandidate[] = [];
  const seen = new Set<string>();
  for (let index = 0; merged.length < params.maxResults && index < params.maxResults; index += 1) {
    for (const list of lists) {
      const candidate = list[index];
      if (!candidate || seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      merged.push(candidate);
      if (merged.length >= params.maxResults) break;
    }
  }
  return merged;
}

export async function buildTaskBrief(input: {
  workspace: string;
  task: string;
  maxArtifacts?: number;
  maxContextFiles?: number;
}): Promise<TanyaTaskBrief> {
  const maxArtifacts = Math.min(input.maxArtifacts ?? 12, 40);
  const maxContextFiles = Math.min(input.maxContextFiles ?? 16, 50);
  const files = await collectFiles(input.workspace, 1_000);
  const packageScripts = await readPackageScripts(input.workspace);
  const signals = inferTaskSignals(input.task, input.workspace);
  const contextFiles = files
    .filter((file) => !file.endsWith("/"))
    .map((file) => ({ path: file, role: classifyContextFile(file) }))
    .filter((file): file is { path: string; role: string } => Boolean(file.role))
    .slice(0, maxContextFiles);
  const artifactQuery = [input.task, signals.platforms.join(" "), signals.domains.join(" ")].filter(Boolean).join(" ");
  const artifacts = await findArtifactsForSignals({
    workspace: input.workspace,
    query: artifactQuery,
    signals,
    maxResults: maxArtifacts,
  });
  const verification = recommendedVerificationCommands(files, packageScripts, signals);
  const capabilityPacks = capabilityPacksForSignals(signals);
  const recommendedTools = [
    "inspect_project_context",
    artifacts.length > 0 ? "find_reusable_artifacts" : null,
    signals.domains.includes("api-contract") ? "validate_api_contract_routes" : null,
    signals.domains.includes("icons") ? "generate_app_icons" : null,
    signals.domains.includes("splash") && (signals.platforms.includes("ios") || signals.platforms.includes("macos")) ? "create_ios_splash" : null,
    signals.domains.includes("splash") && signals.platforms.includes("android") ? "create_android_splash" : null,
    signals.domains.includes("setup") && signals.platforms.includes("android") ? "create_android_foundation" : null,
    ...capabilityPacks.flatMap((pack) => pack.tools),
    "scan_secrets",
  ].filter((value): value is string => typeof value === "string");

  return {
    task: input.task,
    signals,
    contextFiles,
    artifacts,
    verification,
    recommendedTools: [...new Set(recommendedTools)],
    capabilityPacks,
    cautions: [
      "Do not hardcode secrets; only write placeholders or document required manual configuration.",
      "Read contracts such as brand, safety, API_FEATURES, OpenAPI, schema, and artifact indexes before editing affected areas.",
      "Prefer existing repo patterns and reusable artifacts before inventing a new implementation.",
    ],
  };
}

export const inspectProjectContextTool: TanyaTool = {
  name: "inspect_project_context",
  description: "Inspect local project instructions, contracts, artifact indexes, platforms, and verification hints.",
  definition: {
    type: "function",
    function: {
      name: "inspect_project_context",
      description: "Inspect local project instructions, contracts, artifact indexes, platforms, and verification hints before a broad coding task.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional directory relative to the workspace. Default workspace root." },
          includeExcerpts: { type: "boolean", description: "Include short text excerpts from context files. Default true." },
          maxFiles: { type: "number", description: "Maximum files to inspect. Default 500." },
          maxExcerptChars: { type: "number", description: "Maximum excerpt characters per context file. Default 900." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const root = resolveOptionalWorkspacePath(context, asOptionalString(record, "path"));
    const rootRel = normalizePath(relative(context.workspace, root)) || ".";
    const includeExcerpts = asOptionalBoolean(input, "includeExcerpts", true);
    const maxFiles = Math.min(asOptionalNumber(input, "maxFiles", 500), 2_000);
    const maxExcerptChars = Math.min(asOptionalNumber(input, "maxExcerptChars", 900), 4_000);
    const files = await collectFiles(root, maxFiles);
    const platforms = detectPlatforms(files);
    const packageScripts = await readPackageScripts(root);
    const contextFiles = [];
    for (const file of files) {
      if (file.endsWith("/")) continue;
      const role = classifyContextFile(file);
      if (!role) continue;
      const abs = resolve(root, file);
      contextFiles.push({
        path: rootRel === "." ? file : normalizePath(`${rootRel}/${file}`),
        role,
        ...(includeExcerpts ? { excerpt: await readExcerpt(abs, maxExcerptChars) } : {}),
      });
    }
    const verification = recommendedVerificationCommands(files, packageScripts, { platforms, domains: [] });
    let artifactsCatalog: { hint: string; head: string } | null = null;
    try {
      const candidates = ["artifacts/description.md", ".tanya/artifacts/description.md"];
      for (const rel of candidates) {
        const abs = resolve(root, rel);
        if (existsSync(abs)) {
          const head = (await readFile(abs, "utf8")).split("\n").slice(0, 24).join("\n");
          artifactsCatalog = { hint: `Read ${rel} (full file) for the complete artifact catalog before writing code from scratch.`, head };
          break;
        }
      }
    } catch {
      // best-effort
    }
    return {
      ok: true,
      summary: `Inspected ${files.length} workspace path${files.length === 1 ? "" : "s"} and found ${contextFiles.length} context file${contextFiles.length === 1 ? "" : "s"}${artifactsCatalog ? "; artifacts catalog detected" : ""}.`,
      output: {
        root: rootRel,
        platforms,
        packageScripts,
        contextFiles,
        ...(artifactsCatalog ? { artifactsCatalog } : {}),
        verification,
        notes: [
          "Read relevant context files before editing.",
          "Use find_reusable_artifacts before creating common app, backend, deployment, or UI patterns from scratch.",
        ],
      },
    };
  },
};

export const findReusableArtifactsTool: TanyaTool = {
  name: "find_reusable_artifacts",
  description: "Search local artifacts directories for reusable patterns matching a task, platform, or keyword.",
  definition: {
    type: "function",
    function: {
      name: "find_reusable_artifacts",
      description: "Search local artifacts directories for reusable patterns matching a task, platform, or keyword. Works with artifacts/ and .tanya/artifacts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Task text or search keywords." },
          platform: { type: "string", description: "Optional platform/category filter such as ios, android, backend, web, landing, testing, resources, apple." },
          artifactRoot: { type: "string", description: "Optional artifact root relative to the workspace. Default searches artifacts and .tanya/artifacts." },
          maxResults: { type: "number", description: "Maximum results. Default 12." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const query = asOptionalString(input, "query") ?? "";
    const platform = asOptionalString(input, "platform");
    const maxResults = Math.min(asOptionalNumber(input, "maxResults", 12), 50);
    const artifactRoot = asOptionalString(input, "artifactRoot");
    const artifacts = await findArtifacts({
      workspace: context.workspace,
      query,
      maxResults,
      ...(artifactRoot ? { artifactRoot } : {}),
      ...(platform ? { platform } : {}),
    });
    return {
      ok: true,
      summary: `Found ${artifacts.length} reusable artifact candidate${artifacts.length === 1 ? "" : "s"}.`,
      output: {
        query,
        platform: platform ?? null,
        artifacts,
        guidance: artifacts.length > 0
          ? "Read the relevant artifact path before adapting it, then report precise Artifact reused provenance."
          : "No matching local artifacts were found; proceed with repo patterns and create a reusable artifact only if the task produces a generally reusable pattern.",
      },
    };
  },
};

export const buildTaskBriefTool: TanyaTool = {
  name: "build_task_brief",
  description: "Build a deterministic pre-implementation brief from task text, local context files, artifacts, and verification hints.",
  definition: {
    type: "function",
    function: {
      name: "build_task_brief",
      description: "Build a deterministic pre-implementation brief from task text, local context files, artifacts, and verification hints.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The coding or project task to brief." },
          maxArtifacts: { type: "number", description: "Maximum artifact candidates. Default 12." },
          maxContextFiles: { type: "number", description: "Maximum context files to list. Default 16." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const task = asString(input, "task");
    const brief = await buildTaskBrief({
      workspace: context.workspace,
      task,
      maxArtifacts: Math.min(asOptionalNumber(input, "maxArtifacts", 12), 40),
      maxContextFiles: Math.min(asOptionalNumber(input, "maxContextFiles", 16), 50),
    });

    return {
      ok: true,
      summary: `Built task brief with ${brief.signals.platforms.length} platform signal${brief.signals.platforms.length === 1 ? "" : "s"}, ${brief.signals.domains.length} domain signal${brief.signals.domains.length === 1 ? "" : "s"}, and ${brief.artifacts.length} artifact candidate${brief.artifacts.length === 1 ? "" : "s"}.`,
      output: brief,
    };
  },
};
