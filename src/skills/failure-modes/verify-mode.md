---
slug: failure-modes/verify-mode
title: Verify Mode
loadWhen:
  - kind: always
sizeTarget: 400
priority: 0
---
# Verify Mode
## When this applies
Use this when the task asks to verify, check, confirm, validate, or prove stated criteria.

## Core rules
- Verification checks outcomes, not intent. Run the command that proves each criterion when one exists.
- Output a table with columns `Criterion | Verification command | Outcome (PASS / FAIL / UNTESTABLE)`.
- Include the exact command and output excerpt, capped at 10 lines per criterion.
- Mark `PASS` only when output proves the criterion. Mark `FAIL` when output disproves it.
- If no safe command exists, mark `UNTESTABLE` and explain why.
- Distinguish compile-time (build/typecheck), runtime (tests), and behavioral (manual, device, integration).

## Common pitfalls
- VAGUE-CRITERIA: "looks right", "seems to work", and "expected to pass" are invalid.
- PARROT: repeating the requirement as PASS without command output is invalid.
- INSPECTION-PASS: code reading is not enough when a command exists.
- MISSING-OUTPUT: a command name without output is not evidence.

## House style
Reference verification favors direct build, test, Gradle, xcodebuild, and grep checks.

## Verification commands
- `rg -n "likely|should be|expected to|looks right|seems to work" <output>`

## Canonical sources
- ~/workspaces/tanya/src/agent/systemPrompt.ts
