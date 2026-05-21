---
slug: domain/deep-links
title: Deep Links
loadWhen:
  - kind: hint.framework
    value: deep-links
  - kind: hint.framework
    value: universal-links
  - kind: hint.framework
    value: app-links
sizeTarget: 500
priority: 7
---

# Deep Links

## When this applies
Use this for iOS Universal Links, custom URL schemes, Android App Links, notification taps, and auth callback routing.

## Core rules
- iOS uses Associated Domains with `applinks:<domain>`.
- Host AASA at `https://<domain>/.well-known/apple-app-site-association` with no `.json` extension.
- Serve AASA as JSON over HTTPS with no redirects and no auth.
- Receive iOS links through SwiftUI `.onOpenURL` and browsing user activities.
- Keep custom URL schemes in `CFBundleURLTypes` as fallback only.
- Android App Links use `VIEW`, `DEFAULT`, `BROWSABLE`, and `android:autoVerify="true"`.
- Host `assetlinks.json` at `/.well-known/assetlinks.json` with package name and signing cert SHA-256.
- Compose Navigation declares `navDeepLink` patterns on destination routes.
- Backend hosts both well-known files without redirects.

## Common pitfalls
- AASA extension: `.json` on the Apple path can fail validation.
- Redirects: Apple and Android silently disable association.
- Missing `applinks:`: entitlements must include the prefix.

## House style
Harden generated prompts to verify entitlements, manifest filters, handlers, and well-known hosting instead of trusting route names.

## Verification commands
- `rg -n "applinks:|apple-app-site-association|CFBundleURLTypes|onOpenURL" .`
- `rg -n "assetlinks\\.json|autoVerify|BROWSABLE|navDeepLink" .`
- `curl -I https://<domain>/.well-known/apple-app-site-association`

## Canonical sources
- ~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00017_harden_deep_links_ios_prompts.sql
- ~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00018_harden_deep_links_android_prompts.sql
