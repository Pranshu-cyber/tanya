# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Handler reads session from context | rg "auth\\.FromContext" "." matches |
| 2 | Uses constant-time HMAC compare | rg "hmac\\.Equal" "." matches |
| 3 | References service token header | rg "X-Service-Token" "." matches |
| 4 | Creates synthetic service session | rg "service:" "." matches |
| 5 | Human-only route rejects service callers | rg "IsService" "." matches |
| 6 | No direct signature equality | rg "signature ==" "." no-match |

## Anti-criteria (must NOT be present)
- `==` comparison on signatures
- Workspace ID trusted from unsigned headers
- Dev fallback enabled in production
