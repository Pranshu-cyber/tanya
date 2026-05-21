---
slug: platform-ops/fastlane-android
title: Fastlane Android Release Ops
loadWhen:
  - kind: hint.framework
    value: fastlane-android
sizeTarget: 500
priority: 9
---

# Fastlane Android Release Ops

## When this applies
Use this for Android AAB builds, Play internal-track uploads, metadata uploads, and promotion lanes.

## Core rules
- Keep `platform :android do` in `fastlane/Fastfile`.
- Build release AABs with Gradle bundle release.
- Upload with `upload_to_play_store`/supply to the internal track by default.
- Service account JSON lives at `fastlane/play-store-key.json` or env-driven path; never commit it.
- Default is no Gemfile for Android. Use Homebrew/system Fastlane unless the workspace explicitly opts into a bundled Fastlane setup.
- Do not edit managed signing scripts; local signing is the upload key, Play App Signing handles distribution.
- Clean generated AAB/APK build artifacts after successful upload unless `keep_artifacts` is true.
- Metadata lanes skip binary upload; deploy lanes build then upload.

## Common pitfalls
- Committed service account: Play credentials must stay outside git.
- Managed signing edits: centrally owned release-signing Gradle scripts should not be edited by app tasks.
- Stale bundle: delete old outputs before release builds when automation does not clean.

## House style
Reference Android apps use a single-module Gradle app, internal-track upload, skipped metadata on binary uploads, and cleanup of `app/build`.

## Verification commands
- `ruby -c fastlane/Fastfile`
- `rg -n "platform :android|upload_to_play_store|bundle|keep_artifacts|play-store-key" fastlane/Fastfile`
- `test ! -f fastlane/play-store-key.json || git check-ignore fastlane/play-store-key.json`

## Canonical sources
- ~/workspaces/reference-apps/finance-sample/finance-sample-android/fastlane/Fastfile
- ~/workspaces/reference-platform/artifacts/android/FastlaneSetup.md
- ~/workspaces/reference-platform/artifacts/android/PlayRelease_ManualSteps.md
