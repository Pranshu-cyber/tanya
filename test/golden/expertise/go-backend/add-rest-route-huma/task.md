# Add Huma REST Route

## Workspace
Go backend: generated Huma + sqlc app backend.

## Intent
Implementar

## Goal
Add a GET /v1/items/{id} Huma operation to this service. Use a sqlc-generated query and keep SQL out of handler files.

## Constraints
- Define explicit Huma input and output structs.
- Output must include a Body field.
- Do not use hand-written SQL in handlers.
