# Tanya → Claude Code Parity Roadmap

> What Tanya has today, and what it still needs to feel like Claude Code.
>
> **Sourcing note:** every "needed" item below is specified from Claude Code's
> *public documentation and observable behavior* plus general agent-design
> best practices. None of it is derived from proprietary or leaked source.
> We are matching **capabilities and UX**, building our own implementation.

Legend: ✅ have · ⚠️ partial · ❌ missing · ⭐ Tanya already ahead

---

## Part A — What we have today ✅

Grouped the way a user experiences it.

### Core agent
- ✅ Interactive REPL (Ink/React) **and** one-shot modes (`run` / `ask` / `review`)
- ✅ Streaming output (text + reasoning), live token/cost counter in footer
- ✅ The turn loop: route → stream → parse tools → permit → execute → repeat
- ✅ Extended thinking / reasoning models with per-step reasoning caps
- ✅ Context compaction cascade (microcompact → snip → autoCompact)
- ✅ Persistent task checklist (`update_plan` → `.tanya/plan.json`) — TodoWrite analogue

### Tools
- ✅ File ops: `read_file`, `write_file`, `list_files`, `search` (ripgrep),
  `search_replace`, `apply_patch`, `copy_file/dir`
- ✅ `edit_block` — exact + permission-gated fuzzy search/replace
- ✅ `run_shell` / `run_command` — streaming progress, SIGTERM/SIGKILL cancel,
  workspace-mutation guards
- ✅ `task` — spawn a scoped sub-agent
- ✅ Repo/context inspection, mobile scaffolding + validators, image/icon/video
  generation, Obsidian search

### Safety & permissions
- ✅ Permission **modes**: `default` / `ask` / `bypass` / `plan`
- ✅ Rule engine: `tool:regex` allow/deny/ask + path globs + spend caps
  (turn/run/session, tokens or USD)
- ✅ Sub-agent inheritance (children can only **tighten** parent rules)
- ✅ Audit log of every decision; `migrate.ts` suggests rules from history
- ✅ Workspace confinement (escape guard)

