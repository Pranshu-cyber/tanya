import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ignoredNames = new Set([".obsidian", ".trash", ".git", "node_modules", ".tanya"]);

const stopwords = new Set([
  "a",
  "an",
  "and",
  "app",
  "as",
  "at",
  "by",
  "create",
  "for",
  "from",
  "in",
  "new",
  "of",
  "on",
  "or",
  "the",
  "to",
  "up",
  "use",
  "with",
]);

export type ObsidianSearchResult = {
  path: string;
  title: string;
  score: number;
  reason: string;
  excerpt: string;
  modifiedAt: string | null;
};

export type MaterializedObsidianContext = {
  contextFiles: Array<{
    path: string;
    sourcePath: string;
    role: "obsidian-note";
    status: "available";
    reason: string;
  }>;
  notes: ObsidianSearchResult[];
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_+-]{2,}/g) ?? [])]
    .filter((term) => !stopwords.has(term));
}

async function collectMarkdownFiles(root: string, maxFiles: number, current = root, out: string[] = []): Promise<string[]> {
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
    if (entry.isDirectory()) {
      await collectMarkdownFiles(root, maxFiles, fullPath, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function titleFromMarkdown(path: string, markdown: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

function redactSecrets(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (/placeholder|example|changeme|your_|<[^>]+>|\$\{|process\.env|env\(/i.test(line)) return line;
      if (/\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|database_url)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i.test(line)) {
        return "[redacted possible secret]";
      }
      return line;
    })
    .join("\n");
}

function excerptFor(markdown: string, queryTerms: string[], maxChars: number): string {
  const redacted = redactSecrets(markdown);
  const lines = redacted.split(/\r?\n/);
  const firstMatch = lines.findIndex((line) => queryTerms.some((term) => line.toLowerCase().includes(term)));
  const start = firstMatch >= 0 ? Math.max(0, firstMatch - 3) : 0;
  const excerpt = lines.slice(start, start + 12).join("\n").trim() || redacted.slice(0, maxChars);
  return excerpt.length > maxChars ? `${excerpt.slice(0, maxChars)}\n[truncated]` : excerpt;
}

function scoreNote(relPath: string, title: string, markdown: string, queryTerms: string[]): { score: number; reason: string } {
  const lowerPath = relPath.toLowerCase();
  const lowerTitle = title.toLowerCase();
  const lowerMarkdown = markdown.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const term of queryTerms) {
    if (lowerPath.includes(term)) {
      score += 5;
      reasons.push(`path:${term}`);
    }
    if (lowerTitle.includes(term)) {
      score += 5;
      reasons.push(`title:${term}`);
    }
    if (lowerMarkdown.includes(term)) {
      score += 1;
      reasons.push(`body:${term}`);
    }
  }
  return { score, reason: reasons.length ? [...new Set(reasons)].join(", ") : "recent note fallback" };
}

function safeMaterializedPath(relPath: string): string {
  return normalizePath(relPath)
    .replace(/^\.+\/?/, "")
    .replace(/[^A-Za-z0-9._/-]/g, "_")
    .replace(/\/+/g, "/");
}

export async function searchObsidianNotes(input: {
  vaultPath: string;
  query: string;
  maxResults?: number;
  maxFiles?: number;
  maxExcerptChars?: number;
}): Promise<ObsidianSearchResult[]> {
  const vault = resolve(input.vaultPath);
  if (!existsSync(vault)) return [];
  const queryTerms = terms(input.query);
  const maxResults = Math.min(input.maxResults ?? 5, 20);
  const maxFiles = Math.min(input.maxFiles ?? 1_000, 5_000);
  const maxExcerptChars = Math.min(input.maxExcerptChars ?? 1_800, 8_000);
  const files = await collectMarkdownFiles(vault, maxFiles);
  const results: ObsidianSearchResult[] = [];

  for (const file of files) {
    let markdown = "";
    try {
      markdown = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const relPath = normalizePath(relative(vault, file));
    const title = titleFromMarkdown(relPath, markdown);
    const scored = scoreNote(relPath, title, markdown, queryTerms);
    if (queryTerms.length > 0 && scored.score <= 0) continue;
    const fileStat = await stat(file);
    results.push({
      path: relPath,
      title,
      score: scored.score,
      reason: scored.reason,
      excerpt: excerptFor(markdown, queryTerms, maxExcerptChars),
      modifiedAt: Number.isFinite(fileStat.mtimeMs) ? fileStat.mtime.toISOString() : null,
    });
  }

  return results
    .sort((a, b) => b.score - a.score || String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")) || a.path.localeCompare(b.path))
    .slice(0, maxResults);
}

export async function materializeObsidianContext(input: {
  workspace: string;
  vaultPath: string;
  query: string;
  maxResults?: number;
  keepContext?: boolean;
}): Promise<MaterializedObsidianContext> {
  const notes = await searchObsidianNotes({
    vaultPath: input.vaultPath,
    query: input.query,
    maxResults: input.maxResults ?? 5,
  });
  const contextRoot = resolve(input.workspace, ".tanya", "context", "obsidian");
  const contextFiles: MaterializedObsidianContext["contextFiles"] = [];
  for (const note of notes) {
    const targetRel = safeMaterializedPath(note.path);
    const targetPath = resolve(contextRoot, targetRel);
    const localPath = `.tanya/context/obsidian/${normalizePath(targetRel)}`;
    const content = [
      `# ${note.title}`,
      "",
      `Source: ${note.path}`,
      `Score: ${note.score}`,
      `Reason: ${note.reason}`,
      note.modifiedAt ? `Modified: ${note.modifiedAt}` : null,
      "",
      "## Excerpt",
      "",
      note.excerpt,
      "",
    ].filter((line): line is string => typeof line === "string").join("\n");
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
    contextFiles.push({
      path: localPath,
      sourcePath: note.path,
      role: "obsidian-note",
      status: "available",
      reason: "Materialized from the configured Obsidian vault by task-term search.",
    });
  }

  if (contextFiles.length > 0) {
    await mkdir(contextRoot, { recursive: true });
    await writeFile(
      resolve(contextRoot, "manifest.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), query: input.query, notes }, null, 2),
      "utf8",
    );
  }

  return { contextFiles, notes };
}
