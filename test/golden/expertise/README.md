# Tanya Expertise Golden Tasks

This directory contains minimal golden fixtures for the lazy-loaded skill-pack system.
The fixtures are intentionally tiny: they only include files needed for workspace probes,
not complete runnable apps.

Any app names, package paths, and product shapes here are sanitized representative
fixtures for public testing. They are not copies of proprietary application code.

## Run

Validate fixture shape and matched skill packs:

```bash
npx tsx scripts/grade-expertise.ts
```

Run one task validation:

```bash
npx tsx scripts/grade-expertise.ts --task ios/add-feature-screen
```

Live grading is supported but intentionally not run during Phase 8:

```bash
npx tsx scripts/grade-expertise.ts --run-live
```

Live mode uses the local `dist/cli.js`; run `npm run build` first.

## Expected Checks

`expected.md` check cells use a small mechanical DSL:

- `report contains "text"`
- `report not-contains "text"`
- `report table columns "criterion,command,result"`
- `commands <= 5`
- `no modified files`
- `modified contains "path-fragment"`
- `rg "pattern" "path" matches`
- `rg "pattern" "path" no-match`
- `file exists "path"`
- `file not exists "path"`

The validate-only grader confirms every task has `fixture/`, `task.md`, `expected.md`,
required task sections, parseable criteria, anti-criteria counts, and a non-empty
skill-pack match set.
