import { buildRepoMap, readRepoMap } from "../context/repoMap";
import { RepoMapLangSchema, type RepoMapFile, type RepoMapLang } from "../context/repoMapSchema";
import type { TanyaTool } from "./types";

type InspectRepoMapInput = {
  file?: string;
  symbol?: string;
  lang?: RepoMapLang;
};

function asInput(input: unknown): InspectRepoMapInput {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const file = typeof record.file === "string" && record.file.trim() ? record.file.trim() : undefined;
  const symbol = typeof record.symbol === "string" && record.symbol.trim() ? record.symbol.trim() : undefined;
  const rawLang = typeof record.lang === "string" && record.lang.trim() ? record.lang.trim() : undefined;
  const lang = rawLang ? RepoMapLangSchema.parse(rawLang) : undefined;
  return {
    ...(file ? { file } : {}),
    ...(symbol ? { symbol } : {}),
    ...(lang ? { lang } : {}),
  };
}

function entryMatches(file: RepoMapFile, input: InspectRepoMapInput): boolean {
  if (input.file && !file.path.toLowerCase().includes(input.file.toLowerCase())) return false;
  if (input.lang && file.lang !== input.lang) return false;
  if (input.symbol) {
    const needle = input.symbol.toLowerCase();
    const symbolHit = file.symbols.some((symbol) => symbol.name.toLowerCase().includes(needle));
    const exportHit = file.exports.some((name) => name.toLowerCase().includes(needle));
    if (!symbolHit && !exportHit) return false;
  }
  return true;
}

function compactEntry(file: RepoMapFile): RepoMapFile {
  return {
    ...file,
    symbols: file.symbols.slice(0, 30),
    imports: file.imports.slice(0, 30),
    exports: file.exports.slice(0, 30),
  };
}

export const inspectRepoMapTool: TanyaTool = {
  name: "inspect_repo_map",
  description: "Inspect the cached structural repo-map by file, symbol, or language. Advisory only; read files before editing.",
  definition: {
    type: "function",
    function: {
      name: "inspect_repo_map",
      description: "Inspect structural repo-map entries by file, symbol, or language without spending prompt tokens on the full map.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Workspace-relative file path substring to inspect." },
          symbol: { type: "string", description: "Symbol/export substring to search for." },
          lang: { type: "string", enum: ["ts", "tsx", "js", "jsx", "py", "go", "swift", "kt", "unknown"], description: "Optional language filter." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const parsed = asInput(input);
    let map = readRepoMap(context.workspace);
    if (!map) map = await buildRepoMap(context.workspace, { writeCache: true });
    const matches = map.files
      .filter((file) => entryMatches(file, parsed))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 25)
      .map(compactEntry);
    return {
      ok: true,
      summary: `Found ${matches.length} repo-map file entr${matches.length === 1 ? "y" : "ies"}.`,
      output: {
        generatedAt: map.generatedAt,
        totalFiles: map.files.length,
        matches,
      },
    };
  },
};
