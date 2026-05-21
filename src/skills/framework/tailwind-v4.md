---
slug: framework/tailwind-v4
title: Tailwind v4
loadWhen:
  - kind: workspace.has
    path: next.config.ts
  - kind: workspace.has
    path: next.config.js
  - kind: workspace.has
    path: next.config.mjs
  - kind: hint.framework
    value: tailwind-v4
sizeTarget: 700
priority: 5
---
# Tailwind v4
## When this applies
Use this for Tailwind v4 styling in a Next.js workspace.

## Core rules
- Use CSS-first configuration. Put design tokens in `globals.css` with `@theme`, `@layer base`, `@layer components`, and `@layer utilities`.
- Keep `tailwind.config.ts` minimal or absent. Do not add a v3-style `theme.extend` config unless the project already uses a compat shim.
- Define colors, spacing, radii, fonts, and shadows as CSS custom properties under `@theme`.
- Reference tokens through utilities or `var(--color-...)`. Do not hardcode hex values in `className` strings.
- Implement dark mode through token overrides in `@layer base`, either with `@media (prefers-color-scheme: dark)` or a `.dark` class.
- Use `cn()` from `@/lib/utils` or the local equivalent for conditional classes. Do not concatenate Tailwind class strings by hand.
- Apply responsive prefixes mobile-first: unprefixed, then `sm:`, `md:`, `lg:`, `xl:`, `2xl:`.
- Use `animate-*` utilities for simple motion. Use framer-motion for orchestrated sequences. Keep raw keyframes in `@layer utilities`.
- Avoid `@apply`. If the repo already uses it, keep it inside `@layer components`.

## Common pitfalls
- V3-CONFIG: adding `tailwind.config.js` with `theme.extend` can pull a v4 project into compatibility mode.
- HEX-DRIFT: inline hex values bypass tokens and break theme updates.
- CLASS-MERGE: string concatenation leaves conflicting utilities in place.

## House style
reference platform web projects use Tailwind v4, `@tailwindcss/postcss`, `@import "tailwindcss"`, CSS `@theme` tokens, `cn()` with `clsx` plus `tailwind-merge`, and framer-motion landing sections. Preserve local token names before introducing new ones.

## Verification commands
- `rg -n "@import \"tailwindcss\"|@theme|@tailwindcss/postcss|tailwind-merge|clsx" .`
- `rg -n "theme:\\s*\\{\\s*extend|#[0-9a-fA-F]{3,8}|className=\\{.*\\+" app src components`
- `rg -n "@keyframes|@apply|framer-motion|animate-" app src components`

## Canonical sources
- ~/workspaces/reference-chat/web/app/globals.css
- ~/workspaces/reference-chat/web/tailwind.config.ts
- ~/workspaces/reference-chat/web/lib/cn.ts
- ~/workspaces/reference-platform/app/src/app/globals.css
- ~/workspaces/reference-platform/artifacts/styles/design-tokens.css
