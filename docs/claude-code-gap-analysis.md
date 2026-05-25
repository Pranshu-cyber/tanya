# Claude Code and public coding-agent prior art: Tanya gap analysis

Written 2026-05-10 after Tanya's deterministic verifier work landed.
Updated for OSS launch readiness on 2026-05-15.

This document compares Tanya's roadmap against public, observable coding-agent
patterns:

- Anthropic's public Claude Code documentation and published npm package
  behavior.
- Open-source coding-agent projects such as opencode, Aider, and Gemini CLI.
- Tanya's own implementation, tests, and roadmap goals.

No private or non-public code is used as roadmap material. This is an
architecture and product comparison, not a porting guide.

## Public sources

- Anthropic Claude Code documentation:
  <https://docs.anthropic.com/en/docs/claude-code/overview>
- Published Claude Code npm package:
  <https://www.npmjs.com/package/@anthropic-ai/claude-code>
- opencode:
  <https://github.com/sst/opencode>
- Aider:
  <https://github.com/Aider-AI/aider>
- Gemini CLI:
  <https://github.com/google-gemini/gemini-cli>

---

## What Tanya already does well

| Area | Tanya | Public prior-art analogue | OSS-launch implication |
|------|-------|---------------------------|------------------------|
| Deterministic final report | `buildStructuredReport` + `TanyaFinalManifest` | Agent transcripts and run summaries | Keep the result contract stable and documented. |
| Final-state verifier | `src/agent/verifier/` | Most public coding agents rely primarily on transcript/tool evidence | This is Tanya's clearest differentiator; do not weaken it for UX polish. |
| Golden-task memory | `src/memory/goldenTasks.ts` | Evaluation fixtures and replay logs | Treat regressions as product failures, not just test failures. |
| Repair-run snapshots | `src/memory/repairRuns.ts` | Session resume and run logs | Preserve auditable state around repair attempts. |
| Skills with frontmatter + lazy loading | `src/skills/load.ts`, skill packs | Prompt packs, slash commands, and extension registries | Keep skill loading explicit and cheap. |
| Validators | `src/agent/validators.ts` | Tool guards and project-specific checks | Public docs should explain what validators prove and what they do not. |
| Forbidden-patterns gate | `src/agent/forbiddenPatterns.ts` | Secret-detection and unsafe-output checks | Market this as a guardrail, not a full security boundary. |

**Implication:** Tanya's task-completion guarantees are built around verifier,
validator, and golden-task evidence. Roadmap work should preserve those
contracts even when borrowing familiar UX patterns from public coding agents.

---

## Where Tanya lags, ranked by ROI

### 1. Streaming tool execution

**Public pattern.** Modern coding agents keep long-running shell commands from
looking frozen by showing partial stdout/stderr in the terminal while the tool
continues to run. The final tool result remains the durable conversation item.

**Tanya before M1.** `runner.ts` waited for tool completion, then wrote to
`EventSink` once. A 30-second build or test run looked like a hang.

**Tanya after M1.** Long-running shell tools emit `tool_progress` events to
the UI/log path, support cancellation, and return a final `tool_result` for the
model conversation. Partial output stays out of the provider transcript.

**Files involved.**

- `src/events/types.ts`
- `src/events/jsonlWriter.ts`
- `src/events/fileLogger.ts`
- `src/tools/registry.ts`
- `src/tools/runShell.ts`
- `src/agent/runner.ts`
- `src/cli.ts`

**Hazards to keep testing.**

- Output volume: verbose package installs and builds need throttling.
- Conversation integrity: partial output must remain UI/log-only.
- Replay determinism: golden-task playback should not depend on progress event
  ordering.

### 2. Permission layer

**Public pattern.** Coding-agent CLIs commonly let users approve, deny, or
pre-authorize classes of tool use. Public Claude Code docs describe settings
and permissions; other agents expose allowlists, approval modes, or command
guards.

**Tanya today.** Tools currently run with broad local access. The
forbidden-patterns gate runs after execution and is useful for output
validation, not pre-execution authorization.

**What changes.**

- Add `src/safety/permissions/` with a small rules engine and explicit modes.
- Each tool can declare a pre-run decision hook.
- `runner.ts` asks the engine before dispatching tools.
- `EventSink` records permission requests and decisions.
- Decisions are written to an audit log for later review.

**Files to touch.**

- New: `src/safety/permissions/{rules,engine,modes}.ts`
- `src/tools/registry.ts`
- `src/agent/runner.ts`
- `src/events/types.ts`
- `src/safety/workspace.ts`

**Hidden hazards.**

- Golden tasks assume current tool access. Default behavior should preserve
  existing tests until stricter modes are enabled deliberately.
- Command-based rules are not enough; path and workspace context matter.
- Denials must surface as verifier blockers, not disappear as silent tool
  failures.

**Effort.** Roughly two weeks.

