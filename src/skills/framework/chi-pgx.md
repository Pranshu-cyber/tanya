---
slug: framework/chi-pgx
title: chi + pgx House Style
loadWhen:
  - kind: hint.framework
    value: chi-pgx
  - kind: hint.framework
    value: chi
  - kind: hint.framework
    value: pgx
sizeTarget: 700
priority: 5
---
# chi + pgx House Style
## When this applies
Use this for platform services and repos with `pkg/*/migrations/` plus `Module.Attach`.
## Core rules
- Use chi v5 middleware order: `RequestID`, `RealIP`, `Logger`, `Recoverer`. Do not add a global timeout; streaming endpoints are long-lived.
- Handlers are `func XHandler(d XDeps) http.HandlerFunc`. Deps structs hold stores, `*pgxpool.Pool`, validators, buses, or service clients.
- Read path params with `chi.URLParam`. Extract session with `auth.FromContext(r.Context())`; return 401 when it is missing.
- Responses go through `writeJSON(w, status, payload)` or `writeJSONError(w, status, msg)` only.
- Use hand-written `const` SQL in store methods. Do not introduce GORM or sqlc in house-style services.
- IDs use `uuid.NewString()` through `newID(prefix)` with table-specific prefixes.
- Every tenant-owned query is scoped by `workspace_id`. Every soft-deleted table read filters `deleted_at IS NULL`.
- Store methods use a `Querier` interface compatible with `*pgxpool.Pool` and `pgx.Tx`.
- Build pools with `pgxpool.NewWithConfig`; derive pool config from env.
## Common pitfalls
- TIMEOUT-BREAKS-STREAMS: Per-handler timeouts are allowed; root middleware timeout is not.
- TENANT-LEAK: Missing `workspace_id` is a security defect.
- HARD-DELETE: Do not bypass `deleted_at IS NULL`.
- STYLE-MIX: Huma/sqlc belongs to generated target backends, not house maintenance services.
## House style
Reference services use maintenance-default chi/pgx patterns. Embedded modules attach to the host router and share auth/pool dependencies.
## Verification commands
- `rg -n "middleware\\.(RequestID|RealIP|Logger|Recoverer)" internal pkg cmd`
- `rg -n "writeJSON|writeJSONError|chi.URLParam|auth.FromContext" internal pkg`
- `rg -n "workspace_id|deleted_at IS NULL|newID\\(" internal pkg`
- `rg -n "gorm|sqlc" internal pkg` should be empty for house-style paths.
## Canonical sources
- `~/workspaces/reference-chat/api/internal/http/router.go`
- `~/workspaces/reference-chat/api/pkg/store/store.go`
- `~/workspaces/reference-platform-v3/api/internal/http/router.go`
