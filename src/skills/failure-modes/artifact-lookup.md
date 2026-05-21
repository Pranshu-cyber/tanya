---
slug: failure-modes/artifact-lookup
title: Artifact Lookup
loadWhen:
  - kind: always
sizeTarget: 400
priority: 0
---
# Artifact Lookup
## When this applies
Use this before creating common app, backend, mobile, landing, auth, billing, onboarding, splash, icon, deploy, or store files.

## Core rules
- Read the Reference artifact index before writing reusable modules.
- Lookup order is artifact index, filesystem probe, then create. Do not create a file if a probe finds the canonical path.
- If a match is at least 80 percent of the need, copy it and adapt only required differences.
- Treat other packs' Canonical sources as authoritative unless the task asks to replace them.
- If no artifact exists, use the active stack pack folder layout.
- Final reports state `Artifact reused: <artifact> -> <target>` or `Artifact reused: none`.

## Common pitfalls
- INVENTED: scaffolding from memory when a catalog artifact exists.
- STALE-INDEX: an index read at session start may miss recent edits; re-probe paths.
- WRONG-HOME: generic folders conflict with stack pack layout.

## House style
Reference apps favor artifacts for API clients, app databases, subscriptions, auth, payments, components, and launch assets.

## Verification commands
- `rg -n "Artifact reused:" <report>`

## Canonical sources
- ~/workspaces/reference-platform/artifacts/description.md
