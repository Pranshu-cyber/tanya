---
slug: framework/shadcn-ui
title: shadcn/ui
loadWhen:
  - kind: workspace.has
    path: components.json
  - kind: hint.framework
    value: shadcn-ui
sizeTarget: 700
priority: 5
---
# shadcn/ui
## When this applies
Use this when a Next.js workspace has `components.json` or the task explicitly asks for shadcn/ui.

## Core rules
- shadcn/ui generates component source into `src/components/ui/` or the path declared in `components.json`.
- Edit generated files only for project-wide customization. Use wrapper components and composition for one-off design needs.
- Define visual states with `class-variance-authority` (`cva`). Keep variant, size, tone, and state classes in the variant config, not scattered through inline `className`.
- Treat `components.json` as the registry contract for style, CSS variables, Tailwind prefix, registry paths, and aliases. Do not manually drift managed paths.
- Override shadcn tokens in `globals.css` under `:root` and `.dark`: `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--destructive`, `--border`, `--ring`, and radius tokens.
- Build forms with `react-hook-form`, Zod, and `@hookform/resolvers/zod`. Use `<FormField>`, `<FormItem>`, `<FormLabel>`, `<FormControl>`, and `<FormMessage>`.
- Use Sonner for notifications and mount `<Toaster />` in the root layout.
- Use `<Dialog>`, `<Sheet>`, and `<AlertDialog>` for modal decisions. Never use `window.confirm` or `window.alert`.
- Use `lucide-react` icons. Do not inline SVG literals in JSX.

## Common pitfalls
- OVERRIDE-GENERATED: editing `button.tsx` for a single screen makes future registry updates risky.
- CSS-VAR-BYPASS: `bg-blue-500` bypasses theme tokens and breaks dark mode.
- INLINE-SVG: pasted SVGs create inconsistent sizing and accessibility.

## House style
cosmochat uses local `components/ui/*` files, `cva`, `cn()`, Radix primitives, lucide icons, and Tailwind v4 tokens. No `components.json` was present in the read-only web projects; when one exists, make it authoritative.

## Verification commands
- `test -f components.json && find src/components/ui components/ui -maxdepth 1 -type f | sort`
- `rg -n "cva\\(|VariantProps|from \"@/components/ui|lucide-react|sonner|react-hook-form" .`
- `rg -n "window\\.confirm|window\\.alert|<svg|bg-blue-500|text-blue-500" src app components`

## Canonical sources
- ~/workspaces/reference-chat/web/components/ui/button.tsx
- ~/workspaces/reference-chat/web/components/ui/dialog.tsx
- ~/workspaces/reference-chat/web/lib/cn.ts
- ~/workspaces/reference-chat/web/package.json
- ~/workspaces/reference-platform/artifacts/description.md
