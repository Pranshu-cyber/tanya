# Token Economy

Tanya reduces input tokens without hiding important state from the model,
verifier, or audit trail. The goal is the same outcome with fewer tokens,
especially on cheaper providers with smaller or stricter context windows.

## Layers

1. **Lite system prompt** trims prompt sections that are not needed for the
   current turn. It is opt-in until model routing ships:

   ```bash
   TANYA_LITE_PROMPT=1 tanya run "Inspect this bug"
   ```

   The legacy `TANIA_LITE_PROMPT` name is still accepted. Lite mode keeps
   workspace and stack facts, then drops unmatched skill packs, stale
   failure-mode packs, unused artifact indexes, and older history.

2. **System-prompt budget** runs automatically. Tanya caps system-prompt tokens
   to `contextWindow * 0.25` by default, using the active provider adapter's
   context window. Configure the ratio with:

   ```bash
   TANYA_PROMPT_BUDGET_RATIO=0.20 tanya run "Work in a small-window model"
   ```

   Drop priority is deterministic: failure-mode packs, artifact index, domain
   packs, language packs, framework packs. Workspace and stack facts are never
   dropped. A `prompt_budget_exceeded` event records what was removed.

3. **Tool-result truncation** keeps large outputs from dominating the next
   prompt. Tool results over 2 KB are shown as the first 1 KB, the last 500
   bytes, and a visible marker:

   ```text
   <truncated 49231 chars; ask for more (tool_call_id=call_123; you have 3 expand_result calls left this turn)>
   ```

   The full output is cached under
   `.tania/cache/results/<runId>/<toolCallId>.txt`. The model can recover it
   with:

   ```json
   {"tool_call_id":"call_123"}
   ```

   or a byte range:

   ```json
   {"tool_call_id":"call_123","range":{"startByte":12000,"endByte":16000}}
   ```

4. **File-read deduplication** tracks reads by `path + size + mtime` inside a
   run. Re-reading an unchanged file returns:

   ```text
   [file unchanged since turn N, see tool_call <id> for content]
   ```

   `read_file { "path": "...", "force": true }` bypasses the marker and resets
   the dedup entry. Dedup state is cleared when compaction fires, because the
   original content may have left live history.

5. **Budget reporting** uses persisted run logs to show where tokens and cost
   went:

   ```text
   /budget
   /budget --json
   /budget --enforce --max-usd 0.50
   ```

   `--enforce` writes a session-scoped spend rule to `.tania/permissions.json`
   through the M3 permission engine.

## Tool Definition Knobs

Tools can tune truncation behavior in their `ToolDefinition`:

- `truncateLargeResults: false` disables catch-all truncation. `read_file`
  uses this because it already has windowed reads.
- `keepFullForVerifier: true` keeps verifier-facing output lossless while the
  model receives the truncated view. This is used for shell/write tools whose
  full output may contain verification evidence.

## Verification

M5.5 captured a pre-change golden baseline and reran it after token-economy
features shipped. Result: 27/27 golden profiles passed with 0 verifier-verdict
drift.

The synthetic 10-task token-economy bench measured 341,670 full input tokens
versus 76,990 optimized input tokens, a 77.5% reduction with 0% verifier
regression.
