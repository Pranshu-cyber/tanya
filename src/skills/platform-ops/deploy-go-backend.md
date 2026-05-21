---
slug: platform-ops/deploy-go-backend
title: Go Backend Deployment
loadWhen:
  - kind: hint.framework
    value: deploy-go-backend
sizeTarget: 500
priority: 9
---

# Go Backend Deployment

## When this applies
Use this for deploying generated Go backends, backend release pipelines, migrations, and health checks.

## Core rules
- Primary deployment path is Azure App Service zip deploy.
- Validate `go.mod` exists before treating a folder as a Go backend.
- Cross-compile Linux AMD64 with `GOOS=linux GOARCH=amd64 CGO_ENABLED=0`.
- Build `./cmd/server` to `bin/server` with `-trimpath` and stripped symbols.
- Write `startup.sh` next to the binary; App Service runtime uses it as entrypoint.
- Read env files and extra settings; require `DATABASE_URL`.
- Run `goose up` against production before publishing. Failed migration aborts deploy.
- Push App Service settings, zip `{bin/, migrations/, startup.sh}`, then run `az webapp deployment source config-zip`.
- Configure App Service runtime `GO|<version>` once at provisioning, not per deploy.
- Health contract is `/healthz` for liveness and `/readyz` for readiness.
- Distroless Docker is alternate path only when the operator chooses container hosting.

## Common pitfalls
- Publish-before-goose: bad migrations break the live slot.
- macOS binary: missing cross-compile flags fails on App Service.
- Secrets in zip: env vars belong in App Service settings.
- `/health`: generated validators require `/healthz` and `/readyz`.

## House style
`DeployBackendGo` fails closed before publish, uses per-app goose tables, and leaves the previous App Service binary running if migrations fail.

## Verification commands
- `rg -n "GOOS=linux|GOARCH=amd64|CGO_ENABLED=0|config-zip|startup.sh" .`
- `rg -n "goose up|gooseTableFor|DATABASE_URL" .`
- `rg -n "\"/healthz\"|\"/readyz\"" .`

## Canonical sources
- ~/workspaces/reference-appgen/api/pkg/deploy/go_appservice.go
- ~/workspaces/reference-platform-v3/api/internal/http/wizard_coding.go
