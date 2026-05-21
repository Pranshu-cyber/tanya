# Expected Outcome

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Component files are reported | modified contains "src/components/" |
| 2 | Uses framer-motion motion divs | rg "motion\\.div" "src/components/PricingSection.tsx" matches |
| 3 | Uses standard ease curve | rg "ease: \\[0\\.16, 1, 0\\.3, 1\\]" "src/components/PricingSection.tsx" matches |
| 4 | Staggers tiers with delays | rg "delay:" "src/components/PricingSection.tsx" matches |
| 5 | Uses shadcn Button | rg "Button" "src/components/PricingSection.tsx" matches |
| 6 | Uses shadcn Card | rg "Card" "src/components/PricingSection.tsx" matches |
| 7 | Checkout goes through API route | rg "/api/" "src" matches |
| 8 | Client does not instantiate Stripe directly | rg "Stripe\\(" "src/components/PricingSection.tsx" no-match |
| 9 | Tailwind v4 has no config file | file not exists "tailwind.config.ts" |

## Anti-criteria (must NOT be present)
- Faked install counts, ratings, or testimonials
- Direct client-side Stripe SDK calls
- `tailwind.config.ts` or v3 Tailwind setup
