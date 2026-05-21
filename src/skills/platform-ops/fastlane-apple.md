---
slug: platform-ops/fastlane-apple
title: Fastlane Apple Release Ops
loadWhen:
  - kind: hint.framework
    value: fastlane-apple
sizeTarget: 500
priority: 9
---

# Fastlane Apple Release Ops

## When this applies
Use this for iOS or macOS Fastlane lanes, TestFlight upload, App Store upload, version bumping, and release artifact cleanup.

## Core rules
- Keep one Fastfile with `platform :ios` and `platform :mac` when the project ships both.
- Shared helpers handle version bumping, archive, upload, and cleanup.
- Reference apps use App Store Connect API keys and provisioning args; `match` is valid only when the repo already uses it or setup asks for it.
- Use `build_app`/gym for archives and `upload_to_testflight`/pilot for TestFlight.
- Release lanes clean DerivedData and exported IPA/PKG artifacts unless `keep_artifacts` is true.
- Validate release automation with `fastlane lanes`, `ruby -c fastlane/Fastfile`, and a bounded archive lane.
- Trust Fastlane exit codes, not grep output from successful lanes.
- Delete generated `fastlane/README.md` and `fastlane/report.xml` noise unless requested.

## Common pitfalls
- Grep pass/fail: a successful lane may not print the searched token.
- Pipe masking: use pipefail when piping xcodebuild output.
- Fastlane junk: do not hide generated files in `.gitignore` when cleanup is expected.

## House style
Reference apps use shared iOS/macOS helpers, temporary API key files, cleanup on upload, and `keep_artifacts` as the operator escape hatch.

## Verification commands
- `ruby -c fastlane/Fastfile`
- `fastlane lanes`
- `rg -n "platform :ios|platform :mac|upload_to_testflight|build_app|keep_artifacts" fastlane/Fastfile`

## Canonical sources
- ~/workspaces/reference-apps/finance-sample/app/fastlane/Fastfile
- ~/workspaces/reference-apps/shared-kit/fastlane/Fastfile
