---
slug: platform-ops/windows-signing
title: Windows Authenticode Signing
loadWhen:
  - kind: hint.framework
    value: windows-signing
  - kind: hint.framework
    value: code-signing
sizeTarget: 500
priority: 9
---

# Windows Authenticode Signing

## When this applies
Use this for Windows binary signing, installer signing, SmartScreen posture, or CI signing setup.

## Core rules
- EV certificates reduce SmartScreen warnings on day one but require hardware token or cloud HSM.
- OV certificates build SmartScreen reputation over time; expect early warnings.
- Self-signed certificates are for local testing only.
- Sign from macOS/Linux with `osslsigncode` when Windows runners are unavailable.
- Timestamp every signature; without timestamping, signatures expire with the certificate.
- Use SHA-256 or stronger. Do not ship SHA-1 signing.
- Store P12 passwords and cloud HSM credentials in CI secrets only.
- Verify on Windows with `signtool verify /pa /v`, or cross-platform with `osslsigncode verify`.

## Common pitfalls
- No timestamp: old binaries become untrusted when the cert expires.
- Self-signed distribution: every user sees warnings.
- Secret leak: never echo P12 passwords in CI logs.
- Unsigned winget asset: winget rejects unsigned Windows installers.

## House style
Packaging prompts require cert-type rationale, timestamped signing, CI secret checks, and clean-VM verification evidence.

## Verification commands
- `rg -n "osslsigncode|signtool|WINDOWS_CERT|timestamp|KeyLocker|Key Vault" .`
- `osslsigncode verify -in <signed.exe>`
- `signtool verify /pa /v <signed.exe>`

## Canonical sources
- ~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00011_backfill_verify_prompts.sql
