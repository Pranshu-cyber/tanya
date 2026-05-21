---
slug: domain/revenuecat
title: RevenueCat Entitlements
loadWhen:
  - kind: hint.framework
    value: revenuecat
sizeTarget: 500
priority: 6
---

# RevenueCat Entitlements

## When this applies
Use this for cross-platform premium entitlement state, RevenueCat webhooks, backend grants, or mobile subscription parity.

## Core rules
- Keep iOS and Android `SubscriptionManager` semantics aligned around one `isPremium` boolean.
- Clients notify unrelated views when subscription status changes.
- Validate the webhook bearer token before trusting any JSON body.
- Fail closed on missing or wrong webhook auth.
- Process events idempotently using RevenueCat `event.id`, not transaction IDs.
- Handle initial purchase, renewal, cancellation, expiration, uncancellation, and product change.
- Map the configured RevenueCat entitlement to server-side premium state.
- Backend grants can flip client premium state for support, promo, or manual overrides.
- iOS sandbox products must exist in App Store Connect before sandbox purchases work.
- Android RevenueCat linking may wait until the first internal AAB upload.

## Common pitfalls
- Body-first webhook: parsing untrusted JSON before auth is a security bug.
- Transaction idempotency: transaction IDs can rotate across events.
- Parallel engines: do not run raw StoreKit or Play Billing entitlement logic beside RevenueCat.

## House style
Reference source uses a named entitlement, while generated defaults may use `premium`. Treat entitlement ID as app config, not a hardcoded universal.

## Verification commands
- `rg -n "RevenueCat|Purchases|SubscriptionManager|isPremium" .`
- `rg -n "Authorization|Bearer|event\\.id|webhook" .`
- `rg -n "backendPremiumGranted|restorePurchases|awaitRestore" .`

## Canonical sources
- ~/workspaces/reference-apps/finance-sample/app/Services/SubscriptionManager.swift
- ~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/domain/subscription/SubscriptionManager.kt
