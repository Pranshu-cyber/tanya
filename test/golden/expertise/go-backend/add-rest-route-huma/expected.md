# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Defines Huma input struct | rg "type .*Input struct" "internal/handlers" matches |
| 2 | Defines Huma output struct | rg "type .*Output struct" "internal/handlers" matches |
| 3 | Output includes Body field | rg "Body" "internal/handlers" matches |
| 4 | Calls generated store package | rg "gen\\." "internal/handlers" matches |
| 5 | Registers Huma operation | rg "huma\\.Register" "internal/handlers" matches |
| 6 | Handler files contain no hand-SQL | rg "SELECT .* FROM" "internal/handlers" no-match |

## Anti-criteria (must NOT be present)
- Hand-written SQL strings in `internal/handlers`
- chi-only handler helpers as the primary route implementation
- Missing Output `Body`
