# Tanya Expertise Pack - Project Summary

## What we built

46 skill packs across `tanya/src/skills/`:

- 6 failure-modes packs, always loaded.
- 4 language packs: Swift, Kotlin, Go, TypeScript.
- 15 framework packs across iOS/macOS, Android, Go, and landing/web.
- 4 stack packs: iOS, Android, Go backend, landing/web.
- 11 domain packs for auth, billing, deep links, push, splash, API contracts, and LGPD.
- 6 platform-ops packs for fastlane, signing, packaging, and Go deployment.

Plus:

- Lazy loader in `src/skills/load.ts` with workspace probes, hint matching, frontmatter support, and an 8000-token pack budget.
- `runContext` schema hints: `languages`, `frameworks`, and `stack`.
- System-prompt wiring that inlines loaded packs between artifact index and history.
- `debug-prompt` matched-pack table with token counts and budget denominator.
- 11-task golden eval harness with validate-only and live-run modes.
- Refresh-cycle skeleton and workflow documentation.

## Architectural decisions

- Hybrid matching uses pack frontmatter `loadWhen` plus an `implicitReason` switch for compound workspace probes.
- Failure-mode packs and stack packs are protected from token-budget trimming.
- Hints are additive and can force relevant packs even when workspace probes are sparse.
- Pack content uses a hybrid sourcing protocol: hand-author from research, validate against canonical source, defer to source when they disagree.
- Language packs use priority 5 so they survive trimming in budget-heavy workspaces.
- Domain packs load from explicit per-pack rules instead of a broad "any stack" fallback.

## Source-driven deviations from the initial brief

- iOS Keychain: auth tokens use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; encryption keys use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- Android Compose navigation: live apps use string routes, not typed routes.
- Android Hilt: the reference app consolidates providers in `di/AppModule.kt`, not separate `DatabaseModule.kt`.
- Android RevenueCat: live app uses a custom paywall fed by offerings, not `PaywallActivity`.
- Landing structure: mature landing source uses `src/components/`, not always `src/components/sections/`.
- Go health endpoints: generated apps require `/healthz` and `/readyz`, not `/health`.
- Go deploy primary path: Azure App Service zip deploy with goose-before-publish, not Docker-first.
- Android splash icon: `@mipmap/ic_launcher_foreground` is the reference default; `@drawable/<name>` is only for divergent splash visuals.
- Apple Fastlane: ASC API keys and provisioning args are live practice; `match` is not universal.
- RevenueCat entitlement ID: app configuration, not a universal literal `premium`.

## Known limits

- Android full-stack workspaces run near budget pressure at about 7900/8000 tokens. The loader keeps failure modes, stack, framework, language, RevenueCat, and auth essentials; lower-priority mobile domains may trim.
- Hybrid matching means new packs need either an `implicitReason` entry or complete frontmatter coverage.
- The hand-rolled markdown/frontmatter parser is intentionally narrow. Non-trivial YAML should be avoided.
- Eval harness `--run-live` is implemented but not yet baselined by the operator.
- Package publishing still needs a markdown-pack strategy: copy packs into `dist/skills/` during build or include `src/skills/**/*.md` in `package.json#files`.

## Operator next steps

1. Run `npx tsx scripts/grade-expertise.ts --run-live` once to baseline golden behavior.
2. Decide the npm packaging strategy for markdown skill packs.
3. Schedule the refresh workflow in `docs/expertise-pack-process.md`.
4. Populate `runContext.languages/frameworks/stack` from host callers.
5. Trim duplicated framework rules from host prompt builders after the golden harness proves the packs.

## Phase commit map

- Phase 0: taxonomy - `2bf569a`.
- Phase 1: loader plumbing - `10f4ff2` through `1fb40b2`.
- Phase 2: failure-mode packs - `3737be1` through `34742b2`.
- Phase 3: Go packs - `33ed3d5` through `fc56ebe`.
- Phase 4: iOS packs - `f8b4e0f` through `a8a1578`.
- Phase 5: Android packs - `c335144` through `f321de6`.
- Phase 6: landing/web packs - `534fc84` through `91ae599`.
- Phase 7: domain and platform-ops packs - `46ba374` through `f95b83d`.
- Phase 8: eval harness - `d1c149a` through `27197b3`.
- Phase 9: refresh skeleton and final summary - `c39ef26` plus this summary/progress commit.
