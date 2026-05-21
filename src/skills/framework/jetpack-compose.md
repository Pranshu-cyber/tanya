---
slug: framework/jetpack-compose
title: Jetpack Compose
loadWhen:
  - kind: workspace.hasGlob
    glob: "**/build.gradle.kts"
  - kind: workspace.hasGlob
    glob: "**/build.gradle"
  - kind: hint.framework
    value: jetpack-compose
  - kind: hint.framework
    value: compose
sizeTarget: 700
priority: 5
---

# Jetpack Compose
## When this applies
Use this for Android screens, navigation, branded UI, charts, onboarding, paywalls, and themes.

## Core rules
- Use Material 3 `MaterialTheme` for color, typography, and shapes.
- Extend Material with `AppExtendedColors`: `income`, `expense`, `transfer`, `warning`, `info`, `cardBackground`, `groupedBackground`, `separator`.
- Expose colors through `staticCompositionLocalOf<AppExtendedColors>` named `LocalAppColors`.
- Wrap the root with `CompositionLocalProvider(LocalAppColors provides appColors)` inside `MaterialTheme`.
- Composables receive `uiState: XUiState` and callbacks. Reusable child composables do not read ViewModels.
- Hoist state to the lowest common ancestor.
- Use `NavHost` and `NavController`; inject ViewModels per destination with `hilt-navigation-compose`.
- Use typed routes for new flows without rewriting existing route style.
- Use `LazyColumn` or `LazyRow` with stable `key`; never place an unbounded `Column` inside a lazy item.
- Use Vico `com.patrykandpatrick.vico:compose-m3` for charts.
- `BrandedComponents.kt` mirrors iOS primitives: `PrimaryCTAButton`, `BrandedHeroCard`, `StatTile`, `BrandedListRow`, `BrandedEmptyState`, `BrandedLoadingShimmer`, `BrandedTopBar`.
- Log with `private const val TAG = "CFSYNC"` or a domain tag and `Log.d(TAG, ...)`; never `println`.

## Common pitfalls
- TOKEN-BYPASS: inline colors, spacing, and typography drift from iOS.
- VIEWMODEL-LEAK: child composables should not know Hilt or ViewModel types.
- LAZY-MISUSE: unbounded nested columns cause measurement crashes.

## House style
Reference apps use `FinanceSampleTheme`, Material 3, `LocalAppColors`, Navigation, Hilt, Vico charts, and branded components.

## Verification commands
- `rg -n "AppExtendedColors|LocalAppColors|CompositionLocalProvider|MaterialTheme" app/src/main/java`
- `rg -n "NavHost|hiltViewModel|LazyColumn|key =" app/src/main/java`
- `rg -n "println\\(|BrandedComponents|PrimaryCTAButton|vico" app/src/main/java app/build.gradle.kts`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/ui/theme/Theme.kt`
