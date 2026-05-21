---
slug: framework/room-hilt
title: Room + Hilt
loadWhen:
  - kind: workspace.hasGlob
    glob: "**/build.gradle.kts"
  - kind: hint.framework
    value: room-hilt
  - kind: hint.framework
    value: room
  - kind: hint.framework
    value: hilt
sizeTarget: 700
priority: 5
---

# Room + Hilt
## When this applies
Use this for Android persistence, DAOs, repositories, schema changes, migrations, and dependency injection.

## Core rules
- Keep a single `AppDatabase` annotated with all entity classes, current `version`, `exportSchema = false`, and `@TypeConverters(Converters::class)`.
- Keep the three-tier mapping: `data/local/entity/*Entity.kt`, `data/mapper/EntityMappers.kt`, `domain/model/DomainModels.kt`.
- DAOs return entity types. Repositories map to and from domain models. Never expose `*Entity` above the repository layer.
- Use KSP for Room. Reference `room-compiler` with `ksp(libs.room.compiler)`; do not add kapt.
- Add a `Migration(from, to)` object for every schema change and register it with `addMigrations(...)`.
- Do not use `fallbackToDestructiveMigration()` unless explicitly instructed; if present, keep it DEBUG-only.
- Provide `AppDatabase` as a singleton from a Hilt `@Module @InstallIn(SingletonComponent::class)`.
- Provide DAOs with `@Provides` functions from the same module.
- User-facing entities include `isDeleted: Boolean = false`; all SELECT queries filter `WHERE isDeleted = 0`.

## Common pitfalls
- KAPT-RESIDUE: mixing KSP and kapt breaks generated Room code.
- ENTITY-LEAK: repositories must not return Room schema types.
- MIGRATION-SKIP: destructive migration in production loses user data.

## House style
Reference apps register every entity in `AppDatabase`, keeps DAO providers in `AppModule`, uses explicit migrations, and only allows destructive fallback in DEBUG.

## Verification commands
- `rg -n "@Database|version =|exportSchema = false|TypeConverters|Migration\\(" app/src/main/java`
- `rg -n "fallbackToDestructiveMigration|addMigrations|ksp\\(libs\\.room\\.compiler\\)|kapt\\(" app app/build.gradle.kts`
- `rg -n "isDeleted|WHERE isDeleted = 0" app/src/main/java`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/data/local/db/AppDatabase.kt`
- `~/workspaces/reference-apps/finance-sample/finance-sample-android/app/src/main/java/com/example/financeapp/di/AppModule.kt`
