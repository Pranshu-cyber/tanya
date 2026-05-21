# Add House-Style REST Route

## Workspace
Go backend: cosmochat/api house-style chi + pgx service.

## Intent
Implementar

## Goal
Add a GET /v1/items/{id} route to this chi-pgx service. Return the item from the store, or 404 if not found. Scope every store query by workspace_id.

## Constraints
- Use the existing manual handler style.
- Use pgx hand-written SQL in Store methods.
- Do not introduce Huma, sqlc, or GORM.