### Extensibility & integration
- ✅ **MCP client** (stdio/SSE/HTTP) and **MCP server** (expose Tanya's tools)
- ✅ Slash commands — built-in (`/help /cost /mode /route /verify /skills
  /memory /mcp /budget /audit /clear`) + project commands from `.tanya/commands/*`
- ✅ **Skills** — dynamic markdown prompt packs, loaded by workspace/task signals
- ✅ Project memory file `TANYA.md` (+ loader also discovers `CLAUDE.md` /
  `.tanya/INSTRUCTIONS.md`)
- ✅ Session resume (`--continue`, `--resume <id>`, append-only JSONL)

### Quality gates (Tanya-specific verification)
- ✅ Static validators (apple / android / go / prisma / security / core)
- ✅ Final-state verifier (shell-driven, per platform)
- ✅ `forbiddenPatterns` gate (hardcoded tokens, escaped Swift `\(n)`, disabled auth…)
- ✅ `postCheck` (runs tsc/tests if the agent forgot)

---

## Part B — Capability matrix vs Claude Code

| Area | Claude Code capability | Tanya | Gap / action |
|---|---|---|---|
| **Run modes** | interactive + headless `-p` | ✅ | parity |
| **Slash commands** | built-in + custom `.md` w/ `$ARGUMENTS`, `!bash`, `@file` | ⚠️ | project cmds exist; add arg-templating, `!`/`@` expansion, frontmatter |
| **Project memory** | `CLAUDE.md` nested + `@import` + `/memory` | ⚠️ | have flat `TANYA.md`; add hierarchical discovery + `@imports` |
| **Subagents** | named `.claude/agents/*.md`, parallel fan-out, `/agents` | ⚠️ | have `task` tool; add **named agent types** + parallel + manager UX |
| **Hooks** | user lifecycle hooks (PreToolUse, PostToolUse, Stop, SessionStart, PreCompact…) | ❌ | **biggest gap** — add a user-configurable hook system |
| **Plan mode** | first-class plan→approve toggle (shift-tab), `ExitPlanMode` | ⚠️ | have `plan` permission mode; add interactive propose-plan-then-approve flow |
| **MCP** | client + server + OAuth | ✅ | parity (verify OAuth flows) |
| **Permissions** | modes + allow/deny lists + `/permissions` | ✅ | parity (add `/permissions` editor UX) |
| **TODO UI** | `TodoWrite` live checklist | ✅ | have `update_plan`; richer rendering optional |
| **Web tools** | `WebFetch` + `WebSearch` | ❌ | add fetch + search tools |
| **Background bash** | `run_in_background` + `BashOutput` + `KillShell` | ❌ | add detached shells + output polling + kill |
| **Image input** | paste/привести screenshots to the model | ❌ | only a `vision` capability flag today; add image-input pipeline |
| **Checkpoint / rewind** | `/rewind`, Esc-Esc restore code+chat | ❌ | add run checkpoints + restore |
| **Settings hierarchy** | enterprise/user/project `settings.json` | ⚠️ | configs are split across `.tanya/*`; unify into a settings file |
| **Output styles** | `/output-style`, custom styles | ❌ | add output-style presets |
| **Statusline** | custom statusline command | ⚠️ | have a footer; make it user-configurable |
| **`/context`** | view context-window usage | ⚠️ | have counters; add a `/context` breakdown |
| **Git / PR** | commit + **PR creation**, GitHub app review | ⚠️ | commit-aware (`git.ts`); add PR creation + review flow |
| **IDE integration** | VS Code / JetBrains diff, diagnostics | ❌ | out of scope near-term |
| **Vim mode** | `/vim` editing | ❌ | low priority |
| **SDK** | Agent SDK to build custom agents | ❌ | later (Tanya-as-library) |
| **Sandbox** | `sandbox-exec` / bubblewrap for bash | ⚠️ | permission-gated only; add OS sandbox (already a tracked follow-up) |

---

## Part C — What we need: prioritized roadmap

Ordered by **leverage** (how much it closes the "feels like Claude Code" gap)
÷ **effort**. Each phase is independently shippable.

### Phase 1 — Extensibility core (the multiplier features)
The things that turn Tanya from "an agent" into "a platform you can shape."

1. **Hooks system** ❌ → the single biggest gap.
   User-defined shell commands fired on lifecycle events
   (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`,
   `SessionStart`, `SessionEnd`, `PreCompact`). Config in settings; can block,
   warn, or inject context. *Tanya already has the internal seam — validators &
   forbiddenPatterns are hooks in spirit; this exposes it to users.*
2. **Named subagents** ⚠️ → `.tanya/agents/*.md` with frontmatter (name,
   description, tools, model). Surfaces in a `/agents` picker; the `task` tool
   can target a named type. Builds directly on existing `subAgentContext`.
3. **Custom slash command templating** ⚠️ → `$ARGUMENTS` / `$1`,
   `!`-bash-expansion, `@file` inclusion, frontmatter (allowed-tools, model).
   Extends the existing project-command loader.

### Phase 2 — Interaction parity (the daily-feel features)
4. **First-class plan mode** ⚠️ → propose a plan, render it, wait for approval,
   then execute. Wrap the existing `planner.ts` + `plan` permission mode in an
   interactive toggle (shift-tab cycle: normal → auto-accept → plan).
5. **Hierarchical memory + `@imports`** ⚠️ → walk up the tree for `TANYA.md`,
   support `@path` imports, add `/memory` to view/edit. Extends `context/loader`.
6. **Web tools** ❌ → `web_fetch` (URL → markdown) and `web_search`. Net-new
   tools in the registry, permission-gated.
7. **Background shells** ❌ → `run_shell({ background: true })` + `read_shell` +
   `kill_shell`. Extends `fsTools` process management.

### Phase 3 — Power-user & trust features
8. **Checkpoint / rewind** ❌ → snapshot workspace + conversation per turn;
   `/rewind` to restore. Leverage git snapshots already in `agent/git.ts`.
9. **Unified `settings.json`** ⚠️ → one schema merging permissions, routes, mcp,
   hooks, model (enterprise → user → project → local precedence).
10. **`/context` + configurable statusline** ⚠️ → context-usage breakdown
    command; user-templated footer/statusline.
11. **Output styles** ❌ → presets (concise / explanatory / teaching) injected
    into the system prompt.

### Phase 4 — Ecosystem (post-parity)
12. **Git/PR automation** ⚠️ → PR creation + a review flow.
13. **OS sandbox for bash** ⚠️ → `sandbox-exec`/bubblewrap (already tracked).
14. **Image input** ❌ → screenshot → model pipeline.
15. **SDK / IDE / Vim** — later, demand-driven.

---

## Part D — Where Tanya already beats Claude Code ⭐ (don't lose these)

These are genuine differentiators — keep and market them.

- ⭐ **Per-step, multi-provider routing** with token-fit **cascade** — Tanya
  picks the cheapest model that fits *each step* and escalates on overflow.
  Claude Code is single-family.
- ⭐ **Cost-aware budgets** — token/USD spend caps as first-class permission
  rules (turn/run/session), with live cost in the footer.
- ⭐ **`forbiddenPatterns` shipping-bug gate** — catches "compiled ≠ works"
  classes (escaped Swift `\(n)`, disabled auth, hardcoded secrets).
- ⭐ **Platform validators + final-state verifier** — apple/android/go/prisma
  domain checks built in.
- ⭐ **Eval / golden-task harness** (`src/eval`, `src/golden`) — reproducible
  benchmarking baked into the product.
- ⭐ **Obsidian knowledge integration** — vault search as a tool + context source.
- ⭐ **Provider-agnostic** — DeepSeek-first, runs on OpenAI/Qwen/Grok/Groq/
  Together/Ollama via one adapter layer.

---

## Suggested sequence

```
Phase 1  (hooks, named agents, command templating)   ← do first: highest leverage
   │
Phase 2  (plan mode, memory imports, web, bg shells)  ← daily-feel parity
   │
Phase 3  (rewind, settings.json, /context, styles)    ← trust & polish
   │
Phase 4  (PR, sandbox, image, SDK)                    ← ecosystem
```

Start Phase 1 → Hooks: it's the gap that most changes what Tanya *can become*,
and the internal seam (validators/forbiddenPatterns) is already there to expose.
