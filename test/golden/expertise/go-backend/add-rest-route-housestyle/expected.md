# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Handler has house-style signature | rg "func GetItemHandler\\(d Deps\\) http\\.HandlerFunc" "." matches |
| 2 | Reads route id through chi | rg "chi\\.URLParam" "." matches |
| 3 | Reads authenticated session | rg "auth\\.FromContext\\(r\\.Context\\(\\)\\)" "." matches |
| 4 | Maps store not-found sentinel | rg "errors\\.Is\\(.*store\\.ErrNotFound" "." matches |
| 5 | Store query scopes workspace | rg "workspace_id = \\$1" "." matches |
| 6 | Store query excludes soft-deleted rows | rg "deleted_at IS NULL" "." matches |
| 7 | Uses JSON helpers | rg "writeJSON" "." matches |
| 8 | Does not introduce sqlc | rg "sqlc" "." no-match |
| 9 | Does not introduce GORM | rg "gorm" "." no-match |

## Anti-criteria (must NOT be present)
- sqlc-generated calls
- GORM imports
- Unscoped `SELECT *`
