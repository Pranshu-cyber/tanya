# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Feature screen file is reported | modified contains "Features/Settings/" |
| 2 | Uses branded primitive | rg "PrimaryCTAButton" "App/Features/Settings" matches |
| 3 | Avoids RGB inline colors | rg "Color\\(red:" "App/Features/Settings" no-match |
| 4 | Uses Theme tokens | rg "Theme\\." "App/Features/Settings" matches |
| 5 | Routes from RootTabView | modified contains "RootTabView" |
| 6 | Avoids literal system fonts | rg "Font\\.system" "App/Features/Settings" no-match |

## Anti-criteria (must NOT be present)
- `Font.system(...)` literals in feature views
- Inline `Color(red:` declarations
- Runtime `Image("AppIcon")`
