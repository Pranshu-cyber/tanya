---
slug: framework/storekit2
title: StoreKit 2
loadWhen:
  - kind: hint.framework
    value: storekit2
  - kind: hint.framework
    value: storekit
sizeTarget: 700
priority: 5
---

# StoreKit 2
## When this applies
Use this only when RevenueCat is unavailable, opted out, or absent. If `import RevenueCat` exists, prefer `framework/revenuecat-ios`.

## Core rules
- Fetch products with `StoreKit.Product.products(for:)` and cache for the session.
- Purchase with `product.purchase()` and handle `.success(let verification)`, `.userCancelled`, and `.pending`.
- Grant access only from `VerificationResult.verified`. Treat `.unverified` as purchase failure.
- Read subscription status from `Product.SubscriptionInfo.Status.states`.
- Require `transaction.revocationDate == nil` and `transaction.expirationDate ?? .distantFuture > Date.now`.
- Always call `transaction.finish()` after granting entitlement.
- Restore with `AppStore.sync()` from a visible Restore Purchases action. Do not auto-restore on launch.
- Keep a `.storekit` config file for local sandbox tests.

## Common pitfalls
- UNVERIFIED-GRANT: unverified receipts can be tampered.
- MISSING-FINISH: unfinished transactions cause duplicate prompts and stale purchases.

## House style
Reference apps keep StoreKit configs for sandbox testing even when RevenueCat is primary.

## Verification commands
- `rg -n "Product\\.products|product\\.purchase|VerificationResult|transaction\\.finish|AppStore\\.sync" .`
- `find . -name "*.storekit" -print`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/app/finance-sample.premium.storekit`
