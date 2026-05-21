# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Uses SubscriptionManager singleton | rg "SubscriptionManager\\.shared" "." matches |
| 2 | Restore Purchases is exposed | rg "restorePurchases" "." matches |
| 3 | UI test flag is honored | rg "ProcessInfo\\.processInfo\\.arguments" "." matches |
| 4 | Snapshot flag is honored | rg "snapshot-scene" "." matches |
| 5 | Does not use raw StoreKit product fetch | rg "Product\\.products\\(for:" "." no-match |
| 6 | Does not hardcode premium entitlement | rg "\\bpremium\\b" "." no-match |

## Anti-criteria (must NOT be present)
- Raw StoreKit 2 `Product.products(for:)` calls
- Hardcoded `"premium"` entitlement literals
- Missing Restore Purchases action
