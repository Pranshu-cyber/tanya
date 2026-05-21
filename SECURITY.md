# Security Policy

## Supported versions

Until Tanya reaches a stable release, security fixes target:

| Version | Supported |
|---------|-----------|
| `main` | Yes |
| Latest published beta | Yes |
| Older prereleases | No |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Email
`matheus.jk.weber@gmail.com` with:

- A short description of the issue
- Impact and likely attack path
- Reproduction steps or a minimal proof of concept
- Any relevant logs, files, or environment details

Use a subject such as `Tanya security report: <short summary>`.

## Response targets

- Acknowledge receipt within 3 business days
- Provide an initial triage assessment within 14 days
- Coordinate a fix and disclosure timeline based on severity

If a report is accepted, fixes should land before public disclosure whenever
that is practical.

## Scope notes

Security-sensitive surfaces include:

- Tool execution and workspace boundary checks
- Provider credentials and environment handling
- Secret-detection behavior
- Published package contents and release workflow credentials

The deterministic verifier is a correctness mechanism, not a substitute for
operating-system isolation or secret hygiene.
