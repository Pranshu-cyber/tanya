---
slug: domain/lgpd
title: LGPD Data Handling
loadWhen:
  - kind: hint.framework
    value: lgpd
  - kind: hint.framework
    value: compliance
  - kind: hint.framework
    value: privacy
sizeTarget: 500
priority: 7
---

# LGPD Data Handling

## When this applies
Use this for account deletion, privacy pages, logs, exports, retention, and user-owned data modeling.

## Core rules
- Soft-delete user-owned tables with `deleted_at TIMESTAMPTZ NULL`.
- Filter `deleted_at IS NULL` on every read path.
- Account deletion anonymizes instead of deleting: clear name/avatar and replace email with a deleted-user placeholder.
- Cascade-anonymize related records by clearing identifying fields while preserving financial or audit rows.
- Never log raw tokens in any environment.
- Mask emails, IP addresses, payment data, passwords, and full auth headers in logs.
- Provide user export through an account export endpoint returning JSON.
- Deletion requests invalidate all sessions and refresh tokens.
- Privacy pages include DPO contact, retention policy, collected data, and request channels.
- Hosting-region claims must match actual infra region.

## Common pitfalls
- Hard delete: foreign keys, analytics, and audit records lose integrity.
- Raw PII logs: emails, IPs, tokens, and payment data must be masked.
- Empty privacy page: pre-launch sites still need real LGPD content.

## House style
Go services combine `deleted_at IS NULL` filters with account anonymization. Landings expose Portuguese privacy and terms pages linked from the footer.

## Verification commands
- `rg -n "deleted_at IS NULL|deleted-" .`
- `rg -n "privacy|privacidade|DPO|encarregado|export" .`
- `rg -n "Authorization|Bearer|password|email" .`

## Canonical sources
- ~/workspaces/reference-chat/api/pkg/store/store.go
- ~/workspaces/reference-apps/finance-sample/finance-sample-site/src/app/privacidade/page.tsx
- ~/workspaces/reference-platform/src/lib/cosmoChat/codingRunReview.ts
