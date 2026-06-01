# Tanya Architecture

> A map of how Tanya is organized today (v0.17.x). Written as the baseline for
> the "make Tanya's capabilities match Claude Code" roadmap. Everything here is
> derived from Tanya's own source — no third-party code.

Tanya is a TypeScript coding-agent CLI. ~31k LOC across 21 modules under `src/`.
Single binary entry point (`tanya` → `dist/cli.js`). ESM, Node, streaming-first.

---

## 1. The 10,000-foot view

```
        ┌──────────────────────────────────────────────────────────────┐
        │                         src/cli.ts                            │
        │   parse argv → pick run mode → build config + routing         │
        └───────────────┬──────────────────────────────┬───────────────┘
                        │                              │
              interactive (chat)                one-shot (run/ask/review)
                        │                              │
        ┌───────────────▼──────────┐        ┌──────────▼───────────────┐
        │   src/ui/ink (React)     │        │  src/ui/humanSink /       │
        │   App + reducer + sink   │        │  events/jsonl  (text/JSON)│
        └───────────────┬──────────┘        └──────────┬───────────────┘
                        │   EventSink (one-way event stream)   │
                        └───────────────┬──────────────────────┘
                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                    src/agent/runner.ts                        │
        │   THE AGENT LOOP — for each turn:                             │
        │   route model → stream → parse tools → permit → exec → repeat │
        └───┬─────────────┬──────────────┬──────────────┬──────────────┘
            │             │              │              │
   ┌────────▼───┐  ┌──────▼─────┐  ┌─────▼──────┐  ┌────▼─────────┐
   │ src/router │  │src/providers│  │ src/tools │  │ src/safety   │
   │ which model│  │ how to call │  │ what it can│  │ may it run?  │
   │ for this   │  │ the model   │  │ do (39)    │  │ permissions  │
   │ step?      │  │ (8 adapters)│  │            │  │ engine       │
   └────────────┘  └─────────────┘  └────────────┘  └──────────────┘
            │             │              │              │
   ┌────────▼─────────────▼──────────────▼──────────────▼──────────┐
   │  Cross-cutting: memory (run logs, cost) · context (repoMap,    │
   │  skills, TANYA.md) · sessions (resume) · mcp (external tools)  │
   └───────────────────────────────────────────────────────────────┘
```

Five questions, five subsystems, one loop that ties them together:

| Question | Subsystem | Entry file |
|---|---|---|
| How do I start & render? | **CLI + UI + events** | `cli.ts`, `ui/ink/`, `events/` |
| What's the next action? | **Agent loop** | `agent/runner.ts` |
| Which model handles this step? | **Router** | `router/resolve.ts` |
| How do I call that model? | **Providers** | `providers/openAiCompatible.ts` |
| What actions exist? | **Tools** | `tools/registry.ts` |
| Is this action allowed? | **Safety** | `safety/permissions/engine.ts` |

---

## 2. Folder structure (annotated)

