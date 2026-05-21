---
slug: lang/go
title: Go Language
loadWhen:
  - kind: workspace.has
    path: go.mod
sizeTarget: 500
priority: 5
---
# Go Language
## When this applies
Use this for any Go module, including reference services, and generated app backends.
## Core rules
- Keep entrypoint glue in `cmd/<name>/main.go`. Put private implementation in `internal/` and shared embedded packages in `pkg/`.
- Never put handlers, SQL, business rules, or long setup logic in `main.go`.
- Wrap errors with context using `%w`. Test boundaries with `errors.Is` and `errors.As`. Never swallow errors.
- Every function that performs I/O takes `context.Context` as the first argument.
- Use `slog` with a JSON handler and `slog.SetDefault`. Log production paths at Info, Warn, or Error only.
- Every goroutine has an exit condition tied to context, server shutdown, or an errgroup. Do not launch untracked `go func()`.
- Use `signal.NotifyContext`, `http.Server.Shutdown`, a 10s shutdown deadline, and `ReadHeaderTimeout`.
## Common pitfalls
- MAIN-GROWTH: Move logic out of `cmd/` before it becomes untestable.
- LOST-CANCEL: No database, HTTP, Redis, queue, or filesystem I/O without context.
- FIRE-AND-FORGET: Untracked goroutines leak across shutdown and tests.
## House style
Reference services can be standalone binaries or embedded packages; host services may embed packages in-process and share the same pool/auth boundaries.
## Verification commands
- `go test ./... -race -count=1`
- `rg -n "signal.NotifyContext|Shutdown\\(|ReadHeaderTimeout|slog.SetDefault" cmd internal pkg`
- `rg -n "go func\\(" cmd internal pkg` and verify each match has a shutdown path.
## Canonical sources
- `~/workspaces/reference-chat/api/cmd/cosmochat/main.go`
- `~/workspaces/reference-platform-v3/api/cmd/service/main.go`
- `~/workspaces/reference-appgen/api/cmd/server/main.go`
