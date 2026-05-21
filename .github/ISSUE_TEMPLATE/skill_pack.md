---
name: Skill pack proposal
about: Propose a new skill pack or improve an existing one
title: "skill: "
labels: area:skills
assignees: ""
---

## Skill pack

- Proposed slug:
- Category: `lang`, `framework`, `domain`, `stack`, `platform-ops`, or
  `failure-modes`

## Why it should exist

What repeated workflow or failure mode should this pack improve?

## Loading signals

List the frontmatter conditions that should activate it:

- [ ] `workspace.has`
- [ ] `workspace.hasGlob`
- [ ] `workspace.packageJson`
- [ ] `hint.language`
- [ ] `hint.framework`
- [ ] `hint.stack`

## Token budget

- Target size:
- Why that budget is sufficient:

## Proposed guidance

Outline the rules, pitfalls, and verification commands the pack should contain.

## Acceptance criteria

- [ ] Frontmatter is valid and intentionally scoped.
- [ ] Loader tests cover the intended match behavior.
- [ ] Guidance stays within the declared token target.
