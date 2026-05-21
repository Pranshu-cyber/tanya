---
slug: domain/sign-in-google
title: Google Sign-In
loadWhen:
  - kind: hint.framework
    value: sign-in-google
  - kind: hint.framework
    value: google-sign-in
sizeTarget: 500
priority: 7
---

# Google Sign-In

## When this applies
Use this when adding Google identity on iOS, Android, NextAuth web, or backend token verification.

## Core rules
- iOS uses GoogleSignIn via SPM and registers the reverse-DNS URL scheme in Info.plist.
- iOS flow calls `GIDSignIn.sharedInstance.signIn(withPresenting:)` and POSTs `idToken` to `/auth/google`.
- Android adds `com.google.android.gms:play-services-auth`.
- Android `default_web_client_id` must be the WEB client ID, not the Android client ID.
- Configure `GoogleSignInOptions` with `requestIdToken(getString(R.string.default_web_client_id))` and `requestEmail()`.
- Launch Android sign-in through an `ActivityResultLauncher`; POST `account.idToken`.
- NextAuth web uses GoogleProvider in `src/auth.ts` with WEB client ID and secret from env.
- Backend verifies Google JWKS, caches 1h, validates issuer, expiry, `email_verified`, and audience.
- Trusted audiences must include every platform client ID.

## Common pitfalls
- Android client ID: device sign-in appears to work, but backend token verification fails.
- Single audience: adding iOS or web later breaks auth for the new platform.
- Client-only trust: backend must verify the id token before creating a session.

## House style
Generated Android prompts copy the WEB client ID into `strings.xml` and fail closed when the credential is missing. Do not ship placeholders.

## Verification commands
- `rg -n "GoogleSignInOptions|default_web_client_id|play-services-auth" app src .`
- `rg -n "GIDSignIn|CFBundleURLTypes|/auth/google" .`
- `rg -n "GoogleProvider|oauth2/v3/certs|email_verified" .`

## Canonical sources
- ~/workspaces/reference-platform/artifacts/ios/GoogleSignInSetup.md
- ~/workspaces/reference-platform/src/lib/seedCodingTemplates.ts
- ~/workspaces/reference-chat/api/pkg/auth/jwe.go
