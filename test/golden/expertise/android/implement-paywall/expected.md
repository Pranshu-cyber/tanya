# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Uses domain SubscriptionManager | rg "SubscriptionManager" "app/src/main/java/com/example/app" matches |
| 2 | Configures RevenueCat SDK | rg "Purchases\\.configure" "app/src/main/java" matches |
| 3 | Checks backend premium before SDK entitlement flow | rg "backendPremium" "app/src/main/java" matches |
| 4 | Restore action is visible | rg "Restore" "app/src/main/java" matches |
| 5 | Avoids raw BillingClient | rg "BillingClient" "app/src/main/java" no-match |

## Anti-criteria (must NOT be present)
- `com.android.billingclient` imports
- Paywall with no restore action
- SDK entitlement check before backend premium check
