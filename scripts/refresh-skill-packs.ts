import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Args = {
  apply: boolean;
  packSlug?: string;
};

type Pack = {
  slug: string;
  title: string;
  path: string;
  relativePath: string;
  mtimeMs: number;
  canonicalSources: string[];
};

type SourceAudit = {
  source: string;
  kind: "local" | "external" | "unresolved";
  exists: boolean;
  newerThanPack: boolean;
  mtimeIso?: string;
  note: string;
};

type PackAudit = {
  pack: Pack;
  sources: SourceAudit[];
  needsReview: boolean;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const skillsRoot = join(repoRoot, "src/skills");
const planPath = join(repoRoot, "docs/expertise-pack-refresh-plan.md");

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--pack") {
      const value = argv[index + 1];
      if (!value) throw new Error("--pack requires a skill-pack slug");
      args.packSlug = value.replace(/^\/+|\/+$/g, "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function walkMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
    }
  }
  walk(root);
  return files.sort();
}

function parseFrontmatter(text: string): Record<string, string> | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const frontmatter = text.slice(4, end).split(/\r?\n/);
  const parsed: Record<string, string> = {};
  for (const line of frontmatter) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2]) parsed[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return parsed;
}

function extractCanonicalSources(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Canonical sources");
  if (start < 0) return [];
  const sources: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("## ")) break;
    if (!line.startsWith("- ")) continue;
    const source = line
      .slice(2)
      .trim()
      .replace(/^`|`$/g, "");
    if (source) sources.push(source);
  }
  return sources;
}

function loadPacks(args: Args): Pack[] {
  const packs: Pack[] = [];
  for (const path of walkMarkdownFiles(skillsRoot)) {
    const text = readFileSync(path, "utf8");
    const frontmatter = parseFrontmatter(text);
    if (!frontmatter?.slug) {
      console.warn(`Skipping pack with invalid frontmatter: ${path}`);
      continue;
    }
    const stat = statSync(path);
    const relativePath = relative(skillsRoot, path).replace(/\\/g, "/");
    packs.push({
      slug: frontmatter.slug,
      title: frontmatter.title ?? frontmatter.slug,
      path,
      relativePath,
      mtimeMs: stat.mtimeMs,
      canonicalSources: extractCanonicalSources(text),
    });
  }

  if (!args.packSlug) return packs.sort((a, b) => a.slug.localeCompare(b.slug));
  const filtered = packs.filter((pack) => pack.slug === args.packSlug || pack.relativePath.replace(/\.md$/, "") === args.packSlug);
  if (filtered.length === 0) throw new Error(`No skill pack matched --pack ${args.packSlug}`);
  return filtered.sort((a, b) => a.slug.localeCompare(b.slug));
}

function auditSource(source: string, pack: Pack): SourceAudit {
  if (/^https?:\/\//.test(source)) {
    return {
      source,
      kind: "external",
      exists: true,
      newerThanPack: false,
      note: "external source; refresh manually",
    };
  }

  const candidatePath = source.startsWith("/") ? source : resolve(repoRoot, source);
  if (!existsSync(candidatePath)) {
    return {
      source,
      kind: source.startsWith("/") ? "local" : "unresolved",
      exists: false,
      newerThanPack: false,
      note: "missing canonical source",
    };
  }

  const sourceStat = statSync(candidatePath);
  const newerThanPack = sourceStat.mtimeMs > pack.mtimeMs;
  return {
    source,
    kind: "local",
    exists: true,
    newerThanPack,
    mtimeIso: new Date(sourceStat.mtimeMs).toISOString(),
    note: newerThanPack ? "source changed after pack" : "source older than pack",
  };
}

function auditPacks(packs: Pack[]): PackAudit[] {
  return packs.map((pack) => {
    const sources = pack.canonicalSources.map((source) => auditSource(source, pack));
    return {
      pack,
      sources,
      needsReview: sources.some((source) => !source.exists || source.newerThanPack),
    };
  });
}

