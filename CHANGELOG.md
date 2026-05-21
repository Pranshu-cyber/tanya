# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.17.0] - 2026-05-21

### Added

- Full-screen Claude-Code-style TUI for the interactive `tanya` chat REPL
  (TTY only, opt out with `--no-tui` or `TANYA_TUI=off` /
  `TANIA_TUI=off`).
- TUI footer status bar shows model, session elapsed time, cumulative cost,
  session token count, and slash-command hint text.
- Permission prompts now render as an Ink modal during chat sessions.
- REPL shows a thinking spinner while waiting for the first token in TTY mode.
- REPL prompts and assistant responses now include local clock timestamps, for
  example `[14:32:09] You:` and `[14:32:21] Tanya · 5.1s:`.
- Each REPL assistant response is prefixed with its generation time, for example
  `Tanya · 3.2s:`.
- `/exit` and `/quit` print a REPL session summary with walltime, generating
  time, and turn count.
- REPL thinking spinner shows elapsed seconds from the first frame, for example
  `Tanya: ⠋ thinking… (0s)`.
- Ink TUI now shows real-time reasoning and tool activity during a turn, then
  folds it into a one-line completion summary.
- Ink TUI now renders assistant Markdown with styled inline text, lists,
  quotes, headings, and fenced code blocks.
- Ink TUI now shows a launch warmup banner plus a first-turn cold-start hint in
  the footer while DeepSeek V4-Pro and project commands initialize.
- One-time-per-process stderr warning when DeepSeek legacy model names
  (`deepseek-chat`, `deepseek-reasoner`) are used. They're V4-Flash
  compatibility aliases scheduled for deprecation by DeepSeek on 2026-07-24.
  Suppressible via `TANYA_SUPPRESS_DEPRECATION=1` (envCompat fallback
  `TANIA_SUPPRESS_DEPRECATION=1`). Migration story in
  `docs/providers.md#deepseek-v4-deprecation`. Proper thinking-mode config
  redesign tracked as M13.

### Changed

- Coding tasks in the backend foundation phase now receive a 300-turn budget
  while setup/auth, feature, and testing phase budgets stay unchanged.
- New runtime dependencies: `ink` and `react`; slash-command output in the
  interactive TUI renders as system-message bubbles in chat history.
- DeepSeek default model is now `deepseek-v4-pro` (was `deepseek-chat`).
  Legacy names still work; `deepseek-chat` continues to print the V4
  deprecation warning until 2026-07-24.
- `/cost` and `/budget` now label estimates as `[cache-miss estimate]` for
  DeepSeek and other providers whose cache-hit pricing isn't yet modeled. Real
  bills typically run 30-80% lower due to cache hits on stable prompts. Proper
  cache-hit accounting ships with M13 (DeepSeek V4 thinking-mode redesign).
- Scrubbed committed absolute home-directory paths from code/docs.
- Reworded CosmoHQ-internal references in skill packs and tests where the wording was internal-coded rather than intentional public context; preserved CosmoHQ-as-consumer references in integration docs.
- Sanitized email references in test fixtures (`user@example.com`); preserved intentional public contact emails in `SECURITY.md` / `CODE_OF_CONDUCT.md` / `package.json`.

### Removed

- 8 internal Codex prompt files from the repo root (`CODEX_PROMPT_*.md`) that were committed during pre-launch development.
- 11 internal per-milestone development status snapshots (`docs/M*-status.md`, `docs/PROGRESS.md`) — superseded by CHANGELOG entries and the milestone-tracking in the project's Obsidian vault.
- One-time `docs/expertise-pack-refresh-plan.md` (work executed; doc is no longer relevant).

### Fixed

- Force-terminated coding runs no longer surface the final failed probe command
  as a blocker when final-state authoritative Verify checks pass.
- DeepSeek round-trip reasoning requests now coerce assistant history entries
  with `content: null`, `reasoning_content`, and no `tool_calls` to
  `content: ""` only in the DeepSeek wire body. This avoids DeepSeek's
  `content or tool_calls must be set` HTTP 400 without changing stored history
  or non-DeepSeek adapters.
- Ink TUI input box now shows a live spinner with elapsed-seconds counter while
  a turn is pending, instead of a static `waiting…` string.
