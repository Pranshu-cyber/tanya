---
slug: platform-ops/packaging-cli
title: CLI Packaging Channels
loadWhen:
  - kind: hint.framework
    value: packaging-cli
  - kind: hint.framework
    value: homebrew
  - kind: hint.framework
    value: winget
  - kind: hint.framework
    value: scoop
sizeTarget: 500
priority: 9
---

# CLI Packaging Channels

## When this applies
Use this for publishing CLIs to npm, PyPI, crates.io, Homebrew, winget, scoop, Linux packages, or curl installers.

## Core rules
- npm packages need `bin`, semver, `files`, exports, and `npm pack --dry-run` proof.
- PyPI packages need `pyproject.toml`, `[project.scripts]`, wheel and sdist builds, and `twine check`.
- crates.io packages need complete metadata and `cargo publish --dry-run`; published crates cannot rely on local path deps.
- Homebrew formulas live in a tap repo with URL, sha256, version, install, and test blocks.
- winget manifests require signed installers and a PR to `microsoft/winget-pkgs`.
- scoop buckets use JSON manifests with checksums.
- Curl installers must pin checksums, support dry-run, and never auto-elevate to root.
- GitHub release assets include version, platform, and architecture in filenames.

## Common pitfalls
- No checksums: install scripts and package managers reject or weaken integrity.
- Hardcoded paths: formulas and manifests fail outside the author machine.
- Unsigned Windows installer: winget rejection.
- Cargo path deps: crates.io refuses unpublished local dependencies.

## House style
The V1 wizard has Homebrew endpoints for bridge build, npm publish, tap creation, formula update, and auth checks; keep those operations explicit.

## Verification commands
- `rg -n "\"bin\"|npm pack|pyproject.toml|cargo publish|Formula|winget|scoop" .`
- `rg -n "sha256|checksum|signed|osslsigncode" .`
- `rg -n "homebrew|npm-publish|create-tap|update-formula" .`

## Canonical sources
- ~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00011_backfill_verify_prompts.sql
- ~/workspaces/reference-platform-v3/api/internal/v1wizard/homebrew.go
