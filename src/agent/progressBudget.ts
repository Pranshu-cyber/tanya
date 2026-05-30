// Progress-aware turn budget. A fixed step cap stops a run the instant the count
// is hit — even mid-progress. This lets a run EXTEND past its soft budget while
// it keeps making progress, up to a hard ceiling.
//
// Two deliberate constraints, learned from review:
//  - Opt-in only. Extension is enabled per-call (extendOnProgress), NOT inferred
//    from the turn count. Callers that pass an explicit hard cap (eval harness,
//    sub-agents, `--max-turns`, tests) must get EXACTLY that cap, so they never
//    opt in and behaviour is unchanged for them.
//  - Never early-stops WITHIN the soft budget. The runner already has purpose
//    built stuck-loop detection (shell-spiral, subtask-cycle, network-fallback,
//    no-tool-no-report). This module only adds extension past the budget; it
//    must not introduce a second, coarser stall-kill that fires on a cold start
//    or a normal failing compile→fix→compile loop.

export interface ProgressBudget {
  enabled: boolean;
  hardCeiling: number;
}

export interface ProgressBudgetOptions {
  extendOnProgress?: boolean;
  ceiling?: number;
}

export function resolveProgressBudget(maxTurns: number, opts: ProgressBudgetOptions = {}): ProgressBudget {
  const ceiling = opts.ceiling ?? 300;
  const enabled = Boolean(opts.extendOnProgress) && maxTurns > 0;
  return {
    enabled,
    hardCeiling: enabled ? Math.max(maxTurns, ceiling) : maxTurns,
  };
}

// Called at the start of each turn. Returns true only PAST the soft budget, once
// the previous turn made no progress. `lastProgressTurn` is the index of the
// most recent turn that made progress; turnsSinceProgress === 1 means the
// immediately-previous turn progressed (still extending). When extension is
// disabled, hardCeiling === maxTurns so the loop bound already enforces the cap
// and this always returns false — identical to the old fixed step cap.
export function shouldStopAfterBudget(
  turn: number,
  maxTurns: number,
  lastProgressTurn: number,
  budget: ProgressBudget,
): boolean {
  if (!budget.enabled) return false;
  if (turn < maxTurns) return false; // within the soft budget: never early-stop here
  return turn - lastProgressTurn >= 2; // past budget: stop once the last turn made no progress
}
