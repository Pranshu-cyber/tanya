# Opencode / Aider Gap Analysis

Research date: 2026-05-16

This scan compares Tanya against two public OSS coding agents:

| Project | License | Pinned tag | Pinned commit | Local study path |
|---|---:|---|---|---|
| `sst/opencode` | MIT | `v1.15.3` | `37f89b742907c43b20d38b68eabe65981a59690a` | `/tmp/tanya-study/opencode` |
| `paul-gauthier/aider` | Apache-2.0 | `v0.86.0` | `a4be6ccd87ebaa59b361f3f028d116ce1761b626` | `/tmp/tanya-study/aider` |

The historical `claude-code-study/` directory is no longer present in this repo after launch-readiness cleanup, so the upstream sources were cloned into `/tmp/tanya-study/*` and are not redistributed here. This document references file paths in those pinned checkouts and summarizes behavior; it does not copy upstream code.

## 1. Architecture Map

| Axis | Aider | opencode | Tanya | Verdict |
|---|---|---|---|---|
| Tool registry | Edit-mode-specific coder classes plus command handlers. Editing is driven by coder formats such as whole-file, diff, udiff, architect/editor. Key files: `aider/coders/base_coder.py`, `aider/coders/editblock_coder.py`, `aider/coders/udiff_coder.py`, `aider/commands.py`. | Central typed tool registry with schemas, permissions, truncation wrapping, and TUI metadata. Key files: `packages/opencode/src/tool/registry.ts`, `packages/opencode/src/tool/tool.ts`, `packages/opencode/src/tool/*.ts`. | Typed native tool registry with permission hooks, verifier-facing output, result truncation, project commands, and sub-agent `task`. Key files: `src/tools/registry.ts`, `src/tools/fsTools.ts`, `src/tools/task.ts`. | Tanya is structurally close to opencode now. Aider's edit formats are the distinctive missing tool surface. |
| Edit format | Search/replace blocks and unified-diff variants, with exact and fuzzy recovery around missing whitespace or shifted context. Key files: `aider/coders/editblock_coder.py`, `aider/coders/search_replace.py`, tests in `tests/basic/test_editblock.py`. | Exact edit/write/apply-patch tools with validation and permission prompts. Key files: `packages/opencode/src/tool/edit.ts`, `packages/opencode/src/tool/apply_patch.ts`, `packages/opencode/src/tool/write.ts`. | Exact `search_replace`, `apply_patch`, and `write_file`. Verifier catches final-state drift, but edit failure recovery is still less model-friendly than Aider's edit blocks. | Ship an additive verifier-aware edit-block tool, not a replacement. |
| Permission / safety | Git-aware safety, file set management, lint/test/commit workflow, but not Tanya's rule engine. Cost/context commands are advisory. | Permission rules are first-class and tool-specific, with ask/allow/deny and TUI/API surfaces. Key files: `packages/opencode/src/permission/index.ts`, `packages/opencode/src/permission/evaluate.ts`, `packages/opencode/src/config/permission.ts`. | M3 gives pure pre-execution decisions, inherited permissions for sub-agents, spend rules, and audit JSONL. | Tanya is stronger on auditability and verifier composition; opencode is stronger on TUI permission UX. |
| Provider config | Uses LiteLLM metadata, model aliases/settings, weak/editor model splits, OpenRouter metadata cache, and token/cost commands. Key files: `aider/models.py`, `aider/resources/model-settings.yml`, `aider/openrouter.py`, `aider/commands.py`. | Provider plugins and model catalog, with cost/limit metadata and account/config UI. Key files: `packages/core/src/models.ts`, `packages/core/src/catalog.ts`, `packages/core/src/plugin/provider/*.ts`, `packages/opencode/src/cli/cmd/providers.ts`. | M2.5 adds provider adapters and conformance tests. M4.5 PR #11 adds routing, fallbacks, context-window guards, and `/route`. Cost tables are currently narrow. | Covered architecturally by M2.5 + M4.5, but Tanya needs a richer provider catalog/cost metadata follow-up later. |
| Context management | Repo-map injects structural symbols for relevant files, chat history summarization exists, and `/tokens` explains context usage. Key files: `aider/repomap.py`, `aider/history.py`, `aider/commands.py`. | Session compaction, truncation-to-file, repo overview, grep/read discipline, and TUI status surfaces. Key files: `packages/opencode/src/session/compaction.ts`, `packages/opencode/src/tool/truncate.ts`, `packages/opencode/src/tool/repo_overview.ts`. | M5/M5.5 already provide reactive compaction, archives, visible truncation, `expand_result`, file-read dedup, `/budget`, and prompt caps. Tanya lacks structural repo-map context. | Ship a structural repo-map milestone; it composes with skill packs rather than replacing them. |
| Memory | Chat history, model/token accounting, repo state, and optional summary flows. | Session database/events, subagent status, truncation files, and TUI session affordances. | Golden tasks, repair runs, archives, audit log, run logs, child run rollup. | Tanya's memory is more verifier-oriented. The missing piece is better structural recall before the model chooses files. |