```
tanya/
├── src/
│   ├── cli.ts                  ← ⭐ ENTRY. argv → run mode → config → runAgent/Ink
│   │
│   ├── agent/                  ← ⭐ THE BRAIN. orchestration, the turn loop
│   │   ├── runner.ts              the main agent loop (runAgent)
│   │   ├── dispatch.ts            plan-then-execute orchestrator (subtask TDD)
│   │   ├── chat.ts                interactive REPL glue + command dispatch
│   │   ├── systemPrompt.ts        builds the system prompt (+ skill packs)
│   │   ├── compact.ts             context pruning: microcompact/snip/autoCompact
│   │   ├── compression.ts         token estimation helpers
│   │   ├── progressBudget.ts      soft cap + hard ceiling, "extend while progressing"
│   │   ├── interactiveBudget.ts   detect interactive coding runs (opt-in extension)
│   │   ├── phaseBudget.ts         per-phase turn allocation
│   │   ├── budgetLedger.ts        token/USD budget shared across sub-agents
│   │   ├── taskLedger.ts          persistent plan checklist → .tanya/plan.json
│   │   ├── planner.ts             single-shot execution-plan builder (advisory)
│   │   ├── acceptanceCriteria.ts  parse checklist from the prompt
│   │   ├── reviewer.ts            single-shot semantic diff review (advisory)
│   │   ├── postCheck.ts           run tsc/tests if the agent forgot to
│   │   ├── report.ts              final manifest / run report
│   │   ├── forbiddenPatterns.ts   gate: hardcoded tokens, escaped Swift \(n), etc.
│   │   ├── cycleDetect.ts         block circular sub-agent dispatch
│   │   ├── subAgentContext.ts     parent→child context, budget, workspace isolation
│   │   ├── validators/            static checks: apple, android, go, prisma, security, core
│   │   └── verifier/              final-state verification (shell-driven, per platform)
│   │
│   ├── router/                 ← WHICH MODEL. step classification + route resolution
│   │   ├── classify.ts            classifyStep(): planning/tool_call/synthesis/...
│   │   ├── resolve.ts             resolveRouteWithContextGuard(): token-fit + cascade
│   │   ├── load.ts                merge .tanya/routes.json (project→user→built-in)
│   │   ├── defaults.ts            BUILT_IN_ROUTES + cascade chain
│   │   └── types.ts              RouteRule / RouteTable / RouteCascadeEntry
│   │
│   ├── providers/              ← HOW TO CALL. OpenAI-compatible streaming + adapters
│   │   ├── openAiCompatible.ts    the universal streaming client
│   │   ├── factory.ts             createProvider / createProviderForRoute
│   │   ├── parser.ts              parseProviderToolCalls (stream-fragment reassembly)
│   │   ├── messageNormalize.ts    drop orphaned/duplicate tool messages
│   │   ├── retry.ts               concurrency semaphore + exponential backoff
│   │   ├── schemaFlatten.ts       flatten $ref tool schemas (Qwen)
│   │   └── adapters/              deepseek, openai, qwen, grok, groq, together, ollama
│   │
│   ├── tools/                  ← WHAT IT CAN DO. the 39-tool registry
│   │   ├── registry.ts            ToolRegistry: register/list/get/run
│   │   ├── types.ts              TanyaTool / ToolContext / ToolResult
│   │   ├── fsTools.ts             read/write/search/run_shell/run_command (+ guards)
│   │   ├── editBlock.ts           edit_block: exact + fuzzy search/replace
│   │   ├── planTool.ts            update_plan (persistent checklist)
│   │   ├── task.ts                task: spawn a scoped child agent
│   │   ├── repoMapTools.ts        inspect_repo_map
│   │   ├── projectContextTools.ts inspect_project_context / find_reusable_artifacts
│   │   ├── imageTools.ts          icons, svg→png, resize (sharp)
│   │   ├── adRenderTools.ts       ad/video asset generation
│   │   ├── obsidianTools.ts       search_obsidian_notes
│   │   └── metricsDashboardTools.ts
│   │
│   ├── safety/                 ← MAY IT RUN. permissions engine + workspace confinement
│   │   ├── permissions/
│   │   │   ├── engine.ts          decide(tool,input,ctx) → allow/deny/ask
│   │   │   ├── schema.ts          rules config + modes (default/ask/bypass/plan)
│   │   │   ├── modes.ts           mode → default decision
│   │   │   ├── rules.ts           load + merge + inheritance (child only tightens)
│   │   │   ├── config.ts          ~/.tanya + ./.tanya permissions.json
│   │   │   ├── host.ts            PermissionRequest / host approval handler
│   │   │   └── migrate.ts         learn rules from run history
│   │   └── workspace.ts           resolveInsideWorkspace (escape guard)
│   │
│   ├── events/                 ← THE NERVOUS SYSTEM. one-way event stream
│   │   ├── types.ts              EventSink + ~25 TanyaEvent variants
│   │   └── jsonl.ts               createJsonlSink (one event per line)
│   │
│   ├── ui/                     ← RENDERING
│   │   ├── ink/                   interactive React/Ink REPL
│   │   │   ├── App.tsx             root component (useReducer)
│   │   │   ├── state.ts            reducer: events → UI state (incl. inflight cost)
│   │   │   ├── sinkAdapter.ts      EventSink → React dispatch bridge
│   │   │   ├── runInkChat.tsx      render(<App/>) entry
│   │   │   ├── History/Footer/Input/ActivityPanel/PermissionPrompt.tsx
│   │   │   └── markdown.tsx        inline+block markdown for terminal
│   │   ├── humanSink.ts           plain-text sink (non-TTY / one-shot)
│   │   └── liveStatus.ts          single-line live status renderer
│   │
│   ├── sessions/               ← RESUME. append-only JSONL chat sessions
│   │   ├── storage.ts             create/load/append (.tanya/sessions or ~/.tanya)
│   │   ├── repl.ts                ChatSessionController (continue/resume/materialize)
│   │   └── types.ts              ChatSession / SessionTurn
│   │
│   ├── commands/               ← SLASH COMMANDS. /help /cost /mode /verify /sessions …
│   │   ├── registry.ts            CommandDefinition registry
│   │   ├── index.ts               parse + dispatch
│   │   ├── project.ts             load .tanya/commands/* (project-defined)
│   │   └── builtin/               audit, budget, clear, cost, help, memory, mcp,
│   │                              mode, route, skills, verify, sessions
│   │
│   ├── mcp/                    ← EXTERNAL TOOLS. Model Context Protocol
│   │   ├── client.ts              connect to MCP servers, register their tools
│   │   ├── config.ts              ~/.tanya + ./.tanya mcp.json
│   │   └── server.ts              expose Tanya's own tools as an MCP server
│   │
│   ├── context/               ← CODEBASE AWARENESS
│   │   ├── repoMap.ts             tree-sitter symbol index (cached by HEAD sha)
│   │   ├── autoContext.ts         task brief + Obsidian + artifacts → RunContext
│   │   ├── loader.ts              discover TANYA.md / CLAUDE.md / INSTRUCTIONS.md
│   │   └── artifacts.ts           reusable-pattern artifact index
│   │
│   ├── skills/                ← DYNAMIC PROMPT PACKS (domain/framework/lang/platform)
│   ├── memory/                ← run logs, cost/pricing, result cache, dedup, archives
│   ├── config/                ← env loading + TANIA_*→TANYA_* back-compat
│   ├── integrations/          ← cosmochat finalize hooks (external orchestration)
│   ├── obsidian/              ← vault search
│   ├── golden/ + eval/        ← benchmark & golden-task harness
│   ├── init/                  ← project init + legacy .tania→.tanya migration
│   └── utils/                 ← formatElapsed, misc
│
├── docs/                       ← this file + per-feature docs
├── schemas/                    ← JSON schemas (forbidden-patterns, etc.)
├── scripts/                    ← maintenance scripts
├── test/ + src/**/__tests__/   ← vitest (740+ tests, forks pool, isolated per file)
├── TANYA.md                    ← project instructions (Tanya's CLAUDE.md analogue)
└── dist/                       ← tsup build output (the published binary)
```

