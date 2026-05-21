# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Report is a verification table | report table columns "criterion,command,result" |
| 2 | Native splash call exists | rg "installSplashScreen" "." matches |
| 3 | Runtime Compose splash exists | rg "RuntimeSplash" "app/src/main/java" matches |
| 4 | Theme references splash icon | rg "windowSplashScreenAnimatedIcon" "app/src/main/res/values" matches |
| 5 | Referenced mipmap resource exists | file exists "app/src/main/res/mipmap-anydpi-v26/ic_launcher_foreground.xml" |
| 6 | No TODO list at end | report not-contains "TODO" |

## Anti-criteria (must NOT be present)
- Native-only splash without runtime layer
- Theme reference to a missing mipmap or drawable
- TODO or Next steps sections
