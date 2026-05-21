# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Report is a verification table | report table columns "criterion,command,result" |
| 2 | Report uses PASS marker | report contains "PASS" |
| 3 | SplashIcon is used at runtime | rg "Image\\(.*SplashIcon" "." matches |
| 4 | AppIcon is not used at runtime | rg "Image\\(.*AppIcon" "." no-match |
| 5 | No TODO list at end | report not-contains "TODO" |

## Anti-criteria (must NOT be present)
- Runtime `Image("AppIcon")`
- Implementation suggestions in analyze mode
- TODO or Next steps sections
