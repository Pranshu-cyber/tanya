# Design: User-Configurable Hooks (Phase 1)

> Status: proposed. Target: the highest-leverage Claude-Code-parity gap.
> Spec'd from Claude Code's public hooks behavior; this is Tanya's own design,
> fitted to Tanya's event/permission/runner architecture.

## 1. Why hooks, and why they're cheap for Tanya

Hooks let a user run their own shell command at fixed points in the agent
lifecycle — to **block** an action, **inject context**, or **react** (lint,
notify, log). Claude Code exposes `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`,
`PreCompact`.

Tanya already has the *internal* version of this — `validators`,
`forbiddenPatterns`, and `postCheck` are hooks in spirit, hard-wired into
`runner.ts`. This design **generalizes that seam** into a user-facing mechanism
instead of adding more special cases (the "altitude" win: one general mechanism,
not N bespoke checks).

## 2. The lifecycle events

| Event | Fires | Can block? | Can inject context? |
|---|---|---|---|
| `SessionStart` | session created/resumed | no | yes (prepend to history) |
| `UserPromptSubmit` | user submits a prompt, before the turn loop | yes (reject prompt) | yes (add context to the turn) |
| `PreToolUse` | after parse, **before** permission + execution | yes (deny the call) | yes (feedback to model) |
| `PostToolUse` | after a tool result | no (already ran) | yes (feedback to model) |
| `PreCompact` | before the compaction cascade | no | no (advisory log) |
| `Stop` | main agent about to finish a turn | yes (force another turn) | yes (reason) |
| `SubagentStop` | a `task` child about to finish | yes (force another turn) | yes |
| `SessionEnd` | session materialized/exit | no | no |

## 3. Config schema

Lives in `.tanya/hooks.json` (project) and `~/.tanya/hooks.json` (user), merged
**project-over-user** exactly like `permissions.json` / `routes.json`
(`src/router/load.ts` is the pattern to copy).

```jsonc
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_shell|run_command",   // regex on tool name; omit = all
        "command": "./.tanya/hooks/guard-shell.sh",
        "timeoutMs": 5000,                      // default 30000
        "blocking": true                        // default true for blockable events
      }
    ],
    "PostToolUse": [
      { "matcher": "write_file|edit_block", "command": "npm run -s lint:staged" }
    ],
    "UserPromptSubmit": [
      { "command": "./.tanya/hooks/inject-ticket-context.sh" }
    ]
  }
}
```

- `matcher` (optional): regex tested against the tool name (`PreToolUse`/
  `PostToolUse`) or ignored for non-tool events.
- `command` (required): shell command. Runs through the same `run_shell`
  machinery (`src/tools/fsTools.ts`) so it inherits workspace cwd, env, and
  SIGTERM/SIGKILL timeout handling — no new process plumbing.
- `blocking`: if false, the hook is fire-and-forget (output ignored, never
  blocks). Non-blockable events force this false.

## 4. The hook I/O contract

Each hook receives a JSON **payload on stdin** and may return a JSON **decision
on stdout** (plain non-JSON stdout is treated as `{ "additionalContext": "<stdout>" }`).

**Stdin payload (example, `PreToolUse`):**
```json
{
  "event": "PreToolUse",
  "sessionId": "01J...",
  "runId": "run_...",
  "cwd": "/abs/workspace",
  "tool": "run_shell",
  "input": { "script": "rm -rf build" }
}
```

**Stdout decision (all fields optional):**
```json
{
  "decision": "block",                 // "block" | "allow" | undefined(=neutral)
  "reason": "rm -rf is not allowed here",
  "additionalContext": "Repo uses `npm run clean` instead."
}
```

Resolution rules:
- **Exit code 0** + no/neutral decision → proceed normally.
- **`decision: "block"`** (or **exit code 2**, Claude-Code-compatible) → block
  the action; `reason` is surfaced to the model as a tool/turn error.
- `additionalContext` → appended to the model-visible context for that step.
- Any other non-zero exit → treated as a hook **error**: logged, surfaced as a
  system message, and (for blocking hooks) fails closed = block.

## 5. Integration points (where the calls go)

A single helper drives all of them:

