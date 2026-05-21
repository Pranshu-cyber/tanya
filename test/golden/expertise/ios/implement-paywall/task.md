# Implement RevenueCat Paywall

## Workspace
iOS app: fixture/app/

## Intent
Implementar

## Goal
Implement the premium paywall using the SubscriptionManager singleton. Surface a Restore Purchases button. Honor `--uitesting` and `--snapshot-scene` test flags so UI and snapshot tests can force premium state.

## Constraints
- RevenueCat is the primary subscription engine.
- Do not add raw StoreKit 2 entitlement logic.
- Do not hardcode entitlement IDs in feature views.
