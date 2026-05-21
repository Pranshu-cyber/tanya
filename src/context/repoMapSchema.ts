import { z } from "zod";

export const REPO_MAP_VERSION = 1;
export const REPO_MAP_SCHEMA_VERSION = 1;

export const RepoMapLangSchema = z.enum(["ts", "tsx", "js", "jsx", "py", "go", "swift", "kt", "unknown"]);
export const RepoMapParserSchema = z.enum(["tree-sitter", "ripgrep", "path"]);
export const RepoMapSymbolKindSchema = z.enum(["function", "class", "method", "const", "type", "export"]);

export const RepoMapSymbolSchema = z.object({
  name: z.string().min(1),
  kind: RepoMapSymbolKindSchema,
  line: z.number().int().positive(),
}).strict();

export const RepoMapImportSchema = z.object({
  from: z.string().min(1),
  named: z.array(z.string().min(1)).optional(),
}).strict();

export const RepoMapFileSchema = z.object({
  path: z.string().min(1),
  lang: RepoMapLangSchema,
  parser: RepoMapParserSchema,
  lastIndexed: z.string().datetime({ offset: true }),
  size: z.number().int().nonnegative(),
  symbols: z.array(RepoMapSymbolSchema),
  imports: z.array(RepoMapImportSchema),
  exports: z.array(z.string().min(1)),
}).strict();

export const RepoMapSchema = z.object({
  version: z.literal(REPO_MAP_VERSION),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  schemaVersion: z.number().int().positive(),
  files: z.array(RepoMapFileSchema),
}).strict();

export type RepoMapLang = z.infer<typeof RepoMapLangSchema>;
export type RepoMapParser = z.infer<typeof RepoMapParserSchema>;
export type RepoMapSymbolKind = z.infer<typeof RepoMapSymbolKindSchema>;
export type RepoMapSymbol = z.infer<typeof RepoMapSymbolSchema>;
export type RepoMapImport = z.infer<typeof RepoMapImportSchema>;
export type RepoMapFile = z.infer<typeof RepoMapFileSchema>;
export type RepoMap = z.infer<typeof RepoMapSchema>;

export type RepoMapValidationIssue = {
  path: string;
  message: string;
};

export type RepoMapValidationResult =
  | { ok: true; value: RepoMap; issues: [] }
  | { ok: false; issues: RepoMapValidationIssue[] };

export function validateRepoMap(input: unknown): RepoMapValidationResult {
  const parsed = RepoMapSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data, issues: [] };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: jsonPointer(issue.path),
      message: issue.message,
    })),
  };
}

export function assertRepoMap(input: unknown): RepoMap {
  const result = validateRepoMap(input);
  if (result.ok) return result.value;
  const details = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(`Invalid repo-map: ${details}`);
}

function jsonPointer(path: Array<string | number | symbol>): string {
  if (path.length === 0) return "/";
  return `/${path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