**Tool registry.** Aider's "registry" is not a single registry in the same sense as Tanya's. It is a set of coder modes and commands that shape how the model emits edits. opencode and Tanya are both closer to conventional typed tool registries; opencode additionally wraps tool output with shared truncation and TUI metadata, while Tanya wraps execution with permissions, audit, verifier views, and sub-agent context.

**Edit format.** Aider's highest-value idea is not "full-file rewrite", but "model emits a constrained edit artifact, host validates it, then returns actionable repair feedback." Tanya's existing exact `search_replace` already avoids blind full-file rewrites, but Aider's fuzzy repair path is still better at cheap-provider imperfections such as minor whitespace drift. This should be additive and verifier-gated.

**Permission / safety.** opencode's permission model is mature at the UX layer. Tanya's M3 engine is more explicit about rule purity, spend rules, audit logging, and sub-agent inheritance. The gap is not the rules engine; it is the human-facing permission display and live affordances.

**Provider config.** Aider leans on LiteLLM and model metadata; opencode has a broad provider/plugin catalog with cost/limit metadata. Tanya's M2.5 adapters and M4.5 routing cover the core mechanics, but a future cost-catalog/provider-profile milestone would reduce manual config and make `/cost` less DeepSeek-centric.

**Context management.** Aider's repo-map is the main context gap. Tanya has strong long-session recovery, but it does not yet maintain a structural symbol/call graph to bias cheap models toward the right files before tool use. That is additive to skill packs: skill packs say "how this stack works"; repo-map says "where this repo's symbols live."

**Memory.** Tanya's verifier and golden-task memory are more outcome-focused than both comparators. The valuable import is not a new memory store, but better links between structural context, run logs, and future golden-task search.

## 2. Diff-Based Edits

**Finding.** Aider's search/replace blocks give the model a constrained edit grammar with server-side validation. It attempts exact matching first, then recovers from common cheap-model drift such as missing indentation, partial context, or near-matches. The main sources are `aider/coders/editblock_coder.py`, `aider/coders/search_replace.py`, and `tests/basic/test_editblock.py`.

**Tanya today.** Tanya has `search_replace`, `apply_patch`, and `write_file` tools in `src/tools/fsTools.ts`. `search_replace` is exact and safer than whole-file rewrites, and the verifier scans final state after execution. It intentionally fails when `old_string` is absent or not unique. That is safe, but cheap providers often lose a space, a blank line, or one adjacent context line. The user then pays another turn to repair the failed edit.

**Safety comparison.** Fuzzy matching is only safer than full-file rewrites if it is bounded:

- Exact match remains the default.
- Fuzzy fallback requires a high similarity threshold and a narrow candidate range.
- Multi-match ambiguity fails closed.
- The result includes a structured diff and verifier evidence.
- The verifier still has final authority.

**Verdict.** Ship as a new additive tool, not a replacement: `edit_block` or `search_replace_block`. It should accept explicit file path, search block, replacement block, match policy (`exact|fuzzy`), and expected match count. Default to exact; allow fuzzy only when the permission mode permits it or the model explicitly asks. Do not replace `search_replace`.

**Estimated effort.** 1 week. Most work is tests: whitespace drift, shifted context, multi-match failure, binary/large-file refusal, audit entries, and verifier parity with existing `search_replace`.

## 3. Repo-Map

**Finding.** Aider's repo-map uses tree-sitter tags and ranking to produce a compact structural map of files and symbols. The relevant sources are `aider/repomap.py` and `tests/basic/test_repomap.py`. Its value is highest before the model knows which files to inspect.

**Tanya today.** Tanya has skill packs, workspace probes, auto-context, artifact/context files, Obsidian materialization, and token-economy controls. These are good at domain and project workflow context. They do not provide a per-repo symbol graph or a ranked symbol index for unknown codebases.

**Additive model.** Repo-map should become a cheap preflight context source:

- Build or refresh `.tanya/index/repo-map.json` from tree-sitter/ripgrep.
- Keep it read-only model context unless the model asks to inspect a file.
- Feed a small symbol summary into lite prompts under the system-prompt budget.
- Let `/budget` account for repo-map tokens as a separate section.
- Let verifier use the map only for explanation, not as proof.

