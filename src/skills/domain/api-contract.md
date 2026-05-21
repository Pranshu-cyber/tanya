---
slug: domain/api-contract
title: API Contract Mirror
loadWhen:
  - kind: hint.framework
    value: api-contract
  - kind: hint.framework
    value: openapi
  - kind: hint.framework
    value: api-features
sizeTarget: 500
priority: 7
---

# API Contract Mirror

## When this applies
Use this when backend routes, mobile clients, web clients, or generated API contracts change.

## Core rules
- Treat `brand/api_features.md` as canonical when it exists.
- Backend `API_FEATURES.md` or OpenAPI mirrors the brand contract route-for-route.
- Do not invent the brand contract if absent; use local backend `API_FEATURES.md` as fallback.
- Every route declares or inherits an auth posture.
- Owner-only routes must scope queries by authenticated `userId` or `workspaceId`.
- Add routes in the contract first, then backend, then clients.
- Huma target backends publish `/api/openapi.json` from struct tags.
- House-style backends maintain `API_FEATURES.md` by hand.
- Clients consume the contract, not route-handler source, when a contract exists.

## Common pitfalls
- Client-first route: mobile code silently drifts from backend reality.
- Missing auth posture: default to authenticated-read, then relax by operator review.
- Owner-only leak: middleware is not enough without scoped queries.

## House style
Reference review code compares backend API_FEATURES against brand api_features and reports route drift as a failure.

## Verification commands
- `test -f ../brand/api_features.md || test -f brand/api_features.md || test -f API_FEATURES.md`
- `rg -n "auth-posture|owner-only|authenticated|public-read" .`
- `rg -n "openapi\\.json|API_FEATURES|brand/api_features" .`

## Canonical sources
- ~/workspaces/reference-platform/src/lib/backendArtifactMaterializer.ts
- ~/workspaces/reference-platform/src/lib/cosmoChat/codingRunReview.ts
- ~/workspaces/reference-platform/src/lib/codingAgentPromptBuilder.ts