---

## 3. The agent loop (the heart)

`runAgent()` in `src/agent/runner.ts` is a single `for` loop over **turns**. Each
turn is one model call plus whatever tools it asks for.

```
runAgent(options)
  │
  ├─ build system prompt (systemPrompt.ts + skill packs + repoMap)
  ├─ resolve progress budget (soft = maxTurns, hard ceiling = 300 if opt-in)
  │
  └─ for (turn = 0; turn < hardCeiling; turn++):
        │
        1. COMPACT?  if tokens ≥ 85% → microcompact → snip → autoCompact
        │
        2. ROUTE     classifyStep(state) → resolveRouteWithContextGuard()
        │            → pick provider+model for THIS step (token-fit + cascade)
        │
        3. STREAM    provider.streamChat({messages, tools})
        │            → assistantText + reasoningText + rawToolCalls
        │
        4. PARSE     parseProviderToolCalls() → toolCalls[] (+ warnings/failures)
        │
        5. for each toolCall:
        │     a. PERMIT   tool.canRun() || decide() → allow/deny/ask
        │                  (ask → onPermissionRequest → user/UI)
        │     b. DEDUP    skip repeated reads / cached results
        │     c. EXEC     registry.run(tool, input, ctx)
        │     d. TRACK    changed files, progress (any ok tool = progress)
        │
        6. NO TOOLS? → finalize:
        │     buildFinalManifest → runValidators → verifyFinalState
        │     → forbiddenPatterns scan → postCheck (tsc/tests)
        │     → if blockers & repairs left: inject repair reminder, CONTINUE
        │     → else: RETURN { message, manifest }
        │
        └─ budget gate: shouldStopAfterBudget() only stops PAST the soft
           budget when no progress for 2 turns (never early-stops within budget)
```

