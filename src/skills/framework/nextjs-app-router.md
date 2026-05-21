---
slug: framework/nextjs-app-router
title: Next.js App Router
loadWhen:
  - kind: workspace.has
    path: next.config.ts
  - kind: workspace.has
    path: next.config.js
  - kind: workspace.has
    path: next.config.mjs
  - kind: hint.framework
    value: nextjs-app-router
sizeTarget: 700
priority: 4
---
# Next.js App Router
## When this applies
Use this for Next.js workspaces that use the App Router.

## Core rules
- Treat every `app/` file as a Server Component unless it begins with `'use client'`.
- Prefer Server Components. Add `'use client'` only for hooks, browser APIs, event handlers, client context, or animation libraries.
- Fetch server data in Server Components. Use `{ next: { revalidate: N } }` for static plus revalidation, `{ cache: 'no-store' }` for dynamic data, and `unstable_cache` for expensive server computations.
- Do not use `useEffect` plus `fetch` for data that can load server-side.
- Keep `app/layout.tsx` as the root shell for fonts, metadata, and providers. Segment layouts share UI across navigation.
- Implement Route Handlers in `app/api/*/route.ts`; export `GET`, `POST`, and peers. Return `NextResponse.json(data, { status })`. Validate request bodies with Zod before use.
- Use Server Actions for form mutations and progressive enhancement. Validate with Zod and call `revalidatePath` or `revalidateTag` after mutations.
- Export `metadata` or `generateMetadata` from every page. Include `title`, `description`, `openGraph.title`, `openGraph.description`, and `openGraph.images`.
- Add `error.tsx`, `not-found.tsx`, and `loading.tsx` where the route needs recovery, 404, or streaming states.
- Use `next/image` for content images with dimensions or `fill` inside a positioned container. Use `next/font/*` in the root layout; never load Google Fonts through a raw link.

## Common pitfalls
- CLIENT-CASCADE: a high-level Client Component pulls the subtree into the browser bundle.
- ROUTE-TRUST: parsing JSON without Zod turns malformed requests into runtime bugs.
- IMAGE-DRIFT: raw `img` misses Next image sizing, optimization, and layout guarantees.

## House style
Reference apps use App Router, typed route handlers, tRPC, React Query providers, same-origin rewrites to Go APIs, and metadata-rich landing layouts. Preserve local route shape before adding a client data layer.

## Verification commands
- `rg -n "'use client'|\"use client\"|export const metadata|generateMetadata|NextResponse\\.json" app src/app`
- `rg -n "useEffect\\(.*fetch|<img|next/font/google|next/font/local" app src/app components src/components`
- `find app src/app -name 'route.ts' -print | xargs rg -n "z\\.object|safeParse|NextResponse\\.json"`

## Canonical sources
- ~/workspaces/reference-platform/app/src/app/layout.tsx
- ~/workspaces/reference-platform/app/src/app/error.tsx
- ~/workspaces/reference-platform/src/app/api/public/contact/route.ts
- ~/workspaces/reference-platform/src/app/api/trpc/[trpc]/route.ts
- ~/workspaces/reference-chat/web/next.config.ts
