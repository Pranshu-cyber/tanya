import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { envValue } from "../config/envCompat";
import {
  REPO_MAP_SCHEMA_VERSION,
  REPO_MAP_VERSION,
  assertRepoMap,
  type RepoMap,
  type RepoMapFile,
  type RepoMapImport,
  type RepoMapLang,
  type RepoMapParser,
  type RepoMapSymbol,
  type RepoMapSymbolKind,
} from "./repoMapSchema";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILE_BYTES = 500 * 1024;
const SOURCE_EXTENSIONS = new Map<string, RepoMapLang>([
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".jsx", "jsx"],
  [".py", "py"],
  [".go", "go"],
  [".swift", "swift"],
  [".kt", "kt"],
]);

const SKIP_SEGMENTS = new Set([
  ".git",
  ".next",
  ".tanya",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const BINARY_EXTENSIONS = new Set([
  ".bin", ".dll", ".dylib", ".exe", ".gif", ".ico", ".jpg", ".jpeg", ".pdf", ".png", ".so",
  ".ttf", ".woff", ".woff2", ".zip",
]);

export type BuildRepoMapOptions = {
  maxFileBytes?: number;
  now?: Date;
  writeCache?: boolean;
  useCache?: boolean;
  headSha?: string | null;
};

type RepoMapMeta = {
  headSha: string | null;
  schemaVersion: number;
  generatedAt: string;
};

export type RepoMapDiagnostics = {
  fileCount: number;
  symbolCount: number;
  importCount: number;
  parserCounts: Record<RepoMapParser, number>;
  estimatedTokens: number;
  generatedAt?: string;
};

export async function buildRepoMap(workspace: string, options: BuildRepoMapOptions = {}): Promise<RepoMap> {
  const root = resolve(workspace);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const maxFileBytes = options.maxFileBytes ?? configuredMaxFileBytes();
  const headSha = options.headSha === undefined ? await currentHeadSha(root) : options.headSha;
  const cached = options.writeCache && options.useCache !== false ? readRepoMap(root) : null;
  const cachedMeta = options.writeCache && options.useCache !== false ? readRepoMapMeta(root) : null;
  const canReuseCache = Boolean(
    cached &&
    cachedMeta &&
    cached.schemaVersion === REPO_MAP_SCHEMA_VERSION &&
    cachedMeta.schemaVersion === REPO_MAP_SCHEMA_VERSION &&
    cachedMeta.headSha === headSha,
  );
  const cachedByPath = canReuseCache
    ? new Map(cached?.files.map((file) => [file.path, file]) ?? [])
    : new Map<string, RepoMapFile>();
  const files = await listIndexableFiles(root);
  const entries = files
    .map((path) => indexFile(root, path, maxFileBytes, generatedAt, cachedByPath.get(path)))
    .filter((entry): entry is RepoMapFile => entry !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
  const map = assertRepoMap({
    version: REPO_MAP_VERSION,
    workspace: root,
    generatedAt,
    schemaVersion: REPO_MAP_SCHEMA_VERSION,
    files: entries,
  });
  if (options.writeCache) {
    writeRepoMap(root, map);
    writeRepoMapMeta(root, { headSha, schemaVersion: REPO_MAP_SCHEMA_VERSION, generatedAt });
  }
  return map;
}

export function repoMapCachePath(workspace: string): string {
  return join(resolve(workspace), ".tanya", "index", "repo-map.json");
}

export function repoMapMetaPath(workspace: string): string {
  return join(resolve(workspace), ".tanya", "index", "repo-map-meta.json");
}

export function writeRepoMap(workspace: string, map: RepoMap): void {
  const path = repoMapCachePath(workspace);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

export function readRepoMap(workspace: string): RepoMap | null {
  const path = repoMapCachePath(workspace);
  if (!existsSync(path)) return null;
  try {
    return assertRepoMap(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function readRepoMapMeta(workspace: string): RepoMapMeta | null {
  const path = repoMapMetaPath(workspace);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RepoMapMeta>;
    return {
      headSha: typeof parsed.headSha === "string" ? parsed.headSha : null,
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeRepoMapMeta(workspace: string, meta: RepoMapMeta): void {
  const path = repoMapMetaPath(workspace);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export function repoMapDiagnostics(map: RepoMap): RepoMapDiagnostics {
  const parserCounts: Record<RepoMapParser, number> = { "tree-sitter": 0, ripgrep: 0, path: 0 };
  let symbolCount = 0;
  let importCount = 0;
  for (const file of map.files) {
    parserCounts[file.parser] += 1;
    symbolCount += file.symbols.length;
    importCount += file.imports.length;
  }
  return {
    fileCount: map.files.length,
    symbolCount,
    importCount,
    parserCounts,
    estimatedTokens: estimateRepoMapTokens(map),
    generatedAt: map.generatedAt,
  };
}

export function estimateRepoMapTokens(map: Pick<RepoMap, "files">): number {
  return Math.ceil(JSON.stringify(map.files).length / 4);
}

async function listIndexableFiles(workspace: string): Promise<string[]> {
  const gitFiles = await listGitFiles(workspace);
  const files = gitFiles.length > 0 ? gitFiles : await listRecursiveFiles(workspace);
  return files
    .filter((path) => shouldConsiderPath(path))
    .sort((a, b) => a.localeCompare(b));
}

async function listGitFiles(workspace: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function currentHeadSha(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function listRecursiveFiles(workspace: string, dir = workspace): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(workspace, abs).split(sep).join("/");
    if (entry.isDirectory()) {
      if (!shouldTraversePath(rel)) continue;
      files.push(...await listRecursiveFiles(workspace, abs));
    } else if (entry.isFile()) {
      if (!shouldConsiderPath(rel)) continue;
      files.push(rel);
    }
  }
  return files;
}

function shouldConsiderPath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  if (!shouldTraversePath(normalized)) return false;
  if (/(^|\/)[^/]*\.generated\.[^/]+$/i.test(normalized)) return false;
  const ext = extension(normalized);
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return SOURCE_EXTENSIONS.has(ext);
}

function shouldTraversePath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  return !normalized.split("/").some((part) => SKIP_SEGMENTS.has(part));
}

function indexFile(workspace: string, relPath: string, maxFileBytes: number, generatedAt: string, cached?: RepoMapFile): RepoMapFile | null {
  const abs = resolve(workspace, relPath);
  let size = 0;
  let mtime = generatedAt;
  try {
    const stat = statSync(abs);
    size = stat.size;
    mtime = stat.mtime.toISOString();
    if (size > maxFileBytes) return null;
    if (cached && cached.lastIndexed === mtime && cached.size === size) return cached;
  } catch {
    return null;
  }
  const lang = langForPath(relPath);
  let content = "";
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return {
      path: relPath,
      lang,
      parser: "path",
      lastIndexed: mtime,
      size,
      symbols: [],
      imports: [],
      exports: [],
    };
  }
  const symbols = extractSymbols(content, lang);
  const imports = extractImports(content, lang);
  const exports = extractExports(content, lang, symbols);
  return {
    path: relPath,
    lang,
    parser: lang === "unknown" ? "path" : "ripgrep",
    lastIndexed: mtime,
    size,
    symbols,
    imports,
    exports,
  };
}

function extractSymbols(content: string, lang: RepoMapLang): RepoMapSymbol[] {
  const symbols: RepoMapSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    for (const symbol of symbolsForLine(line, lang, lineNo)) symbols.push(symbol);
  }
  return uniqueSymbols(symbols);
}

function symbolsForLine(line: string, lang: RepoMapLang, lineNo: number): RepoMapSymbol[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return [];
  switch (lang) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return compactSymbols([
        matchSymbol(trimmed, /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/, "function", lineNo),
        matchSymbol(trimmed, /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class", lineNo),
        matchSymbol(trimmed, /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, "const", lineNo),
        matchSymbol(trimmed, /^(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)\b/, "type", lineNo),
        matchSymbol(trimmed, /^export\s*\{\s*([A-Za-z_$][\w$]*)\b/, "export", lineNo),
        line.startsWith(" ") || line.startsWith("\t")
          ? matchSymbol(trimmed, /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?$/, "method", lineNo)
          : null,
      ]);
    case "py":
      return compactSymbols([
        matchSymbol(trimmed, /^def\s+([A-Za-z_]\w*)\b/, "function", lineNo),
        matchSymbol(trimmed, /^async\s+def\s+([A-Za-z_]\w*)\b/, "function", lineNo),
        matchSymbol(trimmed, /^class\s+([A-Za-z_]\w*)\b/, "class", lineNo),
      ]);
    case "go":
      return compactSymbols([
        matchSymbol(trimmed, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\b/, "function", lineNo),
        matchSymbol(trimmed, /^type\s+([A-Za-z_]\w*)\b/, "type", lineNo),
        matchSymbol(trimmed, /^(?:const|var)\s+([A-Za-z_]\w*)\b/, "const", lineNo),
      ]);
    case "swift":
      return compactSymbols([
        matchSymbol(trimmed, /^(?:public\s+|private\s+|internal\s+|open\s+)?func\s+([A-Za-z_]\w*)\b/, "function", lineNo),
        matchSymbol(trimmed, /^(?:public\s+|private\s+|internal\s+|open\s+)?(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)\b/, "class", lineNo),
        matchSymbol(trimmed, /^(?:public\s+|private\s+|internal\s+|open\s+)?(?:let|var)\s+([A-Za-z_]\w*)\b/, "const", lineNo),
      ]);
    case "kt":
      return compactSymbols([
        matchSymbol(trimmed, /^(?:public\s+|private\s+|internal\s+)?fun\s+([A-Za-z_]\w*)\b/, "function", lineNo),
        matchSymbol(trimmed, /^(?:public\s+|private\s+|internal\s+)?(?:class|object|interface)\s+([A-Za-z_]\w*)\b/, "class", lineNo),
        matchSymbol(trimmed, /^(?:public\s+|private\s+|internal\s+)?(?:val|var)\s+([A-Za-z_]\w*)\b/, "const", lineNo),
        matchSymbol(trimmed, /^typealias\s+([A-Za-z_]\w*)\b/, "type", lineNo),
      ]);
    default:
      return [];
  }
}

function matchSymbol(line: string, pattern: RegExp, kind: RepoMapSymbolKind, lineNo: number): RepoMapSymbol | null {
  const match = line.match(pattern);
  const name = match?.[1];
  return name ? { name, kind, line: lineNo } : null;
}

function compactSymbols(symbols: Array<RepoMapSymbol | null>): RepoMapSymbol[] {
  return symbols.filter((symbol): symbol is RepoMapSymbol => Boolean(symbol));
}

function uniqueSymbols(symbols: RepoMapSymbol[]): RepoMapSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.name}:${symbol.kind}:${symbol.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractImports(content: string, lang: RepoMapLang): RepoMapImport[] {
  const imports: RepoMapImport[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (["ts", "tsx", "js", "jsx"].includes(lang)) {
      const from = trimmed.match(/^import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      if (from?.[1]) imports.push({ from: from[1], ...namedImport(trimmed) });
      const req = trimmed.match(/require\(['"]([^'"]+)['"]\)/);
      if (req?.[1]) imports.push({ from: req[1] });
    } else if (lang === "py") {
      const from = trimmed.match(/^from\s+([A-Za-z0-9_./]+)\s+import\s+(.+)$/);
      if (from?.[1]) imports.push({ from: from[1], named: splitNames(from[2] ?? "") });
      const plain = trimmed.match(/^import\s+(.+)$/);
      if (plain?.[1]) imports.push(...splitNames(plain[1]).map((name) => ({ from: name })));
    } else if (lang === "go") {
      const quoted = trimmed.match(/^"([^"]+)"$/) ?? trimmed.match(/^import\s+"([^"]+)"/);
      if (quoted?.[1]) imports.push({ from: quoted[1] });
    } else if (lang === "swift") {
      const imported = trimmed.match(/^import\s+([A-Za-z0-9_]+)/);
      if (imported?.[1]) imports.push({ from: imported[1] });
    } else if (lang === "kt") {
      const imported = trimmed.match(/^import\s+([A-Za-z0-9_.]+)(?:\.\*)?/);
      if (imported?.[1]) imports.push({ from: imported[1] });
    }
  }
  return uniqueImports(imports);
}

function namedImport(line: string): { named?: string[] } {
  const named = line.match(/\{\s*([^}]+?)\s*\}/);
  const names = splitNames(named?.[1] ?? "");
  return names.length > 0 ? { named: names } : {};
}

function splitNames(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().replace(/\s+as\s+.+$/i, "").replace(/\s+from\s+.+$/i, ""))
    .filter(Boolean);
}

function uniqueImports(imports: RepoMapImport[]): RepoMapImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = `${entry.from}:${entry.named?.join(",") ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractExports(content: string, lang: RepoMapLang, symbols: RepoMapSymbol[]): string[] {
  const exports = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const direct = trimmed.match(/^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+([A-Za-z_$][\w$]*)\b/);
    if (direct?.[1]) exports.add(direct[1]);
    const list = trimmed.match(/^export\s*\{\s*([^}]+)\s*\}/);
    if (list?.[1]) for (const name of splitNames(list[1])) exports.add(name);
  }
  if (["py", "go", "swift", "kt"].includes(lang)) {
    for (const symbol of symbols) {
      if (!symbol.name.startsWith("_")) exports.add(symbol.name);
    }
  }
  return [...exports].sort((a, b) => a.localeCompare(b));
}

function langForPath(path: string): RepoMapLang {
  return SOURCE_EXTENSIONS.get(extension(path)) ?? "unknown";
}

function extension(path: string): string {
  const match = path.match(/(\.[^.\/]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

function configuredMaxFileBytes(): number {
  const raw = envValue(process.env, "TANYA_REPO_MAP_MAX_FILE_BYTES");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FILE_BYTES;
}
