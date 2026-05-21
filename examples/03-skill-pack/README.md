# 03 - Skill pack

Author a tiny skill pack and verify that Tanya's loader selects it from its
frontmatter.

## Prerequisites

- Node.js 20 or newer
- Dependencies installed with `npm install`

## Run

```bash
npx tsx examples/03-skill-pack/check.ts
```

## What this demonstrates

- `skills/framework/example.md` declares a `hint.framework` rule.
- `check.ts` creates a loader context with that hint.
- The script exits non-zero unless `framework/example` is selected.