- Ink TUI assistant messages now render incrementally as tokens stream in,
  using coalesced state updates instead of one reducer dispatch per token.
- Ink TUI latency is reduced by coalescing per-token dispatches and memoizing
  message bubbles to avoid full history re-render work on every streamed token.
- DeepSeek thinking-mode conversations now preserve assistant
  `reasoning_content` in Tanya's in-memory history and round-trip it back only
  to DeepSeek on subsequent OpenAI-compatible requests. This fixes DeepSeek
  HTTP 400 failures after the first streamed assistant turn without changing
  OpenAI, Qwen, Grok, Groq, Together, Ollama, or Anthropic wire bodies.
- REPL no longer prints the assistant response twice when streamed output and
  the final event contain the same message.
- REPL thinking spinner now shows elapsed seconds, for example
  `Tanya: ⠋ thinking… (8s)`, so slow responses do not look stalled.
- Ink TUI finalized history now renders through Ink `<Static>`, so the visible
  conversation does not blink on every keystroke or streamed token.
- Ink TUI residual blink is reduced by sharing a single one-second ticker,
  removing Input/Footer border redraws, and stabilizing the input clock string
  to the shared tick.

## [0.16.0-beta.0] - 2026-05-16

### Added

- Added the M8 eval harness that logically slotted as v0.12 in the planned
  sequence; v0.12 was skipped during the marathon, so the release moves forward
  as v0.16.0-beta.0.
- Added versioned eval suite/result schemas, `tanya eval` runner support,
  dry-run estimates, deterministic reporting, markdown comparison output, and
  nightly eval CI scaffolding.
- Added Tanya-native, SWE-bench-Lite, CosmoHQ, `eco-30`, and
  `verifier-self-test` suites. `eco-30` makes cost a first-class metric with
  cost-per-pass, tokens-per-pass, reasoning-share, and >=20% cost-regression
  gates.
- Added public benchmark snapshots and docs covering eval formats, runner
  isolation, determinism, scoreboard updates, and full SWE-bench cost guidance.
- Eco-30 smoke on `deepseek/deepseek-chat` for the first three tasks completed
  at 2/3 passed, `$0.240746` total, and `$0.120373` per pass; the full
  all-provider baseline remains an operational follow-up.

## [0.15.0-beta.0] - 2026-05-16

### Added

- Added an interactive-only live status footer for `tanya chat`, derived from
  existing EventSink events. It surfaces provider/model routing, route step,
  spend, active tools, child agents, permission prompts, escalations,
  compaction, and prompt-budget warnings without changing event semantics.
- Added TTY-guarded rendering with `TANYA_LIVE_STATUS=0` /
  `TANIA_LIVE_STATUS=0` opt-out, plus byte-invariance coverage for non-TTY,
  JSONL, and Cosmo bridge output.
- Added [docs/live-status.md](./docs/live-status.md) with terminal behavior,
  streaming compatibility, and full-TUI tradeoffs.

## [0.14.0-beta.0] - 2026-05-16

### Added

- Added the verifier-aware `edit_block` tool with exact block replacement,
  expected-count enforcement, structured mismatch reasons, permission-gated
  fuzzy recovery for whitespace and nearby-context drift, audit-visible
  candidate metadata, repair hints, and a golden near-match fixture.
- Recovery-rate sample: 16/20 near-match cases recovered cleanly and 4/20
  failed closed by design; the M10 golden comparison preserves verifier verdicts
  while the fuzzy-enabled path uses fewer turns than exact retry.

## [0.13.0-beta.0] - 2026-05-16

### Added

- Added structural repo-map generation under `.tania/index/repo-map.json`,
  covering TypeScript/JavaScript, Python, Go, Swift, and Kotlin with parser
  provenance, symbol/import/export extraction, incremental cache invalidation,
  branch/schema rebuilds, and debug-prompt diagnostics.
- Added lite-prompt repo-map injection with deterministic ranking, prompt-budget
  dropping, `/budget` repo-map token accounting, and the `inspect_repo_map` tool
  for on-demand structural lookup.

## [0.11.0-beta.0] - 2026-05-16

### Added