**Why this shape matters** (and where the calculator-build failures came from):

- **Stopping mid-task** was the budget gate stopping a run that was still making
  progress → fixed by making extension opt-in for interactive coding + removing
  within-budget early-stop (`progressBudget.ts`, `interactiveBudget.ts`).
- **"Compiled ≠ works"** is exactly what the verification pipeline (step 6)
  exists to catch — `forbiddenPatterns.ts` now flags escaped Swift `\(n)`.
- **Sub-agents**: the `task` tool calls `runAgent()` recursively with an
  inherited (tightened) permission context, a reserved slice of the token
  budget, and an isolated workspace — see `subAgentContext.ts`.

---

## 4. Request lifecycle (end-to-end, one user turn)

```
user types prompt
   │
   ▼
ui/ink/App.tsx ── dispatch(turn_start) ──► ui/ink/state.ts (reducer)
   │  estimate prompt tokens → live counter
   ▼
agent/runner.ts  runAgent()
   │
   ├─► router/resolve.ts ──────► "deepseek:deepseek-v4-pro for planning"
   │
   ├─► providers/factory.ts ──► OpenAiCompatibleProvider
   │       └─► openAiCompatible.streamChat()
   │             ├─ messageNormalize → retry/concurrency → SSE decode
   │             └─ emits: message_delta, reasoning_chunk, tool_call …
   │
   ├─► events flow through EventSink ──► ui/ink/sinkAdapter.ts
   │       └─► dispatch(assistant_delta / activity_start / turn_progress)
   │             └─► state.ts → React re-render (History, ActivityPanel, Footer)
   │
   ├─► for each tool_call:
   │       safety/permissions/engine.decide() → (maybe) PermissionPrompt.tsx
   │       └─► tools/registry.run() → ToolResult → tool_result event
   │
   └─► final: report.ts manifest + validators + verifier
           └─► event "final" (metrics: tokens, costUsd)
                 └─► sessions/repl.appendCompletedTurn() → JSONL on disk
                 └─► memory/runLogs.ts → run cost archive
```

---

## 5. Cross-cutting subsystems

**Providers (`src/providers`)** — One `OpenAiCompatibleProvider` speaks the
OpenAI streaming protocol; per-vendor quirks live in thin **adapters**
(`capabilities`: parallel tools, JSON mode, round-trip reasoning, schema
flattening, context window). Supported: DeepSeek (default `deepseek-v4-pro`),
OpenAI, Qwen, Grok, Groq, Together, Ollama. Retry adds a per-provider
concurrency semaphore + exponential backoff honoring `Retry-After`.

**Router (`src/router`)** — Picks a model **per step, per turn**.
`classifyStep()` labels the step (planning / tool_call / synthesis /
verification / reasoning / unknown); `resolveRouteWithContextGuard()` chooses
the route whose `maxInputTokens × safetyFactor` fits the current context,
escalating through an ordered **cascade** when the context outgrows the cheap
model. Config layers: `.tanya/routes.json` (project) → `~/.tanya/routes.json`
(user) → built-in defaults.

**Tools (`src/tools`)** — 39 tools in an in-memory `ToolRegistry`. Each is an
OpenAI-compatible schema + a `run()`. Families: filesystem/search, `edit_block`
(exact + permission-gated fuzzy), shell (`run_shell` with progress streaming +
SIGTERM/SIGKILL cancel + workspace-mutation guards), `update_plan`, `task`
(sub-agents), repo/context inspection, mobile scaffolding & validators,
image/icon/video, Obsidian search. MCP servers register additional tools at
runtime.

