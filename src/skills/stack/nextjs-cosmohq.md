---
slug: stack/nextjs-cosmohq
title: Next.js Stack
loadWhen:
  - kind: workspace.has
    path: next.config.ts
  - kind: workspace.has
    path: next.config.js
  - kind: workspace.has
    path: next.config.mjs
  - kind: hint.stack
    value: nextjs-cosmohq
sizeTarget: 700
priority: 3
---
# Next.js Stack
## When this applies
Use this for Next.js apps, dashboards, and landing sites.

## Core rules
- Use `src/app/` for routes, `src/components/ui/` for generated UI primitives, `src/components/` for custom components, `src/lib/` for env and API clients, `src/hooks/`, `src/types/`, and `public/`.
- Validate env vars in `src/lib/env.ts` with Zod at startup. Use `NEXT_PUBLIC_*` only for browser-safe values. Never import server-only env into Client Components.
- Use a typed API client or tRPC for backend calls. Authenticate with httpOnly cookies set by Route Handlers; never store access tokens in `localStorage`.
- For backend auth, handle 401 by redirecting to `/login` with `callbackUrl` and preserve the same 30s login grace semantics as the mobile clients.
- Every public page exports `metadata` or `generateMetadata`. Landing pages include a 1200x630 `og:image` and JSON-LD organization or product schema where relevant.
- Fire analytics through a `track()` abstraction under `src/lib/analytics/`. Never call vendor SDKs inline from components.
- Target LCP <= 2.5s, CLS < 0.1, and INP <= 200ms. Use `@vercel/speed-insights` on Vercel apps.
- Reference web apps need `BrandedComponents.tsx` with `PrimaryCTAButton`, `BrandedHeroCard`, `StatTile`, `BrandedListRow`, `BrandedEmptyState`, `BrandedLoadingShimmer`, and `BrandedTopBar`.
- Deploy on Vercel. Set production URL with `NEXT_PUBLIC_APP_URL`. Do not commit `.env.local`; use Vercel environment variables.

## Common pitfalls
- LOCALSTORAGE-TOKEN: browser storage exposes bearer tokens to any XSS payload.
- INLINE-TRACKING: vendor calls in components make analytics impossible to swap cleanly.
- MISSING-OG-IMAGE: shared landing links render blank social cards.
- TAILWIND-V3-CONFIG: adding a v3 config can disable v4 CSS-first behavior.

## House style
Reference apps use App Router, React 19, Tailwind v4, lucide, framer-motion landings, tRPC or typed fetch clients, and same-origin rewrites to Go APIs. Web is presentation; durable APIs stay in Go.

## Verification commands
- `test -f next.config.ts || test -f next.config.js || test -f next.config.mjs`
- `rg -n "NEXT_PUBLIC_APP_URL|z\\.object|localStorage|httpOnly|generateMetadata|openGraph|application/ld\\+json" src app lib`
- `rg -n "track\\(|gtag\\(|posthog\\.capture|BrandedComponents|SpeedInsights" src app components`

## Canonical sources
- ~/workspaces/reference-platform/app/src/app/layout.tsx
- ~/workspaces/reference-platform/app/src/app/page.tsx
- ~/workspaces/reference-platform/src/components/providers.tsx
- ~/workspaces/reference-chat/web/lib/api.ts
- ~/workspaces/reference-platform/artifacts/description.md
