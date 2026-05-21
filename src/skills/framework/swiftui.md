---
slug: framework/swiftui
title: SwiftUI
loadWhen:
  - kind: workspace.has
    path: Package.swift
  - kind: workspace.hasGlob
    glob: "**/*.xcodeproj"
  - kind: hint.framework
    value: swiftui
sizeTarget: 700
priority: 5
---

# SwiftUI
## When this applies
Use this for SwiftUI app entry points, screens, navigation, sheets, paywalls, and shared Apple views.

## Core rules
- Use `NavigationStack` for push flows and `NavigationSplitView` for two- or three-column layouts. Do not add `NavigationView`.
- Present with `.sheet(isPresented:)`, `.sheet(item:)`, `.fullScreenCover(isPresented:)`, or `.fullScreenCover(item:)`.
- Use `@State` for local values, `@StateObject`/`@ObservedObject` for reference state, and `@EnvironmentObject` for global injection.
- Prefer `@Observable` on iOS 17+ for new observable models. Keep `ObservableObject` where existing app patterns require it.
- Extract subviews into `View` structs; keep `body` near 30 lines.
- Animate with `.transition()` and `withAnimation {}`. Never call `UIView.animate` from SwiftUI view code.
- Interactive elements and informational images have `.accessibilityLabel`; decorative images use `.accessibilityHidden(true)`.
- App entry uses `@main struct XApp: App`, constructs controllers in `init()`, and injects `.modelContainer(controller.modelContainer)`.
- macOS-only delegates use `#if os(macOS)` plus `@NSApplicationDelegateAdaptor`.

## Common pitfalls
- BODY-SIDE-EFFECT: no network calls, writes, or task creation from computed view properties.
- NAVIGATIONVIEW-LEGACY: new flows use `NavigationStack` or `NavigationSplitView`.
- ACCESSIBILITY-GAP: buttons with only icons still need labels.

## House style
Root state lives in the app struct. Platform layout differences are gated while services and feature state stay shared.

## Verification commands
- `rg -n "NavigationView|UIView\\.animate|present\\(" .`
- `rg -n "NavigationStack|NavigationSplitView|fullScreenCover|accessibilityLabel|modelContainer" .`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/app/FinanceSampleApp.swift`
