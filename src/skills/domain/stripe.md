---
slug: domain/stripe
title: Stripe Billing
loadWhen:
  - kind: hint.framework
    value: stripe
sizeTarget: 500
priority: 7
---

# Stripe Billing

## When this applies
Use this for web/backend billing, checkout, customer portal, webhooks, and server-side premium gates.

## Core rules
- Verify Stripe webhook signatures on the raw request body before JSON parsing.
- Use subscription mode for monthly/yearly plans and payment mode for lifetime plans.
- Keep plan IDs in a server-side allowlist; never trust client-provided price IDs directly.
- Configure Customer Portal in the Stripe dashboard; document it as a manual operator step.
- Register webhook endpoints manually in the Stripe dashboard.
- Keep test and live keys completely separate through env config.
- Gate premium features server-side through subscription status, not client state.
- Stripe is web/backend only in reference platform. Mobile subscriptions use RevenueCat.

## Common pitfalls
- Body parser first: consumed streams break signature verification.
- Hardcoded plans: app code drifts from dashboard config.
- Client-only gate: users can bypass paid features.
- Mobile Stripe: do not introduce Stripe into iOS or Android subscription flows.

## House style
Stripe artifacts use Zod request validation, an explicit plan map, raw-body webhook verification, and app base URL from env.

## Verification commands
- `rg -n "constructEvent|webhook.*secret|req\\.text\\(|rawBody" .`
- `rg -n "checkout\\.sessions|billingPortal|price|plan" .`
- `rg -n "pk_test|sk_test|pk_live|sk_live" .`

## Canonical sources
- ~/workspaces/reference-platform/artifacts/backend/StripeBillingRoutes.ts
- ~/workspaces/reference-apps/finance-sample/finance-sample-site/src/
