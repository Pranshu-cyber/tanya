# Structural Repo-Map

Tanya writes a generated structural index to `.tanya/index/repo-map.json`.
The map is context, not authority: it helps the model choose what to read, but
edits still require normal file reads and final-state verification.

## Schema

```ts
type RepoMap = {
  version: 1;
  workspace: string;
  generatedAt: string;
  schemaVersion: number;
  files: Array<{
    path: string;
    lang: "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "swift" | "kt" | "unknown";
    parser: "tree-sitter" | "ripgrep" | "path";
    lastIndexed: string;
    size: number;
    symbols: Array<{ name: string; kind: "function" | "class" | "method" | "const" | "type" | "export"; line: number }>;
    imports: Array<{ from: string; named?: string[] }>;
    exports: string[];
  }>;
};
```

`version` describes the top-level map format. `schemaVersion` invalidates the
cache when field semantics change without changing the persisted location.

## Parser Status

M9 ships with a no-bloat ripgrep/path indexer by default. Tree-sitter grammars
remain a future optional parser path because bundling the requested multi-
language grammar set would exceed the install-footprint target for a beta CLI.

| Language | Default parser | Install footprint in Tanya | Notes |
| --- | --- | ---: | --- |
| TypeScript / TSX | `ripgrep` | 0 MB | Extracts top-level functions, classes, consts, types, exports, imports. |
| JavaScript / JSX | `ripgrep` | 0 MB | Same extraction model as TypeScript. |
| Python | `ripgrep` | 0 MB | Extracts `def`, `async def`, classes, imports. |
| Go | `ripgrep` | 0 MB | Extracts `func`, `type`, const/var, imports. |
| Swift | `ripgrep` | 0 MB | Extracts common `func`, class/struct/enum/protocol, let/var declarations. |
| Kotlin | `ripgrep` | 0 MB | Extracts `fun`, class/object/interface, val/var, typealias. |

If the source file cannot be read, the entry falls back to `parser: "path"` and
contains no symbols. Generated files, binaries, `node_modules/`, `dist/`,
`build/`, `.next/`, `.git/`, `.tanya/`, and files over 500 KB are skipped. The
size cap can be changed with `TANYA_REPO_MAP_MAX_FILE_BYTES`.

## Prompt Integration

When `TANYA_LITE_PROMPT=1`, the runner builds or refreshes the cache before
constructing the system prompt. A small `## Repo Map (advisory)` section is
ranked by:

- filenames or paths mentioned in the current task
- symbols or exports mentioned in the current task
- recently edited/touched paths from run context metadata
- common entry points such as `src/index.ts`, `main.go`, and `package.json`

The prompt section is capped by `TANYA_REPO_MAP_PROMPT_BUDGET` (default 1000
tokens). It also participates in the M5.5 system-prompt budget. If the whole
prompt is too large, Tanya drops the repo-map first, then failure-mode packs,
artifact index, domain packs, language packs, and framework packs.

## `inspect_repo_map`

Use `inspect_repo_map` to query the cached map without injecting the whole
structure into the prompt:

```json
{ "symbol": "authorizeUser" }
```

Optional filters:

- `file`: workspace-relative path substring
- `symbol`: symbol/export substring
- `lang`: one of `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `swift`, `kt`, `unknown`

The tool may build the cache on demand. Results are advisory; read the target
file before editing.

## Invalidation

Tanya stores cache metadata at `.tanya/index/repo-map-meta.json`.

- File changes: unchanged entries are reused by `path + size + mtime`; changed
  files are re-indexed.
- Removed files: omitted on the next rebuild.
- New files: indexed on the next rebuild.
- Branch changes: a changed `git rev-parse HEAD` forces a full rebuild.
- Schema changes: a `schemaVersion` mismatch forces a full rebuild.

`tanya debug-prompt` prints cache diagnostics when a repo-map is present:
file count, symbol count, import count, parser breakdown, and estimated token
cost. Use `--section repo-map` to inspect only the prompt excerpt.
