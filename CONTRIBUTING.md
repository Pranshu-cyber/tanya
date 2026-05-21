# Contributing to Tanya

Thanks for contributing to Tanya. Keep changes small, testable, and explicit
about what they prove.

## Local setup

Prerequisites:

- Node.js 20 or newer
- npm
- `rg` for the `search` tool

```bash
npm install
npm run typecheck
npm test
npm run build
```

For local CLI testing:

```bash
npm run link:local
tanya doctor
```

## Development workflow

1. Open an issue for user-facing changes unless the work is already covered by
   a roadmap task.
2. Keep one behavioral concern per pull request.
3. Add or update tests for new behavior.
4. Run `npm run typecheck` and `npm test` before opening the PR.
5. Update `CHANGELOG.md` for user-visible changes.

Roadmap commits use `M<N>.<phase>:` prefixes, for example
`M0.2: add CONTRIBUTING, CODE_OF_CONDUCT, SECURITY`. Other work should use
conventional commits such as `feat:`, `fix:`, `docs:`, or `test:`.

## Add a tool

1. Add the implementation under `src/tools/`. Small filesystem tools currently
   live in `src/tools/fsTools.ts`; larger domains use their own module.
2. Implement the `TanyaTool` contract from `src/tools/types.ts`.
3. Register the tool in `defaultTools()` in `src/tools/fsTools.ts`.
4. If the tool has obvious risk, declare a `canRun` permission hook or add
   rules/examples in `docs/permissions.md` so stricter modes can gate it before
   execution.
5. Add focused tests under `test/` or `src/tools/__tests__/`.
6. If the tool changes model-visible behavior, update the README tool list and
   any relevant verifier/validator expectations.

Long-running tools should support `AbortSignal` and keep streaming progress
UI-only. The model conversation should receive only the final tool result.

## Add a skill pack

1. Add a Markdown file under the matching folder in `src/skills/`.
2. Include frontmatter with `slug`, `title`, `loadWhen`, `sizeTarget`, and
   `priority`.
3. Keep the body concise enough for the skill-pack token budget enforced by
   `src/skills/load.ts`.
4. Add loader coverage in `src/skills/__tests__/load.test.ts` when matching
   behavior changes.

Minimal example:

```md
---
slug: framework/example
title: Example
loadWhen:
  - kind: hint.framework
    value: example
sizeTarget: 300
priority: 5
---
# Example

## Core rules
- Keep guidance concrete and verifiable.
```

## Pull request checklist

- [ ] Scope is focused and the user-facing behavior is clear.
- [ ] Tests were added or updated when behavior changed.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] README/docs were updated when commands, tools, or workflows changed.
- [ ] `CHANGELOG.md` was updated for user-visible changes.
- [ ] Golden-task or verifier impact is called out when relevant.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow
[`SECURITY.md`](./SECURITY.md) instead.
