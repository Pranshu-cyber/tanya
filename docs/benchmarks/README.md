# Benchmarks

This directory stores public Tanya eval snapshots.

- `tanya-native-latest.json` tracks the fast verifier-stress suite used by
  nightly CI.
- `swe-bench-lite-latest.json` tracks the operator-triggered SWE-bench-Lite
  snapshot.
- `eco-30-latest.json` tracks the token-economy suite with pass rate and
  `$`/task metrics by provider tier.
- `verifier-self-test` is not a public scoreboard target; it is the moat
  regression suite that asserts known verifier classifications.

Nightly CI uploads its raw `EvalResult` as an artifact and compares it against
the checked-in Tanya-native snapshot. Scoreboard updates should land as normal
PRs so benchmark changes are reviewable.

The full SWE-bench run is intentionally operator-triggered. It is expected to
cost roughly `$300` on a frontier model and should not run on every PR.
