import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import type { Verifier, VerifierCheck, VerifierContext } from "../types";
import { makeCheck } from "../types";
import { combinedTaskText, mentionsAny } from "../textHints";

const HUMA_PATTERNS = [/\bhuma\b/i, /\bhuma\/v2\b/i];
const CHI_PATTERNS = [/\bgo-?chi\b/i, /\bchi\/v5\b/i, /\bchi router\b/i];
const PGX_PATTERNS = [/\bpgx\b/i, /\bjackc\/pgx\b/i, /\bpostgres\b/i, /\bpostgresql\b/i];
const REST_SERVER_PATTERNS = [/\bcmd\/server\b/i, /\bmain\.go\b/i, /\brest server\b/i, /\bhttp server\b/i];
const INTERNAL_PKG_PATTERNS = [...REST_SERVER_PATTERNS, /\binternal\//i];
const SQLC_PATTERNS = [/\bsqlc\b/i];

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function dirContainsGoFile(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const entry of listDir(path)) {
    const full = join(path, entry);
    try {
      const st = statSync(full);
      if (st.isFile() && entry.endsWith(".go")) return true;
      if (st.isDirectory() && dirContainsGoFile(full)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

type GoFileScan = { hasAnyGoFile: boolean; hasAnyTestFile: boolean };

function scanGoFiles(workspace: string): GoFileScan {
  const queue = [workspace];
  let visited = 0;
  let hasAnyGoFile = false;
  let hasAnyTestFile = false;
  while (queue.length > 0 && visited < 500) {
    const dir = queue.shift();
    if (!dir) break;
    visited += 1;
    for (const entry of listDir(dir)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isFile() && entry.endsWith(".go")) {
          hasAnyGoFile = true;
          if (entry.endsWith("_test.go")) hasAnyTestFile = true;
        }
        if (st.isDirectory()) queue.push(full);
      } catch {
        // ignore
      }
    }
  }
  return { hasAnyGoFile, hasAnyTestFile };
}

function parseSqlcGenDirs(text: string): string[] {
  const dirs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(/^\s*out\s*:\s*["']?([^"'\s#]+)/i);
    if (match?.[1]) dirs.push(match[1]);
  }
  return dirs;
}

type SqlcConfigEntry = {
  outDirs: string[];
  queryPaths: string[];
};

function stringsFromSqlcValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFromSqlcValue(item));
  }
  return [];
}

function parseSqlcConfig(text: string): SqlcConfigEntry[] {
  try {
    const parsed = loadYaml(text);
    if (!parsed || typeof parsed !== "object") {
      return parseSqlcGenDirs(text).map((dir) => ({ outDirs: [dir], queryPaths: [] }));
    }
    const root = parsed as Record<string, unknown>;
    const sql = Array.isArray(root.sql) ? root.sql : [];
    const entries: SqlcConfigEntry[] = [];
    for (const rawEntry of sql) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Record<string, unknown>;
      const queryPaths = stringsFromSqlcValue(entry.queries);
      const gen = entry.gen;
      const outDirs: string[] = [];
      if (gen && typeof gen === "object" && !Array.isArray(gen)) {
        for (const rawGenConfig of Object.values(gen as Record<string, unknown>)) {
          if (!rawGenConfig || typeof rawGenConfig !== "object" || Array.isArray(rawGenConfig)) continue;
          const out = (rawGenConfig as Record<string, unknown>).out;
          if (typeof out === "string") outDirs.push(out);
        }
      }
      if (typeof entry.out === "string") outDirs.push(entry.out);
      entries.push({ outDirs, queryPaths });
    }
    return entries;
  } catch {
    return parseSqlcGenDirs(text).map((dir) => ({ outDirs: [dir], queryPaths: [] }));
  }
}

function sqlFilesUnder(path: string): string[] {
  try {
    const st = statSync(path);
    if (st.isFile()) return path.endsWith(".sql") ? [path] : [];
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const queue = [path];
  let visited = 0;
  while (queue.length > 0 && visited < 500) {
    const dir = queue.shift();
    if (!dir) break;
    visited += 1;
    for (const entry of listDir(dir)) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isFile() && entry.endsWith(".sql")) out.push(full);
        if (st.isDirectory()) queue.push(full);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out);
}

function referencedSqlQueryFiles(workspace: string, queryPath: string): string[] {
  const cleanQueryPath = queryPath.trim();
  if (!cleanQueryPath) return [];
  if (!/[*?]/.test(cleanQueryPath)) {
    return sqlFilesUnder(join(workspace, cleanQueryPath));
  }

  const firstGlob = cleanQueryPath.search(/[*?]/);
  const prefix = cleanQueryPath.slice(0, firstGlob);
  const searchRoot = resolve(workspace, dirname(prefix || "."));
  const workspaceRoot = resolve(workspace);
  if (relative(workspaceRoot, searchRoot).startsWith("..")) return [];

  const matcher = globToRegExp(cleanQueryPath.replace(/\\/g, "/"));
  return sqlFilesUnder(searchRoot).filter((file) => {
    const rel = relative(workspaceRoot, file).replace(/\\/g, "/");
    return matcher.test(rel);
  });
}

function hasReferencedSqlQueries(workspace: string, queryPaths: string[]): boolean {
  return queryPaths.some((queryPath) => referencedSqlQueryFiles(workspace, queryPath).length > 0);
}

