---
slug: framework/retrofit-okhttp
title: Retrofit + OkHttp
loadWhen:
  - kind: workspace.hasGlob
    glob: "**/build.gradle.kts"
  - kind: hint.framework
    value: retrofit-okhttp
  - kind: hint.framework
    value: retrofit
  - kind: hint.framework
    value: okhttp
sizeTarget: 700
priority: 5
---

# Retrofit + OkHttp
## When this applies
Use this for Android networking, auth refresh, interceptors, DTOs, Moshi, secrets, and API errors.

## Core rules
- Provide two Hilt OkHttp clients: `@Named("noAuth")` for `/auth/refresh`, default authenticated client for all else.
- The no-auth client never has `AuthInterceptor` or the refresh authenticator.
- Interceptor order is `AuthInterceptor`, `RetryInterceptor(maxRetries=3, initialDelayMs=500)`, then `HttpLoggingInterceptor`.
- Set `HttpLoggingInterceptor.Level.BODY` in DEBUG and `NONE` in release. Never log bodies in release builds.
- Handle 401 with `okhttp3.Authenticator`, `synchronized(this)`, `@Volatile isRefreshing`, and `runBlocking` only as bridge.
- Preserve `LOGIN_GRACE_PERIOD_MS = 30_000` and mark retried requests with `X-Retry: true`.
- Moshi includes `KotlinJsonAdapterFactory`; Kotlin properties are camelCase and JSON differences use `@Json(name = "snake_case_key")`.
- Store tokens with `EncryptedSharedPreferences` through `TokenManager` and `SessionStore`.
- Read secrets with `secretFromLocalOrEnv("KEY", placeholder)` and expose `BuildConfig.BASE_URL` and `BuildConfig.REVENUECAT_API_KEY`.
- Google Sign-In `default_web_client_id` is the WEB OAuth client ID, not the Android client ID.

## Common pitfalls
- NOAUTH-LOOP: auth headers on refresh requests create recursive 401s.
- LOG-LEAK: release BODY logging exposes credentials to logcat.
- WEB-CLIENT-ID: Android OAuth IDs produce backend verification failures.

## House style
`NetworkModule.kt` owns Moshi, Retrofit, retry, debug logging, no-auth and authenticated clients. `TokenRefreshAuthenticator.kt` mirrors iOS login grace.

## Verification commands
- `rg -n "@Named\\(\"noAuth\"\\)|AuthInterceptor|TokenRefreshAuthenticator|LOGIN_GRACE_PERIOD_MS|X-Retry" app/src/main/java`
- `rg -n "HttpLoggingInterceptor.Level.BODY|HttpLoggingInterceptor.Level.NONE|KotlinJsonAdapterFactory|EncryptedSharedPreferences" app/src/main/java`
- `rg -n "secretFromLocalOrEnv|BuildConfig\\.BASE_URL|BuildConfig\\.REVENUECAT_API_KEY|default_web_client_id" app build.gradle.kts`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/di/NetworkModule.kt`
