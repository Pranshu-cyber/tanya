# Tanya

**A Claude-Code-style coding agent that actually works with DeepSeek.**

[![CI](https://github.com/matheusjkweber/tanya/actions/workflows/ci.yml/badge.svg)](https://github.com/matheusjkweber/tanya/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40matheuskrumenauer%2Ftanya.svg)](https://www.npmjs.com/package/@matheuskrumenauer/tanya)
[![license](https://img.shields.io/github/license/matheusjkweber/tanya.svg)](./LICENSE)
[![DeepSeek-V4-Pro pass rate](https://img.shields.io/badge/deepseek--v4--pro%20pass%20rate-96.7%25-brightgreen)](./docs/benchmarks/eco-30-latest.json)

Existing tools (Cursor, Claude Code, and Chinese-native CLIs) produce malformed tool calls, dropped schemas, and silent failures on DeepSeek. Tanya is built specifically to handle DeepSeek's quirks - permissive tool-call parsing, retry-with-correction, schema flattening, reasoning-model support - without compromising the deterministic verifier that catches hallucinations cheap models would otherwise sneak past you.

Works with: DeepSeek (primary), Qwen, Grok, Groq, Ollama, and any OpenAI-compatible endpoint.

## Why this exists

I have a PhD in AI and I use DeepSeek every day. Every coding-agent CLI I tried either broke tool calls, silently dropped schema details, or made verification feel like an afterthought. I built Tanya so I could actually work with DeepSeek and still have a verifier watching what the model changed.

## Install

```bash
npm i -g @matheuskrumenauer/tanya
export DEEPSEEK_API_KEY=sk-...
tanya
```

Local development:

```bash
npm install
npm run link:local
tanya
```

From GitHub, once published:

```bash
npm install -g github:matheusjkweber/tanya
```

From npm, once published:

```bash
npm install -g @matheuskrumenauer/tanya
```

The unscoped `tanya` name is taken on npm, so the package publishes under the `@matheuskrumenauer` scope.

Docker/container installs that cannot infer platform metadata may need npm
platform flags for Tanya's image tooling dependency:

```bash
npm install -g --os=linux --cpu=arm64 --libc=glibc @matheuskrumenauer/tanya
```

Use `--cpu=amd64` on x64 containers. Tracking issue:
https://github.com/matheusjkweber/tanya/issues/9.

## Quick start

```bash
tanya ask "explain this repo"
tanya run --verify "npm test" "fix the failing test"
tanya providers test --provider deepseek
```

## What makes it work with DeepSeek

- Permissive tool-call parsing recovers missing IDs, stringified arguments, missing wrappers, and other almost-OpenAI-compatible responses before a run falls over.
- Retry-with-correction turns malformed tool calls into explicit repair prompts instead of silent no-ops.
- Schema flattening keeps narrow providers from rejecting tool definitions with `$ref` or `oneOf` shapes.
- Reasoning-model support separates `deepseek-reasoner` thinking from final answers, archives it, and tracks reasoning tokens in cost reports.
- The verifier checks changed files, expected artifacts, validation output, and blockers after the model acts, so cheap-model drift has to pass deterministic review.
- Defaults to `deepseek-v4-pro` and tracks DeepSeek's API roadmap; legacy aliases still work but warn before their scheduled deprecation.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, tool and
skill-pack conventions, tests, and PR expectations.

Beginner-friendly tasks are tagged
[`good first issue`](https://github.com/matheusjkweber/tanya/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
For roadmap context, read [docs/claude-code-gap-analysis.md](./docs/claude-code-gap-analysis.md).

## Configuration

Create `.env` from `.env.example`:

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
TANYA_MODEL=deepseek-v4-pro
```

Use the reasoner profile for harder coding/planning tasks:

```bash
TANYA_PROFILE=reasoner
```

Or pass it per command:

```bash
tanya run --profile reasoner "Plan this refactor"
tanya chat --profile reasoner
```

Custom OpenAI-compatible provider:

```bash
TANYA_PROVIDER=custom
TANYA_API_KEY=...
TANYA_BASE_URL=https://provider.example.com
TANYA_MODEL=provider-model-name
```

Optional Obsidian logging:

```bash
TANYA_OBSIDIAN_VAULT=/path/to/Obsidian/Vault
```

When set, Tanya appends a summary of completed tasks to the vault daily note. `tanya run` also searches the vault for task-relevant notes and materializes safe excerpts into `.tanya/context/obsidian` so they can be read as normal workspace context.

DeepSeek documents its API as OpenAI-compatible for chat completions:
https://api-docs.deepseek.com/

- Tracks the DeepSeek API roadmap: warns when legacy model names approach
  deprecation, with a documented migration path in `docs/providers.md`.

## Permissions

Tanya has an opt-in pre-execution permission layer for native tools and
project-local slash commands. The default mode in v0.x is `bypass` so existing
automation keeps full access until a workspace opts in.

Modes:

- `bypass` skips gating and logs decisions for audit.
- `default` applies configured rules; unmatched calls are allowed.
- `ask` applies configured rules; unmatched calls prompt the host.
- `plan` denies all tool execution so the model must respond with text only.

Rules live in `~/.tanya/permissions.json` for user scope and
`.tanya/permissions.json` for project scope. Project rules merge over user
rules. A minimal deny rule:

```json
{
  "version": 1,
  "mode": "default",
  "alwaysDeny": ["run_shell:.*rm -rf.*"]
}
```

Generate a starter config from recent runs:

```bash
tanya permissions migrate --cwd . > .tanya/permissions.suggested.json
```

Spend rules can gate projected token or USD budgets before a tool runs. For
example, `/cost --enforce --max-usd 0.50` writes a session-scoped rule.

See [docs/permissions.md](./docs/permissions.md) for the full schema,
precedence, audit log, and worked examples.

## Commands

```bash
tanya                         # live chat
tanya chat --profile reasoner # live chat with the reasoner profile
tanya ask "Explain this"      # one-shot answer
tanya run "Fix the test"      # agent task with tools
tanya run --profile reasoner "Fix this bug" # run with TANYA_PROFILE=reasoner
tanya run --verify "npm run typecheck" --verify "npm run build" "Fix the test"
tanya run --no-auto-brief "Fix the test" # skip deterministic project/artifact brief
tanya run --no-obsidian-context "Fix the test" # skip Obsidian context retrieval
tanya run --retries 2 "Fix this task" # retry blocked runs with context carry-forward
tanya run --plan --retries 2 "Implement the feature" # reasoner plan plus retries
tanya run --no-post-check "Long native build task" # skip independent typecheck/test re-checks
tanya run --json "Fix lint"   # JSONL events for machine consumers
tanya run --context-file ./context.json --prompt-file ./prompt.md
tanya benchmark profiles      # list runnable regression benchmark profiles
tanya benchmark run --all     # execute the benchmark suite locally
tanya benchmark validate      # validate recent benchmark signatures
tanya runs                    # show recent run logs with cost/status
tanya video presets           # list available video presets
tanya video one-terminal-simctl # generate the exact transparent terminal asset
tanya providers test          # provider smoke test
tanya mcp serve               # expose Tanya verifier/run/skills over MCP stdio
tanya doctor                  # local environment check
```

## Slash commands

Interactive chat accepts built-in slash commands without sending them to the
model:

```text
/clear            # reset only the active conversation history
/skills           # list matched skill packs and token cost
/verify           # print the deterministic verifier report for the cwd
/cost             # show persisted token usage and estimated cost
/memory --limit 5 # list recent golden-task memory
/mcp              # list connected MCP servers and tools
```

Project-local commands live in `.tanya/commands/*.{js,ts,sh}` and appear in
`/help` with a `project:` prefix, for example `/project:say-hi`. Shell commands
run directly; JavaScript and TypeScript commands export a default
`CommandDefinition`.

Project-local commands are arbitrary code execution and are gated by the same
permission engine as native tools.

## Sub-agent tool

The `task` tool delegates a bounded child run while keeping the parent in
control:

```json
{
  "prompt": "Map the auth module and report blockers.",
  "workspace": "src/auth",
  "max_turns": 12,
  "token_budget": { "max_tokens": 12000 },
  "treat_failure_as": "warning"
}
```

Children inherit the parent's skill packs, permission rules, workspace, and
budget. They may narrow those constraints but cannot loosen them. Depth is
capped at 2 by default (`TANYA_SUBTASK_MAX_DEPTH`), and active children share a
default parallel cap of 3 (`TANYA_SUBTASK_MAX_PARALLEL`).

Every child runs its own verifier. Failed child verdicts become parent blockers
by default; `treat_failure_as` can demote a specific child to `warning` or
`ignore` when the caller wants advisory work only. Child events stream into the
parent log with a `subRunId`, and parent cancellation propagates into active
children.

See [docs/sub-agents.md](./docs/sub-agents.md) for permission inheritance,
budget-ledger semantics, cancellation, verifier composition, and memory rollup.

## MCP integration

Tanya can consume external Model Context Protocol servers and expose Tanya's own
verifier and memory primitives to MCP-speaking clients.

Client configuration is allowlist-only. User-global servers are read from
`~/.tanya/mcp.json` with a fallback read of `~/.tanya/mcp.json`; project servers
live in `.tanya/mcp.json` and override same-named user servers. Connected tools
are registered as normal Tanya tools named `mcp:<server>:<tool>`, so permission
rules, audit logging, truncation, and verifier visibility apply exactly as they
do for native tools.

```json
{
  "version": 1,
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  ]
}
```

Use `/mcp` in the REPL to inspect connected servers. Use `tanya mcp serve` to
start Tanya's MCP server over stdio; it exposes `tanya.verify`,
`tanya.golden_task_search`, `tanya.run`, and `tanya.skills_list`.

MCP servers are untrusted code. Tanya refuses undeclared servers, gates every
MCP tool call through the permission engine, captures stdio server stderr under
`.tanya/mcp/logs/`, restarts crashed servers up to three times, and rejects
schema-invalid tool responses before they reach model history.

See [docs/mcp.md](./docs/mcp.md) for the full schema, transports, server tools,
and security model.

## Multi-model routing

Tanya can route each agent step to a different provider/model. Planning and
simple tool-call turns can use cheap chat models, while synthesis,
verification, and reasoning turns can use stronger models only when needed.

Default route profile:

| Step | Route | Fallback |
| --- | --- | --- |
| `planning` | `deepseek/deepseek-chat` | `qwen/qwen3-coder-plus` |
| `tool_call` | `deepseek/deepseek-chat` | `groq/llama-3.3-70b-versatile` |
| `synthesis` | `deepseek/deepseek-reasoner` | `openai/gpt-4.1-mini` |
| `verification` | `deepseek/deepseek-reasoner` | `openai/gpt-4.1-mini` |
| `reasoning` | `deepseek/deepseek-reasoner` | `qwen/qwen3-coder-plus` |

Project routes live in `.tanya/routes.json`; user-global routes live in
`~/.tanya/routes.json` with a legacy read fallback from `~/.tanya/routes.json`.
Use `/route` in the REPL to inspect the effective table, `/route show
<stepType>` to inspect one step, `/route set <stepType> <provider>/<model>` for
a session-only patch, and `/route reset` to clear session patches.

Escalations are visible: if a cheap route exhausts the malformed tool-call
repair budget, Tanya emits `escalation_event` and uses the route fallback once,
up to `TANYA_ESCALATION_CAP` per session.

Per-turn reasoning budgets fall back to `TANYA_REASONING_CAP_SHORT` (default
`2000`) and `TANYA_REASONING_CAP_LONG` (default `8000`) when a route pins no
`reasoningCap` of its own.

See [docs/routing.md](./docs/routing.md) for schema, examples, context-window
guards, per-tool model overrides, sub-agent model pins, and reasoning budgets.

## Live status

Interactive `tanya chat` sessions show a compact status footer derived from the
same events already sent to the human sink:

```text
[deepseek:deepseek-chat | tool_call | $0.04 | 2 tools | 1 child]
[awaiting permission: run_shell]
[escalated deepseek:deepseek-chat->openai:gpt-4.1-mini: parse_failure]
```

The footer is TTY-only. Piped output and JSONL output stay byte-stable and
receive no ANSI cursor control bytes. Disable it with
`TANYA_LIVE_STATUS=0` or the legacy `TANYA_LIVE_STATUS=0` alias.

See [docs/live-status.md](./docs/live-status.md) for the surfaced fields,
streaming strategy, and TTY fallback behavior.

## Reasoning models

Reasoning routes such as `deepseek-reasoner`, `qwen3-thinking-*`, and
`grok-3-reasoning` are handled as a separate stream. Tanya archives reasoning to
`.tanya/runs/<runId>/reasoning.jsonl`, emits `reasoning_chunk` events, and keeps
assistant history reasoning-free so replay and verifier inputs stay stable.

Reasoning tokens appear separately in `/cost` and `/budget`. Route rules can set
`reasoningCap.maxTokens`; built-in defaults are 2k for planning-like turns and
8k for synthesis/verification/reasoning turns. If the cap is exceeded, Tanya
emits `reasoning_truncated` and asks the model to finish.

Use `/memory --reasoning <runId>` to inspect archived reasoning. Use
`TANYA_HIDE_REASONING=1` to hide reasoning from the human UI while preserving
JSONL events. Verifier reasoning annotations are off by default; enable
them with `--verbose-verifier` or `TANYA_VERIFIER_INCLUDE_REASONING=1`.

See [docs/reasoning.md](./docs/reasoning.md) for provider notes, billing math,
budget defaults, and UX modes.

`--verify` adds required verification commands to the run context. Tanya must run and report each exact command before finishing the coding task.

`tanya benchmark run --all` currently exercises 23 executable low-to-medium regression fixtures: targeted edits, new files, dependency/lockfile updates, framework-style migrations, failing-test repair, frontend smoke checks, artifact/context reuse, streaming long-tool execution, compaction-boundary recovery, run-history logging, dirty worktrees, and report repair.

By default, `tanya run` also performs an independent post-check after the agent finishes. If the workspace has a `typecheck` script, Tanya reruns that exact script with the local package manager (`npm`, `pnpm`, `yarn`, or `bun`). If not, it falls back to `npx tsc --noEmit --pretty false` when a `tsconfig` is present. If the workspace has a `test` script, Tanya reruns that as well unless the run already reported a passing test verification.

By default, `tanya run` builds a generic task brief from local instructions, contracts, artifact indexes, project shape, and package scripts. Coding-shaped tasks get verification/report expectations automatically. If reusable artifact candidates are found, Tanya must read a relevant artifact or create a reusable one before changing code.

Per-project persistent instructions can be stored in `.tanya/INSTRUCTIONS.md`. Tanya injects this file into the system prompt for runs started inside that workspace. Create a starter file with:

```bash
tanya init
tanya init --cwd /path/to/project
```

## Tool Visibility

Human mode shows tools as they run:

```text
> search
  input: {"query":"describe("}
  ok: Found 3 match lines.
```

JSON mode emits machine-readable events:

```json
{"type":"tool_call","id":"call_1","tool":"search","input":{"query":"describe("}}
{"type":"tool_result","id":"call_1","tool":"search","ok":true,"summary":"Found 3 match lines."}
```

## Streaming tool execution

Long-running `run_shell` calls stream throttled stdout/stderr chunks to the active event sink while the model only receives the final `tool_result`.

```text
tanya run "Run npm test"  # emits tool_progress while the command runs; Ctrl-C cancels the active shell and returns partial_output
```

## Long sessions

Tanya handles context pressure as a cascade instead of truncating abruptly:

1. Microcompact folds empty/no-op tool-call pairs in place.
2. Snip removes low-signal history such as duplicate file reads and empty read-only tool results.
3. Auto-compact reacts to provider `413` / context-window errors by summarizing older turns into a `[compaction summary: ...]` system message and retrying once normally, then once more aggressively.
4. Archive writes compacted messages to `.tanya/runs/<runId>/archive.jsonl` before they leave live history, so verifier scans and future memory tools can still inspect them.

Runs are capped at three total auto-compactions. If the provider still rejects the context, Tanya raises `CompactionExhaustedError` and asks the user to narrow the task, clear the session, or split the work.

See [docs/long-sessions.md](./docs/long-sessions.md) for details.

## Token economy

Tanya trims model-visible tokens while keeping state reversible and auditable.

- Lite prompts can be enabled with `TANYA_LITE_PROMPT=1` for cheap-provider exploration turns. The legacy `TANYA_LITE_PROMPT` alias is still accepted.
- System prompts are automatically capped to the active provider context window. Tune the default 25% cap with `TANYA_PROMPT_BUDGET_RATIO`.
- Large shell/tool outputs are shortened for the model with a visible `<truncated ...>` marker. Use `expand_result` with the marker's `tool_call_id` to fetch the full output or a byte range.
- Repeated unchanged `read_file` calls return a reference marker instead of resending the same content. Pass `force: true` when the agent genuinely needs the full file again.
- `/budget` reports token usage, cost estimates, expensive turns, and one deterministic optimization suggestion. `/budget --enforce --max-usd <amount>` persists a session spend rule through the permission engine.

See [docs/token-economy.md](./docs/token-economy.md) for the full model, cache locations, and tool-definition knobs.

## Benchmarks

Tanya includes an eval harness for verifier-stress suites, SWE-bench-Lite
adapters, integration-provided suites, and the `eco-30` token-economy bench.

```bash
tanya eval --suite tanya-native --dry-run
tanya eval --suite tanya-native --out .tanya/eval/results/tanya-native.json
tanya eval report .tanya/eval/results/tanya-native.json
tanya eval compare docs/benchmarks/tanya-native-latest.json .tanya/eval/results/tanya-native.json --format markdown
```

Public snapshots live in [docs/benchmarks](./docs/benchmarks/). The eval result
schema and determinism contract are documented in
[docs/eval-format.md](./docs/eval-format.md).

`eco-30` is the token-economy suite. Its reports include total cost, cost per
pass, tokens per pass, reasoning share, and cost-regression checks. The
`verifier-self-test` suite is the verifier moat regression net: known-correct
and known-incorrect artifacts where the expected outcome is the verifier's
classification, not the model's output.

## Edit blocks

`edit_block` applies bounded search/replace edits without falling back to a
full-file rewrite:

```json
{
  "path": "src/example.ts",
  "search": "const state = \"pending\";",
  "replace": "const state = \"complete\";",
  "expectedCount": 1,
  "matchPolicy": "exact"
}
```

Exact mode is the default and fails closed when the block is missing, ambiguous,
or appears a different number of times than expected. Fuzzy mode is opt-in via
`matchPolicy: "fuzzy"` and requires an explicit M3 permission allow rule. Fuzzy
recovery only accepts whitespace-normalized or nearby-context candidates with
confidence >= 0.95; otherwise Tanya returns a structured error and asks the
model to re-read the file.

Successful edit blocks emit before/after hashes and a unified diff. Fuzzy
successes also add candidate metadata to the audit log. The final verifier still
reads the changed workspace independently; edit-block success is not a verifier
pass.

See [docs/edit-blocks.md](./docs/edit-blocks.md) for the full tool reference,
permission model, confidence threshold, and failure modes.

## Structural repo-map

Lite prompts can include a generated structural map from
`.tanya/index/repo-map.json`. The map lists workspace-relative files, language,
parser provenance, top-level symbols, imports, and exports so cheap providers
can target likely files before spending turns on blind reads.

Tanya indexes TypeScript/JavaScript, Python, Go, Swift, and Kotlin with a
lightweight ripgrep-style parser and falls back to path-only entries when file
content cannot be read. Generated, binary, ignored, and oversized files are
skipped. The repo-map is advisory context only: agents must still read files
before editing, and the verifier remains the final authority.

Use `TANYA_LITE_PROMPT=1` to inject a ranked repo-map excerpt. Tune the default
1000-token section budget with `TANYA_REPO_MAP_PROMPT_BUDGET`; the legacy
`TANYA_*` alias is also accepted. If the prompt budget is tight, the repo-map
drops before skill packs because it is generated and recoverable.

Use `inspect_repo_map` when the model needs more structural detail by file,
symbol, or language without burning prompt tokens on the whole map.

See [docs/repo-map.md](./docs/repo-map.md) for schema, parser status, ranking,
budget interaction, and cache invalidation.

Context files are generic JSON envelopes for caller-supplied task metadata, artifacts, instructions, and verification commands.

## Current Tools

- `list_files`
- `read_file`
- `search`
- `inspect_repo_map`
- `inspect_project_context`
- `find_reusable_artifacts`
- `build_task_brief`
- `search_obsidian_notes`
- `write_file`
- `apply_patch`
- `search_replace`
- `edit_block`
- `copy_file`
- `copy_dir`
- `apply_artifact`
- `create_ios_splash`
- `create_android_splash`
- `generate_app_icons`
- `create_android_foundation`
- `commit_platform_changes`
- `resize_image`
- `render_svg_to_png`
- `create_apple_app_icon_set`
- `create_android_launcher_icon_set`
- `validate_apple_app_icon_set`
- `validate_android_launcher_icon_set`
- `validate_api_contract_routes`
- `validate_android_project_config`
- `validate_apple_project_files`
- `validate_fastlane_config`
- `validate_prisma_schema`
- `scan_secrets`
- `generate_video_asset`
- `run_command`
- `run_shell`

All file paths are constrained to the selected workspace.

## Video Assets

Tanya can generate short compositable video assets locally with headless Chrome and ffmpeg:

```bash
tanya video one-terminal-simctl --output-dir assets/video --basename simctl-fail
```

The `one-terminal-simctl` preset recreates the native 980x1012, 30fps, 3s transparent Terminal asset with failing `xcrun simctl` commands. `terminal-simctl` is kept as an alias.

To make variants, override terminal copy with repeated `--line` flags:

```bash
tanya video one-terminal-simctl \
  --output-dir assets/video \
  --basename install-failure \
  --line '$ xcrun simctl install booted DemoApp.app' \
  --line 'error: unable to find a booted simulator' \
  --line '$ xcrun simctl io booted screenshot out.png' \
  --line 'xcrun: error: selected device is not available'
```

Outputs default to WebM VP9 alpha, ProRes 4444 MOV alpha, and a transparent poster PNG. Chrome/Chromium and ffmpeg must be installed; set `TANYA_CHROME_PATH` or `TANYA_FFMPEG_PATH` if Tanya cannot find them.
