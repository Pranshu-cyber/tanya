---
slug: lang/typescript
title: TypeScript
loadWhen:
  - kind: workspace.has
    path: next.config.ts
  - kind: workspace.has
    path: next.config.js
  - kind: workspace.has
    path: next.config.mjs
sizeTarget: 500
priority: 5
---
# TypeScript
## When this applies
Use this for TypeScript in a Next.js App Router workspace.

## Core rules
- Keep strict mode on: `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`.
- Model async UI and API results as discriminated unions. Use `satisfies` for literals that must conform without widening.
- Use standard utility types instead of reimplementing them.
- Validate API responses, request bodies, env vars, and form data with Zod. Derive types with `z.infer<typeof Schema>`.
- Access env vars through a validated `env` object from `@/lib/env`. Use `process.env.NEXT_PUBLIC_*` only in Client Components for public vars.
- Keep `@/*` mapped to `./src/*`. Avoid deep relative imports.
- Use `as` only after a runtime check proves the narrowed type. Never use `as any` or `as unknown as T`.

## Common pitfalls
- STRICT-RELAX: disabling strict flags hides the bug instead of fixing the type.
- BOUNDARY-SKIP: `as unknown as T` turns untrusted data into trusted data.
- ENV-LEAK: importing server env into a Client Component exposes deployment secrets.

## House style
Reference apps use strict TypeScript, `@/*` aliases, Zod at route boundaries, typed fetch helpers, and `cn()` composition. New env work uses Zod instead of direct `process.env` access.

## Verification commands
- `rg -n "\"strict\": true|noUncheckedIndexedAccess|exactOptionalPropertyTypes" tsconfig.json`
- `rg -n "as any|as unknown as|process\\.env" src app components lib`
- `rg -n "z\\.object|z\\.infer|satisfies|status: 'idle'|status: \"idle\"" src app lib`

## Canonical sources
- ~/workspaces/reference-platform/artifacts/configs/tsconfig.base.json
- ~/workspaces/reference-chat/web/tsconfig.json
- ~/workspaces/reference-chat/web/lib/api.ts
- ~/workspaces/reference-platform/src/app/api/public/contact/route.ts
