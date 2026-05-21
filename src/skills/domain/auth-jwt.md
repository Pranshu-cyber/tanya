---
slug: domain/auth-jwt
title: JWT Auth Contract
loadWhen:
  - kind: hint.framework
    value: auth
  - kind: hint.framework
    value: auth-jwt
sizeTarget: 500
priority: 7
---

# JWT Auth Contract

## When this applies
Use this whenever a backend, iOS app, or Android app touches login, token refresh, session persistence, or authenticated API calls.

## Core rules
- Issue 15-minute HS256 access tokens signed with `JWT_ACCESS_SECRET`.
- Include `userId`, `workspaceId`, `email`, `exp`, and `iat` in the access token.
- Issue 30-day refresh tokens, hash them at rest with SHA-256, and rotate on every refresh.
- Mark old refresh tokens revoked. Never accept the same refresh token twice.
- Store tokens in iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- Store Android tokens in `EncryptedSharedPreferences`; never use plain SharedPreferences.
- Keep the 30s login grace window on iOS and Android so first-login refresh failures do not log out users.
- Coalesce concurrent refreshes: Swift continuations on iOS, synchronized `isRefreshing` on Android.
- Backend middleware accepts NextAuth JWE or `X-Service-Token`; do not split auth stacks.

## Common pitfalls
- DB access tokens: storing short-lived access tokens defeats their purpose.
- Refresh replay: accepting a rotated refresh token is an account-takeover bug.
- Grace removal: slow first refresh after login causes false logout.

## House style
Clients mirror the 30s grace rule even though each platform implements refresh coalescing differently.

## Verification commands
- `rg -n "JWT_ACCESS_SECRET|sha256|revoked|refresh" .`
- `rg -n "loginGracePeriod|LOGIN_GRACE_PERIOD_MS|isRefreshing|refreshContinuations" .`
- `rg -n "AfterFirstUnlockThisDeviceOnly|EncryptedSharedPreferences" .`

## Canonical sources
- ~/workspaces/reference-chat/api/pkg/auth/jwe.go
- ~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/data/remote/TokenRefreshAuthenticator.kt
