# Verify Android Splash Layers

## Workspace
Android app: fixture/app/

## Intent
Analisar

## Goal
Verify the Android two-layer splash is intact: native Theme.SplashScreen plus Compose runtime splash. Confirm the splash icon resource matches the theme reference.

## Constraints
- Analyze mode is read-only.
- Accept either `@mipmap` or `@drawable` when the referenced resource exists.
- Do not append a TODO list.