**Safety (`src/safety`)** — Every tool call passes `decide(tool, input, ctx)`.
Modes: `default` / `ask` / `bypass` / `plan` (plan = deny-all dry run). Rules
match `tool:regex-on-input` plus path globs and spend thresholds
(turn/run/session, by tokens or USD). Sub-agents **inherit and can only
tighten** parent rules. Decisions are audit-logged; `migrate.ts` can suggest
rules from history.

**Events (`src/events`)** — The entire system communicates through one
`EventSink: (event) => void`. ~25 event types (message/reasoning/tool/
permission/lifecycle/subtask/compaction). Two terminal sinks: `humanSink`
(text) and `jsonl` (logs); the Ink UI is just another sink consumer. This is
what makes runs replayable and testable.

**Memory (`src/memory`)** — Run logs + cost archive (`runLogs.ts`, with the
configurable DeepSeek pricing table), result cache, file-read dedup, reasoning
archive, golden tasks, repair-run history.

**Context (`src/context`) + Skills (`src/skills`)** — `repoMap` builds a
tree-sitter symbol index cached by HEAD sha; `autoContext` fuses a task brief +
Obsidian notes + reusable artifacts into a `RunContext`; `loader` discovers
`TANYA.md` / `CLAUDE.md` / `.tanya/INSTRUCTIONS.md`. Skill packs are
markdown+frontmatter, loaded on demand by workspace/task signals into a
~5.8k-token budget.

**Sessions (`src/sessions`)** — Append-only JSONL per chat, project-scoped
(`.tanya/sessions`) or global (`~/.tanya`). `--continue` resumes the latest for
the cwd; `--resume <id>` a specific one.

**Commands (`src/commands`) + MCP (`src/mcp`)** — Slash commands
(`/help /cost /mode /route /verify /sessions …`) plus project-defined commands
from `.tanya/commands/*`. MCP works both directions: Tanya as a client
(consuming external tool servers) and as a server (exposing its own tools).

---

## 6. Naming & conventions worth knowing

- `.tanya/` (was `.tania/`) — per-project runtime dir: `plan.json`, `routes.json`,
  `permissions.json`, `mcp.json`, `sessions/`, `commands/`, audit log.
- `~/.tanya/` — user-global equivalents.
- `TANYA_*` env vars (with `TANIA_*` back-compat aliases preserved).
- `TANYA.md` — project instructions, Tanya's analogue to `CLAUDE.md`.
- Tests colocated in `__tests__/` (unit) and top-level `test/` (integration);
  vitest forks pool, isolated per file.

---

## 7. What already rhymes with Claude Code (and what's missing)

This is the bridge to the improvement roadmap — *capabilities only, from public
docs/observable behavior, never from proprietary source.*

| Claude Code concept | Tanya today | Gap to close |
|---|---|---|
| Slash commands | ✅ `src/commands` (built-in + project) | naming/UX parity, discoverability |
| MCP (client + server) | ✅ `src/mcp` | transports/auth coverage, UX |
| Subagents | ✅ `task` tool + `subAgentContext` | named agent types, parallel fan-out UX |
| Plan mode | ⚠️ `plan` permission mode + `planner.ts` | first-class interactive plan→approve flow |
| Permission modes | ✅ default/ask/bypass/plan | rule ergonomics, persisted "always" UX |
| `CLAUDE.md` project memory | ✅ `TANYA.md` + loader | nested/hierarchical discovery, `@imports` |
| Hooks | ⚠️ validators/verifiers/forbiddenPatterns | user-configurable lifecycle hooks |
| Context compaction | ✅ `compact.ts` cascade | auto-compact UX + transcript continuity |
| Session resume | ✅ `sessions/` | resume picker UX |
| Output styles / TODO UI | ⚠️ `update_plan` + ActivityPanel | richer plan/todo rendering |

> These are **capability** comparisons drawn from Claude Code's public
> documentation and observable behavior. The roadmap that follows builds each
> gap from public references and agent-design best practices — not from any
> leaked or proprietary source.
