---
slug: framework/revenuecat-android
title: RevenueCat Android
loadWhen:
  - kind: hint.framework
    value: revenuecat-android
  - kind: hint.framework
    value: revenuecat
sizeTarget: 700
priority: 5
---

# RevenueCat Android
## When this applies
Use this when Android imports `com.revenuecat.purchases` or adds subscriptions, paywalls, restore, or premium gates.

## Core rules
- Initialize once in `Application.onCreate()` with `Purchases.configure(PurchasesConfiguration.Builder(context, apiKey).build())`.
- Read the key from `BuildConfig.REVENUECAT_API_KEY`; never hardcode SDK keys.
- Do not call configure more than once per process.
- `isPremium` is the single paywall gate. Persist `SubscriptionManager.isPremium` with DataStore or encrypted prefs when needed.
- Publish `subscriptionStatusChanged` with Flow or broadcast; paywall gates observe this source.
- RevenueCat is primary. Direct Google Play Billing is fallback only when RevenueCat is unavailable.
- Do not mix RevenueCat and raw Play Billing in the same build; use a compile-time flag if a fallback build is required.
- Keep backend premium checks before SDK fallback so support grants and cross-platform purchases work.
- Link RevenueCat user identity to backend user ID after login.
- Every paywall exposes Restore Purchases and calls the RevenueCat restore API.

## Common pitfalls
- MULTI-CONFIGURE: second SDK configuration throws or corrupts singleton state.
- PLAY-BILLING-MIX: dual purchase engines create duplicate charges and receipt conflicts.
- UI-ONLY-PREMIUM: a selected plan is not an entitlement.

## House style
Reference apps use injected `SubscriptionManager`, `StateFlow`, backend checks, SDK offerings, purchase, restore, and user linking.

## Verification commands
- `rg -n "REVENUECAT_API_KEY|secretFromLocalOrEnv|revenuecat.purchases" app/build.gradle.kts gradle/libs.versions.toml`
- `rg -n "Purchases\\.configure|PurchasesConfiguration|awaitOfferings|awaitPurchase|awaitRestore|awaitLogIn" app/src/main/java`
- `rg -n "SubscriptionManager\\.isPremium|subscriptionStatusChanged|PremiumStatus" app/src/main/java`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/domain/subscription/SubscriptionManager.kt`
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/build.gradle.kts`
