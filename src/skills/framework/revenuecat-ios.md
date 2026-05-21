---
slug: framework/revenuecat-ios
title: RevenueCat iOS
loadWhen:
  - kind: hint.framework
    value: revenuecat-ios
  - kind: hint.framework
    value: revenuecat
sizeTarget: 700
priority: 5
---

# RevenueCat iOS
## When this applies
Use this when an Apple target imports RevenueCat or the task adds subscriptions, paywalls, offerings, restore, or premium gates.

## Core rules
- `SubscriptionManager` is `@MainActor final class`, conforms to `ObservableObject` and `PurchasesDelegate`, and stays a singleton via `static let shared`.
- `@Published var isPremium: Bool` is the single paywall gate. Persist it in UserDefaults under `SubscriptionManager.isPremium`.
- Post `Notification.Name.subscriptionStatusChanged` whenever premium status changes.
- In `init()`, if command line contains `--uitesting`, set `isPremium = true` and skip RevenueCat. If it contains `--snapshot-scene`, set `isPremium = false`.
- Maintain `backendPremiumGranted`; backend active, trial, or premium status can grant premium before RevenueCat fallback.
- Configure `Purchases.shared.delegate = self` in `SubscriptionManager.init()` so entitlement callbacks are not missed.
- Call `Purchases.configure(withAPIKey:)` once in `App.init()` and pass the same key to `SubscriptionManager.configure(apiKey:)` when that method exists.
- Keep a `.storekit` file in the Xcode project for sandbox testing and keep product IDs aligned with the RevenueCat catalog.
- Every paywall exposes Restore Purchases and calls RevenueCat restore.

## Common pitfalls
- DELEGATE-RACE: assigning the delegate after startup loses status callbacks.
- SANDBOX-GAP: StoreKit config and RevenueCat offerings must share product IDs.
- DOUBLE-ENGINE: raw StoreKit entitlement logic must not run beside RevenueCat.

## House style
Reference apps check backend premium first, links the RevenueCat user after login, skips SDK work for tests/snapshots, and keeps Portuguese paywall error strings.

## Verification commands
- `rg -n "import RevenueCat|Purchases\\.configure|PurchasesDelegate|restorePurchases" .`
- `rg -n "SubscriptionManager\\.isPremium|subscriptionStatusChanged|--uitesting|--snapshot-scene|backendPremiumGranted" .`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/app/Services/SubscriptionManager.swift`
- `~/workspaces/reference-apps/finance-sample/app/finance-sample.premium.storekit`
