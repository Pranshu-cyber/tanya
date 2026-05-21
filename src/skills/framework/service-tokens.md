---
slug: framework/service-tokens
title: Service Tokens and NextAuth JWE
loadWhen:
  - kind: workspace.has
    path: go.mod
  - kind: hint.framework
    value: service-tokens
  - kind: hint.framework
    value: service-token
sizeTarget: 700
priority: 5
---
# Service Tokens and NextAuth JWE
## When this applies
Use this for Go auth middleware, cross-service calls, embedded services, and service-only endpoints.
## Core rules
- Two auth schemes coexist: NextAuth JWE session cookies and HMAC-SHA256 service tokens.
- Service tokens travel in the `X-Service-Token` request header.
- Token format is `{workspaceId}.{service}.{hexsig}`.
- Sign HMAC-SHA256 over `{workspaceId}.{service}` with `NEXTAUTH_SECRET`.
- Verify signatures with `hmac.Equal`. Never compare token bytes with `==`.
- A valid service token creates a synthetic session: `UserID = "service:<service>"`, service email/name, claimed workspace ID, and long expiry.
- Use `IsService(s)` to reject service callers from human-only handlers or to permit service-only endpoints.
- Rotate service tokens by rotating `NEXTAUTH_SECRET` and reissuing tokens. There is no per-token expiry beyond the secret.
- `auth.Middleware(secret string, devFallback bool)` checks service token first, then NextAuth cookie, then dev fallback only when enabled.
- `devFallback` is false in production.
## Common pitfalls
- TIMING-LEAK: Direct signature equality is forbidden.
- UNSIGNED-WORKSPACE: Never trust workspace headers outside the signed token body.
- DEV-AUTH-PROD: Production must not accept fallback sessions.
## House style
Reference services share this auth package so embedded modules and host routes agree on session shape.
## Verification commands
- `rg -n "X-Service-Token|ServiceTokenHeader|hmac.Equal|IssueServiceToken|VerifyServiceToken" .`
- `rg -n "service:|IsService|devFallback|Env != \"production\"" .`
## Canonical sources
- `~/workspaces/reference-chat/api/pkg/auth/service_token.go`
- `~/workspaces/reference-chat/api/pkg/auth/jwe.go`
