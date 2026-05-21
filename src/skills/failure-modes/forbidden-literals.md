---
slug: failure-modes/forbidden-literals
title: Forbidden Literals
loadWhen:
  - kind: always
sizeTarget: 400
priority: 0
---
# Forbidden Literals
## When this applies
Use this for code, config, docs, env examples, credentials, pins, OAuth IDs, payment keys, and deploy settings.

## Core rules
- Block strings a human must replace before code works: `YOUR_WEB_CLIENT_ID_HERE`, any `YOUR_*_HERE`, `__BLOCKER__*`, `MISSING_GOOGLE_CLIENT_ID`, `TODO-REPLACE-WITH-PRODUCTION-PINNED-HASH-*`, `YOUR_API_KEY`, `your-domain.com`, `example@email.com`, `CHANGE_ME`, `TODO: fill this in`, `INSERT_HERE`, and `YOUR_PROJECT_ID`.
- Unknown runtime values use env vars or empty strings, never plausible fake values.
- Unknown hashes or pins are not stubbed. Document the required source in README or env.example.
- Allowed literals are safe defaults: app name, demo copy, colors, or non-secret labels.
- Config docs use comments, not placeholder values. Example: `STRIPE_SECRET_KEY=    # Required: Stripe dashboard -> API keys`.
- Grep output paths before reporting completion.

## Common pitfalls
- FORBIDDEN-LITERALS: fake values look shippable.
- FAKE-CONFIG: placeholders are worse than empty required fields.
- TODO-GATE: credential TODOs are hidden blockers.

## House style
Reference apps use env vars, keychain/encrypted storage, and operator dashboards for secrets.

## Verification commands
- `grep -rn "YOUR_\\|__BLOCKER__\\|MISSING_GOOGLE\\|TODO-REPLACE" <paths>`

## Canonical sources
- ~/workspaces/tanya/src/agent/systemPrompt.ts
