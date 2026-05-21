# Eval Format

Tanya eval suites are versioned JSON-compatible documents. A suite plus a Tanya
version plus a model identifies the benchmark contract.

## EvalSuite

```ts
type EvalSuite = {
  name: string;
  version: string;
  tasks: Array<{
    id: string;
    repo_setup:
      | { type: "git_clone"; url: string; commit: string; path?: string }
      | { type: "local_fixture"; path: string };
    prompt: string;
    expected_files?: string[];
    verifier_extension?: string;
  }>;
};
```

`git_clone` tasks are checked out at the pinned commit in an isolated temporary
workspace. `local_fixture` tasks are copied from a fixture directory into an
isolated temporary workspace.

## EvalResult

```ts
type EvalResult = {
  suite: string;
  suiteVersion: string;
  tanyaVersion: string;
  model: string;
  provider?: string;
  totalCostUsd: number;
  costPerPass: number | null;
  tokensPerPass: number | null;
  reasoningShare: number;
  runs: Array<{
    taskId: string;
    status: "passed" | "failed" | "errored" | "timeout";
    durationMs: number;
    tokensUsed: {
      input: number;
      output: number;
      reasoning?: number;
      system_prompt?: number;
      repo_map?: number;
    };
    costUsd: number;
    verifierVerdict: "passed" | "failed";
    diff?: string;
    error?: string;
  }>;
};
```

The suite-level aggregates are used by `eco-30` and CI comparison gates:

- `totalCostUsd`: sum of per-task cost.
- `costPerPass`: total cost divided by passed tasks, or `null` when nothing passed.
- `tokensPerPass`: input + output + reasoning tokens divided by passed tasks.
- `reasoningShare`: reasoning tokens divided by input + output + reasoning tokens.

## Determinism Contract

The intended stable key is:

```text
suite name + suite version + Tanya version + provider/model
```

Tanya eval runs use temperature 0 where the active provider supports it. The
same key should produce byte-stable task IDs and verdict fields. The following
axes are explicitly outside the byte-stability promise:

- Provider-side nondeterminism when no seed control exists.
- External package registry availability during dependency-install tasks.
- Network or upstream repository availability for `git_clone` setup.
- Task timeouts caused by transient local machine load.

Regression comparisons should therefore treat verdict drift, new errors, and
cost regressions as hard failures, while allowing reruns for known flaky setup
failures that are documented in the suite metadata.
