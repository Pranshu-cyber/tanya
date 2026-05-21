---
slug: lang/swift
title: Swift Language
loadWhen:
  - kind: workspace.has
    path: Package.swift
  - kind: workspace.hasGlob
    glob: "**/*.xcodeproj"
  - kind: hint.language
    value: swift
sizeTarget: 500
priority: 5
---

# Swift Language
## When this applies
Use this for Swift in Apple targets.

## Core rules
- Use async/await for new I/O. Callback APIs are legacy boundaries only.
- Start UI work with SwiftUI `.task {}` or a tracked `Task`; cancel owned tasks on disappearance.
- Put `@MainActor` on `ObservableObject` or `@Observable` UI-state types. Do not add `DispatchQueue.main.async`.
- Set `JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase` once in `APIClient`. Add `CodingKeys` only when names differ.
- Define sealed `enum XError: Error, LocalizedError`. Never hide failures with silent `try?`; log or rethrow.
- Store secrets in Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Never use `Always`, plain `WhenUnlocked`, or UserDefaults for tokens.
- Use `debugLog(.domain, emoji: marker, ...)` with `.app`, `.auth`, `.sync`, `.api`. No production `print()`.
- Gate platform divergence with `#if os(macOS)` and use `@NSApplicationDelegateAdaptor` only in macOS app entry points.

## Common pitfalls
- CALLBACK-DRIFT: convert callbacks at the boundary and return async values.
- MAIN-QUEUE-PATCH: `DispatchQueue.main.async` hides missing actor isolation.
- TOKEN-DEFAULTS: UserDefaults is never acceptable for access or refresh tokens.

## House style
Reference Apple apps use URLSession singletons, localized errors, certificate validation, refresh coalescing, 30-second login grace, and `debugLog`.

## Verification commands
- `rg -n "DispatchQueue\\.main\\.async|print\\(|try\\?" .`
- `rg -n "@MainActor|ObservableObject|@Observable|keyDecodingStrategy|kSecAttrAccessible" .`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/app/Services/APIClient.swift`
