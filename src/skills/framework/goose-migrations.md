---
slug: framework/goose-migrations
title: Goose Migrations
loadWhen:
  - kind: workspace.has
    path: go.mod
  - kind: hint.framework
    value: goose
  - kind: hint.framework
    value: goose-migrations
sizeTarget: 700
priority: 5
---
# Goose Migrations
## When this applies
Use this for schema changes in Go house-style services, embedded modules, and Huma/sqlc target backends.
## Core rules
- Use `github.com/pressly/goose/v3`.
- Each embedded module sets its own tracking table with `goose.SetTableName("goose_db_version_<pkg>")` before `goose.Up`.
- Package migrations live in `pkg/<name>/migrations/` and are embedded with `//go:embed migrations/*.sql`.
- Runtime code uses embedded migrations. Filesystem paths are development overrides only.
- Name package migrations `00001_name.sql` with 5-digit zero padding.
- Always include `-- +goose Up` and `-- +goose Down`. Use `StatementBegin` and `StatementEnd` around multi-statement blocks.
- `Module.Migrate(ctx)` is the umbrella method. Hosts call it at startup before starting the HTTP server.
- Never run `goose reset` or `goose down` in production code paths.
## Common pitfalls
- SHARED-VERSION-TABLE: Default `goose_db_version` collides when multiple embedded modules share one database.
- FILESYSTEM-RUNTIME: Binaries must not require SQL files beside the executable.
- NO-DOWN-MIGRATION: Every migration needs a reviewed rollback path even if it is conservative.
## House style
Reference packages can coexist inside host binaries by using package-specific goose tables.
## Verification commands
- `rg -n "goose.SetTableName|goose_db_version_" .`
- `rg -n "//go:embed migrations|embed.FS" pkg internal`
- `rg -n "^-- \\+goose (Up|Down|StatementBegin|StatementEnd)" migrations pkg`
## Canonical sources
- `~/workspaces/reference-chat/api/pkg/cosmochat/migrate.go`
- `~/workspaces/reference-chat/api/pkg/cosmochat/migrations/00001_init_schema.sql`
- `~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00001_create_reference-appgen_schema.sql`
