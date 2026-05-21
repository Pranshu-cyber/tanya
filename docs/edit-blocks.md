# Edit Blocks

`edit_block` applies a bounded search/replace block without falling back to a
full-file rewrite. It is intended for cheap-provider near misses where the model
can name the intended region but exact context has drifted.

## Tool Shape

```json
{
  "path": "src/example.ts",
  "search": "const state = \"pending\";",
  "replace": "const state = \"complete\";",
  "expectedCount": 1,
  "matchPolicy": "exact"
}
```

Fields:

- `path`: workspace-relative text file path.
- `search`: the exact block to find.
- `replace`: the replacement block.
- `expectedCount`: expected number of replacements. Defaults to `1`.
- `matchPolicy`: `exact` or `fuzzy`. Defaults to `exact`.

The tool rejects missing fields, no-op replacements, paths outside the
workspace, and binary file targets such as images, archives, fonts, and shared
libraries.

## Exact Policy

Exact mode scans for the literal `search` block and enforces `expectedCount`.

Failure is closed and structured:

- `no_match`: no occurrence found.
- `too_many_matches`: more than one candidate when one was expected.
- `count_mismatch`: occurrences did not equal `expectedCount`.

On success, the tool returns a summary, changed file list, before/after hashes,
and a unified diff. The verifier sees the full result because `edit_block` is
registered with `keepFullForVerifier: true`.

## Fuzzy Policy

Fuzzy mode is opt-in and permission-gated. A call with
`"matchPolicy": "fuzzy"` requires an explicit M3 permission allow rule, for
example:

```json
{
  "version": 1,
  "mode": "default",
  "alwaysAllow": ["edit_block:.*\"matchPolicy\":\"fuzzy\".*"]
}
```

Recovery order:

1. Whitespace-normalized match: collapses whitespace in the file and `search`.
   Exactly one match is required.
2. Nearby-context match: uses the first and last three nonblank search lines as
   anchors, requires the candidate line distance to be within one line, then
   computes a Levenshtein ratio.
3. Fail closed for no match, multiple candidates, out-of-order anchors, or
   confidence below `0.95`.

The `0.95` threshold is deliberately high: it tolerates whitespace drift and a
small shifted-context typo, but rejects broad semantic guesses. If a model needs
more freedom, it must re-read the file and emit a closer block.

## Audit And Repair

Fuzzy successes emit candidate metadata in the audit log: recovery tier,
confidence, and a short candidate excerpt. This makes post-hoc review possible
without trusting the model's claim about what changed.

Failed edit blocks add a repair hint to the tool result:

```text
consider re-reading the file and emitting a closer search block
```

When a below-threshold fuzzy candidate exists, the hint includes the closest
candidate excerpt so the next turn can retry with tighter context.

## Verifier Model

`edit_block` is only a file-mutating tool. It does not mark the task complete and
does not bypass final-state checks. The final verifier still reads changed files,
tool results, and archives independently. Edit-block success is not verifier
success.
