---
slug: lang/kotlin
title: Kotlin Language
loadWhen:
  - kind: workspace.hasGlob
    glob: "**/build.gradle.kts"
  - kind: workspace.hasGlob
    glob: "**/build.gradle"
  - kind: hint.language
    value: kotlin
sizeTarget: 500
priority: 5
---

# Kotlin Language
## When this applies
Use this for Kotlin in Android app modules, repositories, ViewModels, and Compose support code.

## Core rules
- Use `suspend` functions for database and network I/O.
- Launch work from `viewModelScope` or `lifecycleScope`; never use `GlobalScope`.
- Use `Dispatchers.IO` for database/network and `Dispatchers.Main` for UI.
- Expose `StateFlow` from ViewModels, not LiveData. Use `collectAsStateWithLifecycle()` in Compose.
- Use cold `Flow` for streams and one-shot operations; use `SharedFlow` for events.
- Prefer non-null types. Use safe calls and `?.let {}` for nullable chains. `!!` is allowed only when the type system enforces the invariant.
- Model results with sealed `ApiResult<T>` and route Retrofit calls through `safeApiCall {}`.
- Use Gradle Kotlin DSL only. Put versions in `gradle/libs.versions.toml` and reference dependencies as `libs.<name>`.
- Keep `compileSdk = 36`, `minSdk = 26`, `targetSdk = 36`, Java 17, KSP, and `org.jetbrains.kotlin.plugin.compose`.

## Common pitfalls
- GLOBALSCOPE-LEAK: unowned coroutines outlive the screen or process state.
- FORCE-UNWRAP: `!!` turns nullable domain state into crashes.
- VERSION-DRIFT: hardcoded Gradle versions bypass the catalog.

## House style
Reference Android apps use Kotlin DSL, catalogs, Compose, Hilt, Room, KSP, Retrofit/Moshi/OkHttp, Java 17, and tagged logging.

## Verification commands
- `rg -n "GlobalScope|LiveData|!!|kapt\\(|version = \\\"" .`
- `rg -n "StateFlow|collectAsStateWithLifecycle|safeApiCall|compileSdk = 36|JavaVersion.VERSION_17|ksp" .`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/build.gradle.kts`
