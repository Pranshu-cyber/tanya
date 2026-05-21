---
slug: domain/sign-in-apple
title: Sign in with Apple
loadWhen:
  - kind: hint.framework
    value: sign-in-apple
  - kind: hint.framework
    value: apple-sign-in
sizeTarget: 500
priority: 7
---

# Sign in with Apple

## When this applies
Use this when adding Apple identity to iOS, macOS, Android web-flow auth, or the Go auth backend.

## Core rules
- iOS and macOS import `AuthenticationServices`.
- Use `ASAuthorizationAppleIDProvider().createRequest()` and request `.fullName` and `.email`.
- Render the system `SignInWithAppleButton` or `ASAuthorizationAppleIDButton`; never redraw the button.
- On completion, extract `identityToken`, stable `user`, `fullName`, and first-sign-in-only `email`.
- Persist the first-sign-in name/email immediately because Apple may not return them again.
- POST `identityToken`, stable user ID, and captured profile fields to `/auth/apple`.
- Android uses OAuth web flow with Apple authorize, `response_type=code id_token`, and `response_mode=form_post`.
- Backend verifies Apple JWKS, caches keys for 1h, validates issuer, audience, expiry, and nonce when sent.
- Account-link by verified email only.
- Apple Sign-In is mandatory when any social provider exists.

## Common pitfalls
- Custom button: App Review flags non-system Apple sign-in visuals.
- Lost email: Apple email may appear only on the first authorization.
- Missing Apple option: apps with Google sign-in but no Apple sign-in are rejected.

## House style
Reference apps send the provider token through the same API client and session store as email auth.

## Verification commands
- `rg -n "AuthenticationServices|SignInWithAppleButton|ASAuthorizationAppleID" .`
- `rg -n "/auth/apple|appleid.apple.com|apple-app-site-association" .`
- `rg -n "jwk|JWKS|apple.*keys|identityToken" .`

## Canonical sources
- ~/workspaces/reference-apps/finance-sample/app/Features/Auth/AuthView.swift
- ~/workspaces/reference-chat/api/pkg/auth/jwe.go
