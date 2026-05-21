# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Settings feature path is reported | modified contains "ui/feature/settings" |
| 2 | Uses MaterialTheme colors | rg "MaterialTheme\\.colorScheme" "app/src/main/java" matches |
| 3 | Uses LocalAppColors | rg "LocalAppColors\\.current" "app/src/main/java" matches |
| 4 | Adds string-route composable | rg "composable\\(" "app/src/main/java/com/example/app/ui/navigation" matches |
| 5 | Route name settings appears | rg "settings" "app/src/main/java/com/example/app/ui/navigation" matches |
| 6 | ViewModel injection happens at composable boundary | rg "hiltViewModel<" "app/src/main/java" matches |
| 7 | No raw Compose hex colors | rg "Color\\(0xFF" "app/src/main/java/com/example/app/ui/feature/settings" no-match |

## Anti-criteria (must NOT be present)
- Raw `Color(0xFF...)` in the feature view
- Typed-route migration in this string-route fixture
- ViewModel passed into deep child composables
