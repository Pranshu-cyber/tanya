---
slug: domain/splash-icon
title: Splash and Icon Assets
loadWhen:
  - kind: hint.framework
    value: splash
  - kind: hint.framework
    value: splash-icon
  - kind: hint.framework
    value: icon
sizeTarget: 500
priority: 7
---

# Splash and Icon Assets

## When this applies
Use this for Apple app icons, runtime splash screens, Android launcher icons, and AndroidX SplashScreen setup.

## Core rules
- iOS `AppIcon.appiconset` contains every required iPhone, iPad, marketing, and mac slot.
- Source iOS icon PNGs have no alpha channel and no pre-rounded corners.
- Runtime splash uses `Image("SplashIcon")` from `SplashIcon.imageset`, never `Image("AppIcon")`.
- LaunchScreen is only the instant launch frame; branded splash is a SwiftUI view after launch.
- Android launcher icons live in `res/mipmap-*` plus adaptive icon XML.
- Android uses a two-layer splash: native `Theme.SplashScreen` and Compose runtime splash after `installSplashScreen()`.
- reference default: reference `@mipmap/ic_launcher_foreground` when splash and launcher visuals match.
- Use `@drawable/<name>` only when splash and launcher visuals differ.
- Use `androidx.core:core-splashscreen:1.0.1` for back-compat.

## Common pitfalls
- Alpha PNG: Apple rejects source icons with transparency.
- AppIcon at runtime: asset catalogs do not expose AppIcon for UI.
- Mixed variants: a theme pointing at one resource family while only the other exists breaks runtime splash.

## House style
Reference Android apps reuses the launcher foreground. Use a drawable only when the splash intentionally diverges.

## Verification commands
- `find . -path "*AppIcon.appiconset*" -o -path "*SplashIcon.imageset*"`
- `rg -n "Image\\(\"SplashIcon\"\\)|Image\\(\"AppIcon\"\\)" .`
- `rg -n "installSplashScreen|windowSplashScreenAnimatedIcon|Theme\\.SplashScreen" app src .`

## Canonical sources
- ~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/res/values/themes.xml
- ~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/MainActivity.kt
