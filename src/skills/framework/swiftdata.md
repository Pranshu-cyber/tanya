---
slug: framework/swiftdata
title: SwiftData
loadWhen:
  - kind: hint.framework
    value: swiftdata
sizeTarget: 700
priority: 5
---

# SwiftData
## When this applies
Use this when an Apple workspace uses SwiftData, `@Model`, `ModelContainer`, or `@Query`.

## Core rules
- Models are `@Model final class X` with `id: UUID`, `createdAt: Date`, and `updatedAt: Date`.
- Never use `@Attribute(.unique)` on mutable fields.
- Build containers in `AppModelContainerController.init()` or static helpers.
- DEBUG and RELEASE use separate files: `debug.store` and `default.store`.
- Disable CloudKit with `ModelConfiguration(cloudKitDatabase: .none)` unless explicitly requested.
- On container failure, remove local store files, retry once, then fall back to in-memory.
- Do not add `VersionedSchema` or `SchemaMigrationPlan`.
- Use `@Query` in views and environment `ModelContext` in services. Cross actors only with `@ModelActor`.
- Owned children use `@Relationship(deleteRule: .cascade)`; bidirectional links declare inverses.

## Common pitfalls
- SAME-STORE: debug and release must have different store names.
- CLOUDKIT-LEAK: implicit CloudKit changes sync behavior and privacy posture.
- MIGRATION-TRAP: schema plans create long-term migration obligations.

## House style
Reference Apple apps use local-only SwiftData with health checks, store deletion, one retry, and in-memory fallback.

## Verification commands
- `rg -n "@Model final class|createdAt|updatedAt|@Relationship" .`
- `rg -n "debug\\.store|default\\.store|cloudKitDatabase: \\.none|removeLocalStoreFiles" .`
- `rg -n "VersionedSchema|SchemaMigrationPlan" .`

## Canonical sources
- `~/workspaces/reference-apps/finance-sample/app/App/AppModelContainerController.swift`
- `~/workspaces/reference-apps/finance-sample/app/Models/`
