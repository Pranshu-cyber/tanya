# Add Android Settings Screen

## Workspace
Android app: fixture/app/

## Intent
Implementar

## Goal
Add a Settings Compose screen. Use MaterialTheme plus LocalAppColors. Route it through the existing string-route NavHost, following the target app style.

## Constraints
- Keep state hoisted and inject the ViewModel at the navigation boundary.
- Do not introduce typed routes into this string-route app.
- Do not use raw `Color(0xFF...)` values in the feature view.