### 3. Reactive context compaction

**Public pattern.** Long-running agents need strategies for compressing or
archiving old messages while retaining enough evidence for correct future
actions. Public projects vary in the details, but the product need is the same:
handle long sessions without silently losing crucial context.

**Tanya today.** `CONTEXT_TOKEN_LIMIT = 48_000` and
`CONTEXT_SUMMARY_KEEP_RECENT = 6` provide a coarse summary path. There is no
strong reaction loop for provider context-window failures and no full archive
of compacted turns.

**What changes.**

- Detect provider context-window failures around model calls.
- Summarize or compact older messages more aggressively on retry.
- Persist archived messages under `.tanya/runs/<runId>/archive.jsonl`.
- Emit a compaction event so users can see why the agent paused.

**Files to touch.**

- `src/agent/runner.ts`
- `src/providers/types.ts`
- New: `src/agent/compact.ts`
- New: `src/memory/runArchive.ts`

**Hidden hazards.**

- Context loss can corrupt repair loops while still producing fluent output.
- Verifier and forbidden-pattern checks must still see the files and blockers
  that matter.
- Skill-pack injection happens per turn, so compaction must not make loaded
  skill context inconsistent.

**Effort.** Roughly three weeks.

### 4. Slash commands

**Public pattern.** Coding-agent CLIs often reserve leading `/` for local
commands such as clearing context, listing configuration, showing cost, or
running an explicit verification pass.

**Tanya today.** User input is treated as a prompt.

**What changes.**

- Add `src/commands/{registry,index}.ts`.
- Preprocess interactive REPL lines in `src/cli.ts`.
- Start with a small set: `/clear`, `/skills`, `/verify`, `/cost`, `/memory`.

**Files to touch.**

- New: `src/commands/{registry.ts,builtin/*.ts}`
- `src/cli.ts`
- `src/memory/runLogs.ts`

**Hidden hazards.**

- Preserve `tanya <prompt>` ergonomics. Slash commands should be local REPL
  commands, not surprising rewrites of one-shot prompts.

**Effort.** Roughly three days for the first useful set.

### 5. Sub-agent task tool

**Public pattern.** Some agent systems can delegate a bounded subtask to a
child run, then return a summarized result to the parent. This enables research
or inspection work to happen without derailing the top-level task.

**Tanya today.** The loop is linear. There is no first-class way to delegate.

**What changes.**

- Add a `task` tool with input such as `{ prompt, context_paths?, max_turns? }`.
- Run a child agent context with inherited safety settings and a hard depth
  cap.
- Forward child events to the parent `EventSink` with a task id.
- Include the child manifest in the parent tool result.

**Files to touch.**

- New: `src/tools/task.ts`
- `src/tools/registry.ts`
- `src/agent/runner.ts`
- `src/events/types.ts`

**Hidden hazards.**

- Recursion depth must be capped.
- Child runs must share or enforce the parent budget.
- Child verifier results should become parent-visible blockers when relevant.

**Effort.** Roughly two weeks.

---

## Patterns to skip

| Pattern | Why skip |
|---------|----------|
| Full terminal UI rewrite | Tanya's `EventSink`, JSONL logs, and host integrations cover the current need with much less surface area. Revisit only if the CLI UX becomes the main product. |
| Mascot or novelty modes | Not launch-critical and easy to misread as polish over substance. |
| Background autonomous agents | Premature before permissions, task delegation, and audit trails are stronger. |
| Swarm-style coordinator | Compose this later from slash commands plus the task tool if real workflows demand it. |
| IDE-specific bridge | Out of scope for the CLI launch; MCP is the better future integration path. |
| Voice integration | Out of scope. |

---

## Recommended sequence

If we want Tanya to feel more responsive and contributor-friendly without
compromising verifier-driven safety, the order is:

1. **Streaming tool execution** - biggest visible improvement, already shipped
   in M1.
2. **OSS launch readiness** - clean attribution, CI, examples, and contributor
   paths before public announcement.
3. **Slash commands** - daily UX, fast win, low safety risk.
4. **Permission layer** - needed before broader untrusted workspace use.
5. **Sub-agent task tool** - composes with permissions and unlocks delegation.
6. **Reactive compaction** - valuable once long sessions routinely hit context
   limits.

The verifier remains the constraint: if a feature makes the final verdict less
auditable, redesign the feature before shipping it.

---

## How this complements the verifier work

The deterministic verifier checks Tanya's final claim against the run's
observable state. The roadmap items above expand what Tanya can do while
keeping that final claim auditable:

- Streaming lets users see and cancel long-running work earlier.
- Permissions prevent risky actions before the verifier has to reason about
  their aftermath.
- Compaction keeps long repair loops viable without hiding important evidence.
- Sub-agents let verifier results roll up from delegated work.
- Slash commands give users explicit local control over verification, memory,
  and session state.
