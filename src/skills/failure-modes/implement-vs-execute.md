---
slug: failure-modes/implement-vs-execute
title: Implement Versus Execute
loadWhen:
  - kind: always
sizeTarget: 400
priority: 0
---
# Implement Versus Execute
## When this applies
Use this when a task mixes coding, shell commands, plans, manual operations, secrets, uploads, or deploy language.

## Core rules
- Classify every step as `CODE CHANGE`, `SHELL INVOCATION`, or `MANUAL OPERATOR STEP`.
- Implement mode is code-first: inspect context, write the change, then verify build/tests. Explain after code.
- Execute mode follows the given plan. Do not skip, reorder, or substitute steps without surfacing the deviation first.
- Never invent credentials, signing certs, DNS values, store listings, product IDs, or cloud resources.
- Do not run upload, deploy, publish, billing, or store commands unless explicitly asked.
- If a required secret is absent, stop and report the missing input instead of substituting a fake value.

## Common pitfalls
- ANALYSIS-PARALYSIS: re-explaining requirements instead of editing.
- PLAN-DRIFT: doing a different approach without saying so.
- FAKE-SECRET: placeholder credentials create broken config.
- SILENT-MANUAL: human-only steps must be named, not simulated.

## House style
Reference repos separate local edits from operator-controlled release, signing, DNS, stores, and payments.

## Verification commands
- `git diff --name-only`

## Canonical sources
- ~/workspaces/tanya/src/agent/systemPrompt.ts