export const goBackendVerifier: Verifier = {
  id: "go-backend",
  platform: "go-backend",
  appliesTo(ctx) {
    if (ctx.fileExists(join(ctx.workspace, "go.mod"))) return true;
    const text = combinedTaskText(ctx.runContext, ctx.prompt);
    return /\bgo\.mod\b/.test(text) || /\bgolang\b/.test(text);
  },
  async run(ctx) {
    const checks: VerifierCheck[] = [];
    const goModPath = join(ctx.workspace, "go.mod");
    const goModText = ctx.readText(goModPath);
    const text = combinedTaskText(ctx.runContext, ctx.prompt);

    checks.push(makeCheck({
      id: "go.mod-present",
      description: "go.mod exists",
      passed: goModText !== null,
      authoritative: false,
      error: goModText === null ? `go.mod not found at ${goModPath}` : undefined,
    }));

    const requireDep = (depPattern: RegExp, depLabel: string, requiredWhen: boolean) => {
      if (!requiredWhen) return;
      const present = goModText !== null && depPattern.test(goModText);
      checks.push(makeCheck({
        id: `go.mod-dep-${depLabel}`,
        description: `go.mod declares ${depLabel}`,
        passed: present,
        authoritative: false,
        error: present ? undefined : `expected ${depLabel} dependency in go.mod`,
      }));
    };

    requireDep(/github\.com\/danielgtaylor\/huma\/v2/, "huma/v2", mentionsAny(text, HUMA_PATTERNS));
    requireDep(/github\.com\/go-chi\/chi\/v5/, "chi/v5", mentionsAny(text, CHI_PATTERNS));
    requireDep(/github\.com\/jackc\/pgx\/v5/, "pgx/v5", mentionsAny(text, PGX_PATTERNS));

    if (mentionsAny(text, REST_SERVER_PATTERNS)) {
      const mainPath = join(ctx.workspace, "cmd", "server", "main.go");
      const present = ctx.fileExists(mainPath);
      checks.push(makeCheck({
        id: "cmd-server-main",
        description: "cmd/server/main.go exists",
        passed: present,
        authoritative: false,
        error: present ? undefined : "expected entrypoint at cmd/server/main.go",
      }));
    }

    const internalPath = join(ctx.workspace, "internal");
    if (mentionsAny(text, INTERNAL_PKG_PATTERNS)) {
      const hasInternalGo = dirContainsGoFile(internalPath);
      checks.push(makeCheck({
        id: "internal-packages",
        description: "internal/ contains at least one Go package",
        passed: hasInternalGo,
        authoritative: false,
        error: hasInternalGo ? undefined : "expected at least one Go package under internal/",
      }));
    }

    const sqlcPath = join(ctx.workspace, "sqlc.yaml");
    const sqlcText = ctx.readText(sqlcPath);
    if (sqlcText && mentionsAny(text, SQLC_PATTERNS)) {
      for (const entry of parseSqlcConfig(sqlcText)) {
        const hasQueries = hasReferencedSqlQueries(ctx.workspace, entry.queryPaths);
        for (const dir of entry.outDirs) {
          if (!hasQueries) {
            checks.push(makeCheck({
              id: `sqlc-out-${dir}`,
              description: `sqlc generated code present at ${dir}`,
              passed: true,
              authoritative: false,
              skipped: true,
              evidence: "skipped: sqlc.yaml does not reference any existing .sql query files yet",
            }));
            continue;
          }
          const target = join(ctx.workspace, dir);
          const present = ctx.fileExists(target) && dirContainsGoFile(target);
          checks.push(makeCheck({
            id: `sqlc-out-${dir}`,
            description: `sqlc generated code present at ${dir}`,
            passed: present,
            authoritative: false,
            error: present ? undefined : `sqlc.yaml references ${dir} but no Go files were generated there`,
          }));
        }
      }
    }

    const scan = scanGoFiles(ctx.workspace);
    if (goModText !== null && !scan.hasAnyGoFile) {
      checks.push(makeCheck({
        id: "go-build",
        description: "go build ./...",
        passed: true,
        authoritative: true,
        evidence: "skipped: no Go source files in workspace yet",
      }));
      return checks;
    }
    if (goModText !== null) {
      const buildResult = await ctx.shell(ctx.workspace, "go", ["build", "./..."], { timeoutMs: 90_000 });
      if (buildResult.binaryMissing) {
        checks.push(makeCheck({
          id: "go-toolchain-missing",
          description: "go toolchain available",
          passed: true,
          authoritative: false,
          evidence: "skipped: 'go' binary not found on PATH",
        }));
        return checks;
      }
      const buildPassed = buildResult.exit === 0;
      checks.push(makeCheck({
        id: "go-build",
        description: "go build ./...",
        passed: buildPassed,
        authoritative: true,
        evidence: buildPassed ? "go build ./... -> exit 0" : undefined,
        error: buildPassed ? undefined : (buildResult.stderr || buildResult.stdout || "go build failed").slice(0, 500),
      }));

      if (buildPassed) {
        const vetResult = await ctx.shell(ctx.workspace, "go", ["vet", "./..."], { timeoutMs: 60_000 });
        const vetPassed = vetResult.exit === 0;
        checks.push(makeCheck({
          id: "go-vet",
          description: "go vet ./...",
          passed: vetPassed,
          authoritative: false,
          evidence: vetPassed ? "go vet ./... -> exit 0" : undefined,
          error: vetPassed ? undefined : (vetResult.stderr || vetResult.stdout || "go vet failed").slice(0, 500),
        }));

        if (scan.hasAnyTestFile) {
          const testResult = await ctx.shell(ctx.workspace, "go", ["test", "./..."], { timeoutMs: 180_000 });
          const testPassed = testResult.exit === 0;
          checks.push(makeCheck({
            id: "go-test",
            description: "go test ./...",
            passed: testPassed,
            authoritative: true,
            evidence: testPassed ? "go test ./... -> exit 0" : undefined,
            error: testPassed ? undefined : (testResult.stderr || testResult.stdout || "go test failed").slice(0, 800),
          }));
        }
      }
    }

    return checks;
  },
};
