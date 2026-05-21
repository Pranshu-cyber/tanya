---
slug: stack/android-cosmohq
title: Android Stack
loadWhen:
  - kind: workspace.hasGlob
    glob: "**/build.gradle.kts"
  - kind: workspace.hasGlob
    glob: "**/build.gradle"
  - kind: hint.stack
    value: android-cosmohq
  - kind: hint.stack
    value: android
sizeTarget: 700
priority: 3
---

# Android Stack
## When this applies
Use this when a workspace or hint identifies an Android app.

## Core rules
- Build with Kotlin DSL, catalog deps, `compileSdk = 36`, `minSdk = 26`, `targetSdk = 36`, Java 17, Compose plugin, Hilt, and KSP.
- Managed `cosmohq-release-signing.gradle` and `cosmohq-version.gradle` are auto-applied; never edit them.
- Splash is two-layer: native `Theme.SplashScreen`, then `installSplashScreen()` plus Compose runtime splash.
- Preserve launch order: Splash, Onboarding, Premium gate, Root content.
- RevenueCat is primary. Document Google Play Billing if encountered, but do not introduce it.
- Google Sign-In `default_web_client_id` must be the WEB client ID. Apple Sign-In uses OAuth web flow with backend callback; Android has no native Apple SDK.
- Store tokens, session data, and persisted premium gates in encrypted storage or DataStore.
- Use `androidx.biometric` and `BiometricPrompt.PromptInfo` for biometric gating.
- `BrandedComponents.kt` mirrors iOS: `PrimaryCTAButton`, `BrandedHeroCard`, `StatTile`, `BrandedListRow`, `BrandedEmptyState`, `BrandedLoadingShimmer`, `BrandedTopBar`.
- Use `private const val TAG = "CFSYNC"` or a domain equivalent per class. `HttpLoggingInterceptor` is `NONE` in release.

## Common pitfalls
- GOOGLE-CLIENT-ID: Android OAuth client ID is not accepted by backend WEB-client verification.
- SPLASHSCREEN-SINGLE-LAYER: skipping the native layer causes a white flash before Compose.
- PLAIN-PREFS: credentials in unencrypted preferences fail security review.

## House style
This pack orchestrates Kotlin, Compose, Room/Hilt, Retrofit/OkHttp, RevenueCat, auth, splash, and branded primitives.

## Verification commands
- `rg -n "compileSdk = 36|minSdk = 26|targetSdk = 36|JavaVersion.VERSION_17|ksp" app/build.gradle.kts`
- `rg -n "cosmohq-release-signing|cosmohq-version|installSplashScreen|Theme.SplashScreen|EncryptedSharedPreferences|BiometricPrompt" app app/src/main/java`
- `rg -n "default_web_client_id|HttpLoggingInterceptor.Level.NONE|BrandedComponents|PrimaryCTAButton|println\\(" app/src/main/java app/src/main/res`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/build.gradle.kts`
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/di/NetworkModule.kt`
