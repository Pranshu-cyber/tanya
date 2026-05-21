---
slug: failure-modes/analyze-mode
title: Analyze Mode
loadWhen:
  - kind: always
sizeTarget: 400
priority: 0
---
# Analyze Mode
## When this applies
Use this for analyze, review, inspect, audit, compare, or feasibility tasks without implementation.

## Core rules
- Analyze/review is read-only. Do not write files, format, install, run side-effecting builds, or commit.
- Run at most five probes: `rg`, `sed`, `ls`, `find`, `git diff --name-only`, `go build -n`, or `xcodebuild -list`.
- Output one table with columns `Criterion | Command | Result`. The command cell contains the exact command.
- If a check needs side effects, mark `DEFER` and state the needed permission, device, service, or credential.
- Stop after the table. Do not add a prose summary, TODO list, recommendations, fix plan, or next steps unless the user explicitly asks.

## Common pitfalls
- ANALYZE-PARROTS-TODO: listing improvements without probes is not analysis.
- PLAN-DRIFT: producing an implementation plan changes the task type.
- HIDDEN-WRITE: build, format, install, or generator commands may modify files.

## House style
Reference reviews prefer files, commands, and observed output over opinion.

## Verification commands
- `git diff --name-only`

## Canonical sources
- ~/workspaces/tanya/src/agent/systemPrompt.ts
