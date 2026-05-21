# Tanya Eval Runner

Run an eval suite:

```bash
tanya eval --suite tanya-native --out .tania/eval/results/tanya-native.json
```

Dry-run a suite without provider calls:

```bash
tanya eval --suite eco-30 --dry-run
```

Report and compare:

```bash
tanya eval report .tania/eval/results/tanya-native.json
tanya eval compare docs/benchmarks/tanya-native-latest.json .tania/eval/results/tanya-native.json --format markdown
```

## Isolation

Each task gets a temporary workspace. `local_fixture` tasks are copied into that
workspace; built-in fixtures are synthesized from the suite metadata. `git_clone`
tasks are cloned and checked out at their pinned commit. Tanya initializes a git
baseline before the task runs so the result can include a final diff.

## Resource Caps

The runner uses env-compatible caps:

- `TANYA_EVAL_TASK_TIMEOUT_MS` / `TANIA_EVAL_TASK_TIMEOUT_MS`, default `600000`.
- `TANYA_EVAL_TASK_TOKEN_CAP` / `TANIA_EVAL_TASK_TOKEN_CAP`, default `500000`.
- `TANYA_EVAL_PARALLEL` / `TANIA_EVAL_PARALLEL`, default `4`.

Execution is conservative and deterministic by default. The current runner keeps
tasks sequential while preserving the `--parallel` surface for CI tuning after
provider rate limits are observed.

## Suites

- `tanya-native`: fast verifier-stress suite for nightly CI.
- `swe-bench-lite`: pinned SWE-bench-Lite adapter.
- `cosmohq`: sanitized app-creator fixtures.
- `eco-30`: token-economy suite with cost-per-task gates.
- `verifier-self-test`: known-correct and known-incorrect verifier outputs.

## Cost Regression Gate

`tanya eval compare` fails when verdicts regress, new errors appear, new
timeouts appear, or cost increases by at least the configured threshold:

```bash
tanya eval compare baseline.json new.json --cost-regression-threshold 0.20
```
