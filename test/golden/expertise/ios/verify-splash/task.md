# Verify iOS Splash Order

## Workspace
iOS app: fixture/app/

## Intent
Analisar

## Goal
Verify the iOS splash -> onboarding -> paywall -> root order is preserved. Report PASS, FAIL, or DEFERRED for each criterion using evidence commands.

## Constraints
- Analyze mode is read-only.
- Use `Image("SplashIcon")`, never runtime `Image("AppIcon")`.
- Do not append a TODO or next-steps list.
