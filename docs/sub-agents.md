# Sub-agents

Tanya's `task` tool lets a parent run delegate a scoped prompt to a child run
without creating a second trust boundary. The parent receives one structured
tool result; live child events still flow through the parent event sink with a
`subRunId`.

## Execution model

A task request may provide:

```json
{
  "prompt": "Inspect the auth module.",
  "workspace": "src/auth",
  "max_turns": 12,
  "skill_pack_overrides": ["framework/nextjs-app-router"],
  "token_budget": { "max_tokens": 12000, "max_usd": 0.05 },
  "treat_failure_as": "blocker"
}
```

Children inherit the parent's history snapshot, provider, skill packs,
permission context, and run context. Run IDs append dotted task segments:
`r-root`, `r-root.t-1`, `r-root.t-1.t-1`.

## Permission inheritance

Permissions tighten on descent:

- parent `alwaysDeny` beats every child allow,
- parent `alwaysAsk` beats overlapping child allows,
- denied parent path rules beat child path allows,
- a child cannot switch from a stricter parent mode back to `bypass`,
- child workspaces must remain inside the parent workspace.

Children may add new denies, asks, path restrictions, and spend rules. They may
not relax inherited rules.

## Budget and recursion safety

- `TANYA_SUBTASK_MAX_DEPTH` controls the recursion cap; the default is `2`.
- `TANYA_SUBTASK_MAX_PARALLEL` controls the child semaphore; the default is `3`.
- `BudgetLedger` reserves parent budget before child start and returns unused
  budget when the child finishes.
- Prompt-cycle detection rejects near-duplicate or substring child prompts by
  default. Set `TANYA_SUBTASK_CYCLE_CHECK=0` only when the caller intentionally
  wants to disable that guard.

The legacy `TANYA_*` aliases remain accepted for these variables.

## Cancellation

Parent cancellation propagates through the child's `AbortSignal`. Active child
tools receive the cancellation request immediately, and child runs stop before
starting another turn after the parent signal fires. This prevents orphan child
agents after a parent `SIGINT`.

## Verifier composition

Each child runs Tanya's normal verifier on its scoped workspace. The child
result carries:

- verdict,
- blockers,
- changed files,
- token usage,
- nested child run IDs.

The parent manifest includes child verdicts. A failed child is a parent blocker
by default:

- `blocker` — default; parent final report is blocked.
- `warning` — verdict remains visible in `childWarnings` without blocking the
  parent.
- `ignore` — child is omitted from the parent report, but the verdict still
  remains in `.tanya/audit.jsonl`.

## Memory rollup

Golden-task memory is recorded at the parent level only: one user intent, one
golden-task record. Child run IDs are linked from that parent record, and child
run summaries remain available under `.tanya/runs/` for replay and
diagnostics. `/memory --full <id>` renders linked child summaries indented
beneath the parent record.
