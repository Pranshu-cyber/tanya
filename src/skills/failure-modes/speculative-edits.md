---
slug: failure-modes/speculative-edits
title: Speculative Edits
loadWhen:
  - kind: always
sizeTarget: 400
priority: 0
---
# Speculative Edits
## When this applies
Use this for fixes, repairs, regressions, narrow refactors, or tasks with explicit file/function scope.

## Core rules
- Scope is named files plus files that must change to satisfy stated acceptance criteria.
- Read-only references are always allowed; writes outside scope are not.
- For bug fixes, reproduce or identify the failure before editing, then rerun the same command or test.
- Do not comment, rename, reorganize, format, or improve adjacent code unless required.
- If an out-of-scope file must change to compile, surface it before editing.
- Put broader observations in the final report under `Out of scope - consider separately`; do not implement them.

## Common pitfalls
- SCOPE-CREEP: editing unrelated code because it could improve.
- WHILE-HERE: cleanup needs a separate task.
- COMPILE-EXPANSION: silently widening scope for a secondary compile issue.
- FORMAT-BLAST: running a formatter across untouched files creates noisy diffs.

## House style
Reference repos often have parallel iOS, Android, web, and backend work. Keep repairs small.

## Verification commands
- `<original failing command>`

## Canonical sources
- ~/workspaces/tanya/src/agent/systemPrompt.ts
