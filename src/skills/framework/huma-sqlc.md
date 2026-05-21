---
slug: framework/huma-sqlc
title: Huma + sqlc Target Style
loadWhen:
  - kind: hint.stack
    value: backend-go-huma
  - kind: hint.framework
    value: huma-sqlc
  - kind: hint.framework
    value: huma
  - kind: hint.framework
    value: sqlc
sizeTarget: 700
priority: 5
---
# Huma + sqlc Target Style
## When this applies
Use this for greenfield generated Go app backends, workspaces with `internal/store/gen/`, or hint `stack: backend-go-huma`.
## Core rules
- Use layout `cmd/server/main.go`, `internal/handlers/`, `internal/store/gen/`, and `internal/middleware/`.
- Register operations with `huma.Register`. Input and output types are plain Go structs with `json:`, path, query, and validation tags.
- Response bodies live under output `Body`. Return `huma.Error...` values for errors; do not write raw `http.ResponseWriter` paths.
- SQL queries live in `.sql` files under `internal/store/` or the artifact layout's `sql/queries/`. Generated code lives in `internal/store/gen/`.
- Never edit generated sqlc files. After schema or query changes, run `sqlc generate` or `make gen` and commit generated output.
- Keep goose migrations as the runtime schema source. Keep the sqlc schema snapshot in sync with migration tip.
- Auth remains the existing JWE plus service-token middleware; this pack only changes HTTP and data-access shape.
- Publish `/api/openapi.json` at startup. Mobile clients consume operation IDs and response shapes; never rename them casually.
## Common pitfalls
- EMPTY-BODY: Missing output `Body` returns an empty response.
- GENERATED-STUB: Do not fake `internal/store/gen/` for compilation.
- CONTRACT-DRIFT: Migration, schema snapshot, query SQL, generated code, and OpenAPI must move together.
## House style
Use this target style for new app backends. Existing platform services stay chi/pgx unless migration is explicitly requested.
## Verification commands
- `test -d internal/store/gen && test -f sqlc.yaml`
- `rg -n "huma\\.Register|humachi|OpenAPIPath|openapi\\.json" internal cmd`
- `rg -n "internal/store/gen|sqlc generate|make gen" .`
- `rg -n "SELECT .* FROM|INSERT INTO|UPDATE .* SET" internal --glob '*.go'` should not find handler-owned SQL.
## Canonical sources
- `~/workspaces/reference-platform/artifacts/backend-go/ChiHumaSetup.go.md`
- `~/workspaces/reference-platform/artifacts/backend-go/HumaOperationPattern.go.md`
- `~/workspaces/reference-platform/artifacts/backend-go/PgxConn.go.md`
- `~/workspaces/reference-platform/artifacts/backend-go/SqlcSetup.md`
- `~/workspaces/reference-platform/artifacts/backend-go/FolderStructure.md`
