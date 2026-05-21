# Expertise Pack Taxonomy

This document summarizes the Phase 0 read-through of Tanya's current prompt rules,
context loading, reference-app house rules, and the reference artifact catalog. It defines
the initial skill-pack taxonomy for lazy loading.

## Prompt Voice And Loading Shape

Tanya's always-loaded system prompt is direct, operational, and evidence-oriented.
It favors concrete tool use, local context inspection, reusable artifacts, explicit
verification, and clear boundaries between implementation, execution, and manual
operator work.

Skill packs should preserve that voice:

- State rules as actionable constraints, not essays.
- Prefer artifact reuse and local evidence over generic advice.
- Keep pack bodies small enough to compose under a shared token budget.
- Load only the packs relevant to the current workspace, plus failure-mode packs
  that guard common agent errors.

## Stack Families

### Go Backend

Reference backend work appears in two Go shapes:

- House-style modular packages with `pkg/*/migrations/` and module attachment
  patterns such as `Module.Attach`.
- Huma/sqlc-style backends with generated store code under `internal/store/gen/`
  or dependencies on `github.com/danielgtaylor/huma`.

Mapped packs:

- `lang/go`
- `framework/chi-pgx`
- `framework/goose-migrations`
- `framework/service-tokens`
- `framework/huma-sqlc`
- Domain packs such as auth, API contract, LGPD, Stripe, and deployment ops when
  a backend stack is detected.

### Apple iOS/macOS

Reference Apple apps use Swift, SwiftUI, SwiftData, StoreKit 2, RevenueCat where
applicable, Apple sign-in, theme/navigation foundations, and Fastlane/signing
workflows. The artifact catalog includes reusable Apple API clients, session
stores, paywalls, SwiftData models, navigation/theme foundations, icons, splash,
and signing/release scaffolds.

Mapped packs:

- `lang/swift`
- `framework/swiftui`
- `framework/swiftdata`
- `framework/revenuecat-ios`
- `framework/storekit2`
- `platform-ops/apple-signing`
- `platform-ops/fastlane-apple`
- Mobile domain packs for Apple sign-in, deep links, push, splash/icon, auth,
  RevenueCat, API contracts, and LGPD.

### Android

Reference Android apps use Kotlin, Gradle, Jetpack Compose, Room/Hilt,
Retrofit/OkHttp, optional RevenueCat, Material 3, navigation/theme foundations,
icons/splash, and Fastlane release flows. The artifact catalog provides Android
theme, navigation, Room, Fastlane, and mobile app foundations.

Mapped packs:

- `lang/kotlin`
- `framework/jetpack-compose`
- `framework/room-hilt`
- `framework/retrofit-okhttp`
- `framework/revenuecat-android`
- `platform-ops/fastlane-android`
- Mobile domain packs for Google sign-in, deep links, push, splash/icon,
  RevenueCat, API contracts, and LGPD.

### Next.js Landing/Web

Reference landing and web surfaces use Next.js, TypeScript, Tailwind v4, shadcn/ui,
Framer Motion, lucide icons, and reusable landing sections. The dashboard stack is
larger, but Phase 1 detection focuses on the landing-style Next.js signal.

Mapped packs:

- `lang/typescript`
- `framework/nextjs15`
- `framework/tailwind-v4`
- `framework/shadcn-ui`
- Domain packs for Google sign-in, email/password auth, Stripe, API contracts,
  and LGPD when a web stack is detected.

## Cross-Cutting Packs

### Failure Modes

Failure-mode packs are always loaded. They guard analyze/verify discipline,
artifact lookup, speculative edits, implementation-vs-execution boundaries,
forbidden placeholder literals, and common report/verification mistakes.

### Domain Packs

Domain packs represent product capabilities that cut across stacks: auth,
sign-in providers, RevenueCat, Stripe, deep links, push notifications, splash/icon,
API contracts, and LGPD. They should load when a stack pack is present and the
domain is relevant to the detected or hinted stack.

Integration-specific stack packs can be added through `integrations/<name>/skills/`
when a product needs house rules beyond the generic language/framework/domain
packs.

### Platform Operations

Platform operations packs cover release/deploy surfaces such as Fastlane, Apple
signing, Go backend deployment, and package signing. They should load from
workspace probes such as `fastlane/Fastfile`, Apple workspace detection, or
explicit hints.

## Phase 1 Loading Rules

The loader should:

- Read markdown packs from `src/skills/**`.
- Parse YAML frontmatter and strip it before prompt insertion.
- Always include `failure-modes/*`.
- Detect Go, Apple, Android, and Next.js workspaces from filesystem probes.
- Treat run-context hints as additive.
- Keep all loaded packs under an advisory 4000-token budget.
- Never drop failure-mode packs or a stack pack that matched the current run.