- Added first-class reasoning-model handling for DeepSeek-R, Qwen3-Thinking,
  and Grok reasoning-style outputs: reasoning chunks are split from assistant
  history, archived to `.tania/runs/<runId>/reasoning.jsonl`, shown as separate
  events, and protected by reasoning-token caps.
- Added reasoning token accounting in `/cost` and `/budget`, `/memory
  --reasoning`, opt-in advisory verifier annotations, and REPL/JSONL/Cosmo
  reasoning UX controls including `TANYA_HIDE_REASONING`.

## [0.10.0-beta.0] - 2026-05-16

### Added

- Added bidirectional MCP support: Tanya can consume configured external MCP
  servers as `mcp:<server>:<tool>` tools, and `tanya mcp serve` exposes
  `tanya.verify`, `tanya.golden_task_search`, `tanya.run`, and
  `tanya.skills_list` over MCP stdio.
- Added MCP config loading from `~/.tanya/mcp.json` and project `.tania/mcp.json`,
  `/mcp` server status, MCP permission/audit integration, transport restart and
  timeout handling, recursion guard, schema validation, and MCP docs/examples.

## [0.9.0-beta.0] - 2026-05-16

### Added

- Added opt-in multi-model routing with route-table schema, provider/model
  defaults for cheap planning/tool-call turns and capable synthesis/verifier
  turns, context-window guards, observable `model_routed` events, provider
  fallback, per-tool preferred models, sub-agent model pins, capped
  `escalation_event` fallback, and the `/route` REPL command.

## [0.8.0-beta.0] - 2026-05-16

### Added

- Added the `task` sub-agent tool with inherited context, tighten-only
  permission rules, scoped workspaces, budget-ledger accounting, recursion and
  cycle guards, cancellation propagation, verifier composition, and parent-only
  golden-task memory rollups.

## [0.7.0-beta.0] - 2026-05-16

### Added

- Added token-economy controls for cheap-provider sessions: opt-in lite system
  prompts, automatic prompt-budget enforcement from provider context windows,
  reversible large tool-result truncation through `expand_result`, per-run
  result caches, file-read deduplication, and the `/budget` reporter with
  spend-rule enforcement.
- Added the token-economy reference docs and benchmark evidence: a synthetic
  10-task fixture reduced input tokens by 77.5% with 0% verifier-verdict
  regression, while the golden suite stayed at 27/27 with zero drift.

## [0.6.0-beta.0] - 2026-05-16

### Added

- Added opt-in permission modes (`bypass`, `default`, `ask`, `plan`) with
  user/project rules, REPL approval prompts, learned allow/deny rules, audit
  logging, `/audit`, `/mode`, and project-local command gating.
- Added spend rules for projected token/USD budgets plus `/cost --enforce` and
  the `/budget --enforce` M5.5 stub.

## [0.5.0-beta.0] - 2026-05-16

### Added

- Added reactive context compaction for long sessions: typed context-window
  errors, microcompact, low-signal snipping, forked auto-compaction retry,
  archive-backed auditability, compaction events, and a compaction-boundary
  golden task.

## [0.4.0-beta.0] - 2026-05-16

### Added

- Added provider robustness adapters for DeepSeek, Qwen, Grok, Groq, Together,
  Ollama, and OpenAI-compatible APIs, with permissive tool-call parsing, schema
  flattening, retry/throttle events, and mock conformance tests.

## [0.3.0-beta.0] - 2026-05-15

### Added

- Added interactive slash commands for clearing chat history, inspecting skill
  packs, verifier output, run costs, golden-task memory, help, and project-local
  command extensions.

## [0.2.0-beta.0] - 2026-05-15

### Added

- Added OSS launch scaffolding: contributor, conduct, security, issue template,
  PR template, CI, release workflow, and example documentation.
- Added curated `good first issue` onramp tasks for slash commands and skill
  packs.

### Changed

- Sanitized prior-art documentation to rely on public sources only.
- Polished npm package metadata and publish allowlist for the beta package.

## [0.1.0] - 2026-05-15

### Added

- Added streaming `run_shell` progress events, CLI/Cosmo/JSONL sink support,
  and active-tool cancellation with partial output returned in the final tool
  result.