**Verdict.** Ship a structural repo-map milestone. Do not fold it into skill packs. Skill packs remain hand-authored stack rules; repo-map is generated local structure.

**Estimated effort.** 1 to 1.5 weeks. Risk is dependency weight and multi-language parser coverage. The first version can support TypeScript/JavaScript/Python/Go/Swift/Kotlin via best-effort tags and fall back to file/path summaries.

## 4. Provider Config + Cost

**Finding.** Aider gets broad provider/model support by riding LiteLLM metadata and model settings. opencode has first-class provider plugins and model cost/limit catalogs. Tanya has deliberately narrower custom adapter code, which is better for provider quirks but weaker for wide catalog UX.

**Already covered.**

- M2.5 provider adapters, parser fallback, schema flattening, retry policy, and conformance tests.
- M5.5 prompt budgets from adapter context windows and `/budget`.
- M4.5 PR #11 route tables, fallback routes, context-window guards, and `/route`.

**Remaining gaps.**

- Price metadata beyond DeepSeek is thin. `/cost` often says `pricing unknown`.
- Provider setup still asks users to know base URLs and model names.
- No local catalog freshness story: opencode and Aider both have richer model metadata sources.
- No provider "profile" command that explains auth/env requirements and model defaults.

**Verdict.** Do not port a provider framework now. M4.5 is the correct routing foundation. Create a later provider-catalog milestone only if `/cost` and `/route` usage show enough unknown-pricing friction. This is medium value after M4.5 lands, not top-3.

**Estimated effort if shipped.** 1 week for a local price/model catalog, `tanya providers list`, and documented update process.

## 5. TUI

**Finding.** opencode's TUI surface is broad: prompt component, session view, provider/model dialogs, permission dialog, subagent footer, keymap, and plugin slots under `packages/opencode/src/cli/cmd/tui/*` plus plugin-facing types in `packages/plugin/src/tui.ts`. It is not just a pretty renderer; it makes permissions, model switches, subagents, and progress visible.

**Tanya today.** Tanya's line REPL plus `EventSink` is intentionally small. It already emits structured events for streaming tools, permissions, audit, compaction, prompt budget, and sub-agents. That architecture argues against a full UI rewrite.

**Middle ground.** Ship a lightweight status layer, not a full TUI:

- One live status/footer line in interactive mode.
- Current provider/model, route step, context pressure, spend, active child count.
- Permission and escalation prompts remain line-based but can update the footer.
- JSONL and human sinks unchanged.
- Opt-out env for simple terminals.

**Verdict.** Ship a lightweight EventSink renderer milestone. Skip a full Ink/React/Bubble Tea rewrite for now.

**Estimated effort.** 4 to 6 days. Most risk is terminal portability and not corrupting streamed tool output.

## 6. Ranked ROI + Backlog

| Rank | Item | Decision | Effort | Value | Why |
|---:|---|---|---:|---:|---|
| 1 | Structural repo-map index | Ship as M9 | 1 to 1.5 wk | High | Best cheap-provider leverage: fewer blind file reads and better first-turn targeting. |
| 2 | Verifier-aware edit-block tool | Ship as M10 | ~1 wk | High | Reduces failed edit loops from cheap models while preserving exact-match and verifier authority. |
| 3 | Lightweight live status / TUI layer | Ship as M11 | 4 to 6 d | Medium-high | Makes routing, spend, permissions, compaction, and subagents visible without a full TUI rewrite. |
| 4 | Provider catalog + richer cost metadata | Defer | ~1 wk | Medium | M2.5 + M4.5 cover mechanics; unknown pricing is annoying but not blocking. |
| 5 | Background opencode-style task resume/poll UX | Defer | ~1 wk | Medium | Tanya's M4 task tool is intentionally verifier-first. Background task polling can wait for real user demand. |
| 6 | Full TUI rewrite | Skip | 3+ wk | Low-medium | High surface area and product risk. EventSink gives a cheaper path. |

## New Milestones Created

- `M9-structural-repo-map.md` - generated symbol/context index for cheap-provider first-turn targeting.
- `M10-verifier-aware-edit-blocks.md` - additive Aider-inspired edit-block tool with bounded fuzzy recovery.
- `M11-lightweight-live-status.md` - EventSink-based live status/footer for routing, spend, permissions, compaction, and subagents.

Each derived milestone explicitly keeps verifier authority: generated repo-map is context only, edit-blocks must be verified post-execution, and the status UI only renders events.
