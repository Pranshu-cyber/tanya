# Tanya Expertise Pack Refresh Process

## Why packs need refresh

Skill packs encode current reference-app practice for SwiftUI, SwiftData, RevenueCat, Jetpack Compose, Room, Hilt, Retrofit, chi, pgx, Huma, sqlc, Next.js, Tailwind, shadcn/ui, billing, auth, deployment, and platform operations. Those frameworks evolve, and house style evolves with the apps. Without a refresh loop, Tanya starts giving outdated advice with confidence.

## Cadence

Run the refresh monthly during active reference-app development.

Run it quarterly during maintenance phases.

Tie the cadence to a recurring calendar reminder or CI cron. The current script is plan-only; a CI job should archive the generated refresh report and notify the operator when packs are flagged.

## What triggers a refresh

- A framework named in a pack ships a major version, such as Tailwind v5, Next.js 17, Kotlin 3, SwiftData migration changes, or Huma/sqlc generator changes.
- A canonical source file moves, is deleted, or is rewritten.
- A live `tanya run` produces output that contradicts a pack rule.
- A new reference app diverges from documented house style.
- A reference artifact template changes its route shape, auth posture, deployment path, or platform setup.
- A platform store policy changes, especially App Review, Play Console, RevenueCat, Stripe, notarization, or signing requirements.

## How to refresh

1. Run `npx tsx scripts/refresh-skill-packs.ts` from the Tanya repo.
2. Open the generated refresh report path printed by the script.
3. For each flagged pack, read the canonical source paths listed in the pack.
4. Compare the source to the current pack content.
5. Decide whether the drift is a brief error, a stale pack rule, a source move, or a real house-style evolution.
6. Update the pack with the smallest accurate wording change.
7. Mirror cascading corrections across related packs.
8. Keep the canonical source footer honest.
9. Recompute token counts and keep each pack within its budget.
10. Run `npx tsx scripts/grade-expertise.ts --run-live` when the operator wants behavioral evidence.
11. Run `npm run build` and `npx vitest run`.
12. Commit each pack update individually with `[Tanya] Refresh <pack-slug> for <reason>`.

## Pack review checklist

- Frontmatter still parses.
- `slug` matches the loader path convention.
- `loadWhen` still covers hint-driven loading.
- `implicitReason` still covers compound workspace detection where needed.
- `## Canonical sources` contains paths or URLs that still explain the rule.
- New source-backed deviations are documented in `docs/expertise-pack-summary.md`.
- Failure-mode and stack packs still survive budget trimming.
- Android and multi-stack workspaces stay under the 8000-token budget, or trimming behavior is intentional.

## Handling source disagreements

Live source wins when it reflects a working production capability.

Use the Phase 4 Keychain correction as the model: the brief said one access tier, but production source used a split tier because background sync needed token access after first unlock. The pack had to change.

Use the Phase 7 Go health correction as the model for cascades: `/health` was generic guidance, while generated reference apps require `/healthz` and `/readyz`. Every Go pack that mentioned health endpoints had to move together.

When source disagrees in a function-affecting way, stop and ask the operator before rewriting broad guidance.

## Evaluating refresh quality

The eval harness is the behavioral backstop.

Validate-only mode checks that fixtures, prompts, rubrics, and loader matches still make sense:

`npx tsx scripts/grade-expertise.ts`

Live mode asks Tanya to solve the golden tasks:

`npx tsx scripts/grade-expertise.ts --run-live`

Use live mode after material pack changes, not after typo-only edits.

## Anti-patterns

- Bulk regenerating all packs at once. It loses surgical precision and breaks source provenance.
- Updating from framework docs alone while ignoring reference source.
- Updating without running the eval harness after behavior-affecting changes.
- Adding broad rules that make Tanya over-edit unrelated files.
- Letting a new pack rely on neither `implicitReason` nor complete frontmatter.
- Treating token-budget trimming as invisible. If a useful pack drops, change priority deliberately.
- Hiding source moves by replacing canonical paths with vague prose.
- Changing generated docs without committing the matching pack update.

## Future automation

The refresh skeleton is intentionally conservative. It scans pack files, audits canonical sources, reports missing or newer sources, and writes a plan.

The next automation layer should fill in the TODO hooks:

- `collectFrameworkVersions()` should query package registries and platform release feeds.
- `runEvalHarness()` should run live golden tasks and compare deltas.
- `proposeUpdates()` should generate focused candidate patches.
- `applyUpdates()` should write approved edits only behind explicit review gates.

The autonomous overnight prompt-engineering pattern used for wizard template audits could run this workflow on a schedule. It should produce a plan first, then wait for operator approval before editing packs.

## Release reminder

Before tagging a Tanya package release, verify that markdown packs are shipped. Either copy `src/skills/**/*.md` into `dist/skills/` during build or include the source markdown packs in `package.json#files`.
