# Tanya Integrations

Tanya core can load optional integration content from an integrations root. The
public package builds and tests without this directory; integrations are additive.

## Root

By default, Tanya looks for `integrations/` at the package root. Set
`TANYA_INTEGRATIONS_DIR` to point at another root:

```bash
TANYA_INTEGRATIONS_DIR=/path/to/integrations tanya eval --suite acme --dry-run
```

The legacy `TANYA_INTEGRATIONS_DIR` alias is accepted for compatibility, but new
callers should use `TANYA_INTEGRATIONS_DIR`.

## Layout

Each integration owns one subdirectory:

```text
integrations/
  <name>/
    skills/
      *.md
    suites/
      *.json
    golden/
      *.json
    validators/
      *.json
```

- `skills/`: Markdown skill packs with the same frontmatter shape used by
  bundled packs. Discovered packs are loaded after bundled packs; if a discovered
  pack has the same slug as a bundled pack, the bundled pack wins.
- `suites/`: JSON eval suites with `{ "name", "version", "tasks" }`, matching
  the `EvalSuite` shape.
- `golden/`: JSON golden profiles. Files may contain one profile, an array, or
  `{ "profiles": [...] }`.
- `validators/`: JSON validator rule files. Current rule support covers the
  backend setup environment rule format used by the validator rule loader.

## Adding An Integration

1. Create `integrations/<name>/`.
2. Add only the content kinds the integration needs.
3. Validate discovery with targeted commands, for example:

```bash
TANYA_INTEGRATIONS_DIR=/path/to/integrations tanya eval --suite <suite-name> --dry-run
TANYA_INTEGRATIONS_DIR=/path/to/integrations tanya benchmark profiles
```

Integration content should not be required for Tanya core to typecheck, build,
or test.