function renderReport(audits: PackAudit[]): string {
  const candidates = audits.filter((audit) => audit.needsReview);
  const sourceCount = audits.reduce((count, audit) => count + audit.sources.length, 0);
  const missingCount = audits.reduce((count, audit) => count + audit.sources.filter((source) => !source.exists).length, 0);
  const newerCount = audits.reduce((count, audit) => count + audit.sources.filter((source) => source.newerThanPack).length, 0);

  const lines: string[] = [
    "# Expertise Pack Refresh Plan",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Packs scanned: ${audits.length}`,
    `Canonical sources checked: ${sourceCount}`,
    `Candidate packs for review: ${candidates.length}`,
    `Missing sources: ${missingCount}`,
    `Sources newer than pack: ${newerCount}`,
    "",
    "## Planned actions",
    "",
  ];

  if (candidates.length === 0) {
    lines.push("- No packs need review from local source mtime or missing-source checks.");
  } else {
    lines.push("| Pack | Reason | Source |");
    lines.push("|------|--------|--------|");
    for (const audit of candidates) {
      for (const source of audit.sources.filter((entry) => !entry.exists || entry.newerThanPack)) {
        const reason = source.exists ? "source changed after pack" : "source missing";
        lines.push(`| \`${audit.pack.slug}\` | ${reason} | \`${source.source}\` |`);
      }
    }
  }

  lines.push("", "## Source audit", "");
  lines.push("| Pack | Source | Exists | Newer than pack | Note |");
  lines.push("|------|--------|--------|-----------------|------|");
  for (const audit of audits) {
    if (audit.sources.length === 0) {
      lines.push(`| \`${audit.pack.slug}\` | _none listed_ | no | no | missing Canonical sources section |`);
      continue;
    }
    for (const source of audit.sources) {
      lines.push(`| \`${audit.pack.slug}\` | \`${source.source}\` | ${source.exists ? "yes" : "no"} | ${source.newerThanPack ? "yes" : "no"} | ${source.note} |`);
    }
  }

  lines.push("", "## Next manual steps", "");
  lines.push("1. Read each candidate pack and canonical source side by side.");
  lines.push("2. Decide whether the drift is a source move, a brief error, or a real house-style change.");
  lines.push("3. Update one pack per commit, then run the expertise eval harness.");
  lines.push("4. Mirror cascading corrections across related packs before shipping.");

  return `${lines.join("\n")}\n`;
}

function printConsoleSummary(report: string): void {
  const cutoff = report.indexOf("\n## Source audit");
  console.log(cutoff >= 0 ? report.slice(0, cutoff).trimEnd() : report.trimEnd());
  console.log("");
  console.log(`Full source audit written to ${planPath}`);
}

function collectFrameworkVersions(): void {
  // TODO: Query npm, Swift Package Index, Maven Central, Go modules, PyPI, cargo, and platform release feeds for frameworks named in loaded packs.
  // TODO: Compare discovered versions against explicit versions documented in pack prose and flag major-version drift.
}

function runEvalHarness(): void {
  // TODO: Invoke `npx tsx scripts/grade-expertise.ts --run-live` and summarize task-level PASS/FAIL deltas from the last committed RESULTS.md.
  spawnSync;
}

function proposeUpdates(): void {
  // TODO: For each drift candidate, generate a focused patch proposal that preserves frontmatter, canonical sources, and pack token budget.
  // TODO: If automation owns a branch, open a draft PR with one commit per pack and attach the eval-harness delta.
}

function applyUpdates(): void {
  // TODO: Wire `--apply` to write approved patches only after source audit, version check, eval baseline, and human review gates pass.
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.apply) {
    console.log("Apply mode is not implemented. Run without --apply to generate a plan-only refresh report.");
    applyUpdates;
    return;
  }

  collectFrameworkVersions();
  runEvalHarness();
  proposeUpdates();

  const packs = loadPacks(args);
  const audits = auditPacks(packs);
  const report = renderReport(audits);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, report, "utf8");
  printConsoleSummary(report);
}

main();