```ts
// src/hooks/run.ts
export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  addedContext: string[];
}
export async function runHooks(
  event: HookEvent,
  payload: HookPayload,
  hooks: LoadedHooks,
  ctx: { cwd: string; signal?: AbortSignal; sink: EventSink },
): Promise<HookOutcome>;
```

Wire-in sites (file references are to today's code):

1. **`PreToolUse`** — `src/agent/runner.ts`, in the tool loop **right before** the
   permission `decide()` call (~line 2102). If `outcome.blocked`, synthesize a
   denial `tool_result` (reuse the existing deny path) and skip execution.
   Order: **hooks → permission engine** (a hook block short-circuits; otherwise
   permissions still apply). `addedContext` is appended to the tool feedback.
2. **`PostToolUse`** — same loop, right after the `ToolResult` is produced
   (~line 2245). Non-blocking; `addedContext` becomes extra model-visible note.
3. **`UserPromptSubmit`** — `src/agent/runner.ts` entry (or `src/ui/ink/App.tsx`
   `handleSubmit` for the REPL path) before `turn_start`. Block → reject the
   prompt with `reason`; otherwise prepend `addedContext` to the turn.
4. **`PreCompact`** — `src/agent/compact.ts`, at the top of the cascade
   (advisory only; emit a `compact_event` note).
5. **`Stop` / `SubagentStop`** — `runner.ts` finalize path, before returning the
   manifest. Block → inject `reason` and run one more turn (respect a small cap,
   e.g. 2, to avoid loops — reuse `cycleDetect.ts` spirit).
6. **`SessionStart` / `SessionEnd`** — `src/sessions/repl.ts`
   (`startChatSession` / `materialize`).

Emit a new `hook_event` on the `EventSink` (add to `src/events/types.ts`) for
every fire so the UI/JSONL log shows hook activity, just like tool calls.

## 6. Security model

Hooks are **arbitrary code defined by the user/project** — same trust class as
project slash commands (`src/commands/project.ts`) and MCP servers. Therefore:

- Load only from `.tanya/hooks.json` / `~/.tanya/hooks.json` (no model-writable
  source). Surface a one-time notice listing active hooks at session start
  (mirror the MCP "untrusted server" notice).
- Hooks run through `run_shell`, so the **permission engine still audits the
  hook's own shell** — a hook can't escape workspace confinement silently.
- `timeoutMs` bounds every hook; a hung hook is killed (SIGTERM→SIGKILL) and
  treated as an error (fail-closed for blocking events).
- Document loudly: "a `PreToolUse` hook can execute on every tool call — keep it
  fast and side-effect-light."

## 7. Migration of the built-in checks (the altitude payoff)

Re-express today's hard-wired gates as **default, internal hooks** registered on
the same pipeline:

- `forbiddenPatterns` → a built-in `PostToolUse`/`Stop` hook.
- `postCheck` (tsc/test) → a built-in `Stop` hook.
- `validators` → built-in `Stop` hooks per platform.

They keep running by default (no behavior change), but now share one mechanism
with user hooks — easier to reason about, test, and reorder. This is optional
for v1 but is the reason the design pays for itself.

## 8. Test plan (vitest)

- `src/hooks/__tests__/run.test.ts` — payload shape, stdout parsing (JSON +
  plain), exit-code 2 == block, timeout == fail-closed, matcher regex.
- `src/hooks/__tests__/load.test.ts` — project-over-user merge, schema
  validation, bad-regex rejection (copy `router/load` tests).
- `runner` integration: a `PreToolUse` block prevents execution and surfaces the
  reason; `PostToolUse` adds context; `UserPromptSubmit` block rejects the turn.
- A no-op hooks config is a zero-overhead path (assert no shell spawned).

## 9. Rollout

1. `src/hooks/{types,load,run}.ts` + tests (no wiring) — pure, reviewable.
2. Wire `PreToolUse` + `PostToolUse` in `runner.ts` (highest value).
3. Add `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart/End`, `PreCompact`.
4. `hook_event` on the sink + `/hooks` command to list active hooks.
5. (Optional) port built-in checks onto the pipeline (§7).
6. Docs: `docs/hooks.md` + README Roadmap checkbox ticked.

Each step is its own PR; step 1 ships value as a standalone, testable module.
