# Add Service Token Auth Handler

## Workspace
Go backend: cosmochat/api service-token auth package.

## Intent
Implementar

## Goal
Add a handler that requires a service-token-authenticated caller. Reject service tokens with `IsService(s)` if the route is human-only.

## Constraints
- Use the existing `auth.FromContext` session model.
- Preserve constant-time HMAC verification.
- Do not compare signatures with string equality.
