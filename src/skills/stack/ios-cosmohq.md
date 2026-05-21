---
slug: stack/ios-cosmohq
title: iOS/macOS Stack
loadWhen:
  - kind: workspace.has
    path: Package.swift
  - kind: workspace.hasGlob
    glob: "**/*.xcodeproj"
  - kind: hint.stack
    value: ios-cosmohq
  - kind: hint.stack
    value: ios
  - kind: hint.stack
    value: macos
sizeTarget: 700
priority: 3
---

# iOS/macOS Stack
## When this applies
Use this when a workspace or hint identifies a Apple app.

## Core rules
- Follow folders: `App/`, `Configuration/`, `Models/`, `Services/`, `Features/<Domain>/`, `Components/`, `DesignSystem/`, `Utilities/`.
- Keep ViewModels inside `Features/<Domain>/` or a consistent `ViewModels/` folder.
- Preserve launch order: Splash, Onboarding, Premium gate, Root content.
- Splash uses runtime `Image("SplashIcon")` from `SplashIcon.imageset`. Never use `Image("AppIcon")`.
- `BrandedComponents.swift` provides `PrimaryCTAButton`, `BrandedHeroCard`, `StatTile`, `BrandedListRow`, `BrandedEmptyState`, `BrandedLoadingShimmer`, `BrandedTopBar`.
- Use `Theme.primary`, `Theme.bodySemibold`, and tokens. Do not inline hex colors or `Font` literals in feature views.
- Networking uses `APIClient.shared`, URLSession, certificate validation, localized `APIError`, refresh coalescing, 30-second `loginGracePeriod`, 180-second long uploads, and `Retry-After`.
- RevenueCat is primary for payments; raw StoreKit 2 is fallback only.
- If social sign-in exists, Apple Sign-In is mandatory. Google Sign-In uses `GIDSignIn` via SPM.
- Tokens live in Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Never use UserDefaults for tokens.
- Use `debugLog(.domain, emoji: marker, ...)`; no `print()`.

## Common pitfalls
- APPICON-SPLASH: `Image("AppIcon")` can render blank or wrong at runtime.
- INLINE-COLOR: feature-level hex colors break dark mode and branded builds.
- MISSING-APPLE-SIGNIN: Google or Facebook sign-in without Apple Sign-In fails App Review.

## House style
This pack orchestrates `lang/swift`, `framework/swiftui`, `framework/swiftdata`, `framework/revenuecat-ios`, auth, splash, and branded primitives. Reference sibling packs for detail.

## Verification commands
- `rg -n "SplashIcon|Image\\(\"AppIcon\"\\)|BrandedComponents|PrimaryCTAButton|Theme\\." .`
- `rg -n "APIClient\\.shared|CertificatePinningDelegate|loginGracePeriod|Retry-After|longRunningRequestTimeout" .`
- `rg -n "GIDSignIn|SignInWithApple|kSecAttrAccessible|print\\(" .`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/app/Services/APIClient.swift`
- `~/workspaces/reference-apps/finance-sample/app/Services/SubscriptionManager.swift`
