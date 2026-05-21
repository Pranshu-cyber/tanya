---
slug: stack/go-backend-cosmohq
title: Go Backend Stack
loadWhen:
  - kind: workspace.has
    path: go.mod
  - kind: hint.stack
    value: go-backend-cosmohq
  - kind: hint.stack
    value: backend-go-house
  - kind: hint.stack
    value: backend-go-huma
sizeTarget: 700
priority: 3
---
# Go Backend Stack
## When this applies
Use this when a workspace or hint identifies a Go backend.
## Core rules
- Choose the backend branch before editing. Use house style for reference services, and any repo with `pkg/*/migrations/` plus `Module.Attach`.
- Use target Huma/sqlc style for new generated app backends or `stack: backend-go-huma`.
- Ask when signals are ambiguous. Do not mix Huma/sqlc into a house-style service without explicit direction.
- Every store query is scoped by `workspace_id`. Missing workspace scoping is a security defect.
- Every soft-deleted table read includes `deleted_at IS NULL`. User deletion anonymizes email to `deleted-<userId>@<placeholder>.invalid` and clears name/avatar fields.
- Consume reusable services as `pkg/<name>` packages in-process. Do not introduce inter-service HTTP calls inside the same binary.
- Embedded modules expose `Deps`, `Module`, `Migrate`, `Router` or `Attach`, and `Close`; hosts call `Module.Attach(router, authMW)`.
- Shutdown uses `signal.NotifyContext` plus `srv.Shutdown(ctx)` with a 10s deadline. River queues drain before server shutdown returns.
- Never log raw tokens, service-token signatures, refresh tokens, or JWE payloads.
## Common pitfalls
- STYLE-COLLISION: House and target backends have different data-access rules.
- WORKSPACE-LEAK: Auth middleware does not replace scoped SQL.
- STANDALONE-DRIFT: Embedded services share pool/auth; do not add extra ports for same-binary calls.
## House style
Cross-cutting auth comes from `domain/auth-jwt` and `framework/service-tokens`. Migrations come from `framework/goose-migrations`. Base Go behavior follows `lang/go`.
## Verification commands
- `rg -n "Module\\.Attach|func \\(.*\\) Attach|internal/store/gen" .`
- `rg -n "workspace_id|deleted_at IS NULL|deleted-.*@.*\\.invalid" .`
- `rg -n "signal.NotifyContext|Shutdown\\(|ReadHeaderTimeout|river" .`
- `rg -n "token|secret|jwe" .` and inspect logs for raw secret output.
## Canonical sources
- `~/workspaces/reference-chat/api/internal/http/router.go`
- `~/workspaces/reference-chat/api/pkg/store/store.go`
- `~/workspaces/reference-chat/api/pkg/cosmochat/migrate.go`
- `~/workspaces/reference-chat/api/pkg/auth/service_token.go`
- `~/workspaces/reference-chat/api/pkg/auth/jwe.go`
- `~/workspaces/reference-platform/artifacts/backend-go/FolderStructure.md`
