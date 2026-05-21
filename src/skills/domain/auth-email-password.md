---
slug: domain/auth-email-password
title: Email and Password Auth
loadWhen:
  - kind: hint.framework
    value: auth-email-password
  - kind: hint.framework
    value: password-auth
sizeTarget: 500
priority: 7
---

# Email and Password Auth

## When this applies
Use this for email/password fallback auth, verification codes, password reset, or account-linking flows.

## Core rules
- Hash passwords with bcrypt cost 12 or higher, or argon2id with reviewed parameters.
- Never use raw SHA, MD5, or reversible encryption for passwords.
- Email verification is mandatory after signup.
- Verification tokens are single-use, hashed in storage, and expire after 24h.
- Password reset uses the same single-use-token pattern and expires after 1h.
- Rate-limit login, register, and forgot-password by IP and by account.
- Link accounts only by verified email across Apple, Google, and password auth.
- Lock the account or require CAPTCHA after repeated failures.
- Account deletion anonymizes email and clears name/avatar fields; do not hard-delete the user row.

## Common pitfalls
- Unverified link: linking on an unverified email lets attackers claim accounts.
- Token reuse: reset and verification codes must be one-time.
- Weak hashing: bcrypt cost below 12 is not the reference platform baseline.

## House style
Reference iOS apps implement email registration, verification, resend, login, forgot-password, and reset-password against no-auth API routes.

## Verification commands
- `rg -n "bcrypt|argon2|passwordHash|hash\\(" .`
- `rg -n "verify-email|forgot-password|reset-password|single-use|expires" .`
- `rg -n "rateLimit|failed_attempts|captcha|deleted-" .`

## Canonical sources
- ~/workspaces/reference-platform/artifacts/backend/AuthSetup.ts
- ~/workspaces/reference-platform/artifacts/backend/EmailVerificationCode.ts
- ~/workspaces/reference-apps/finance-sample/app/Features/Auth/AuthViewModel.swift
