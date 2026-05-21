# Long sessions

Tanya uses reactive context compaction for long coding sessions, especially with
cheap providers that have smaller or stricter context windows.

## Cascade

1. **Microcompact** folds consecutive assistant tool-call wrappers plus empty or
   no-op tool results into an elided marker. Message order is preserved for
   provider prefix-cache stability.
2. **Snip** removes low-signal history: empty read-only tool results, pure
   assistant tool-call wrappers whose outputs were snipped, and older duplicate
   `read_file` calls for the same path.
3. **Auto-compact** runs only after a typed `ContextWindowExceededError`.
   Tanya forks a summarization call with the same provider/model, replaces older
   turns with `[compaction summary: ...]`, and retries the failing request.
4. **Archive** writes compacted turns before they leave live history.

Archived messages are stored at:

```text
.tanya/runs/<runId>/archive.jsonl
```

Each line records the original role, serialized content, tool name when known,
and estimated token count. The final-state verifier reads archived tool-call
paths back into its scan surface so compacted work remains auditable.

## Limits

Tanya allows at most three auto-compactions per run. The first retry uses normal
aggression, summarizing about half of the compactable history. The second retry
uses heavy aggression, summarizing about three quarters. Past the run cap, Tanya
throws `CompactionExhaustedError`.

User-facing meaning:

```text
Context compaction exhausted after repeated provider context-window failures.
```

When this happens, narrow the prompt, run `/clear` in the REPL, split the task,
or switch to a provider/model with a larger context window.

## Skill packs

System messages, including active skill-pack blocks, are preserved by every
compaction layer. Compaction can summarize old user, assistant, and tool turns,
but it must not remove the active instruction surface.
