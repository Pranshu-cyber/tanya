---
slug: platform-ops/apple-signing
title: Apple Signing and Notarization
loadWhen:
  - kind: hint.framework
    value: apple-signing
sizeTarget: 500
priority: 9
---

# Apple Signing and Notarization

## When this applies
Use this for macOS direct distribution, notarization, Developer ID signing, or App Store signing checks.

## Core rules
- Apple Developer Program enrollment is required for signing, notarization, StoreKit, and store distribution.
- Use Developer ID Application certificates for outside-Mac-App-Store apps.
- Sign macOS binaries with hardened runtime, timestamp, and minimal entitlements.
- Submit notarization with `xcrun notarytool submit ... --wait`.
- Use an app-specific password for notarytool, never the Apple ID password.
- Staple successful notarization tickets with `xcrun stapler staple`.
- Verify with `xcrun stapler validate` and `spctl --assess --type execute --verbose`.
- Keep entitlements minimal; do not request sandbox or file access permissions unless the app uses them.

## Common pitfalls
- No hardened runtime: notarization fails.
- No timestamp: signatures age badly and verification becomes brittle.
- Entitlement sprawl: unused entitlements increase review and notarization risk.
- Pending spam: do not submit repeatedly while a notary request is still pending.

## House style
Mac artifacts document sandbox entitlement choices. Release checks require both notarization evidence and Gatekeeper acceptance before distribution.

## Verification commands
- `security find-identity -v -p codesigning`
- `rg -n "com.apple.security|CODE_SIGN|DEVELOPMENT_TEAM" .`
- `xcrun stapler validate <bundle.app> && spctl --assess --type execute --verbose <bundle.app>`

## Canonical sources
- ~/workspaces/reference-platform/artifacts/macos/MacAppSetup.swift
- ~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00011_backfill_verify_prompts.sql
