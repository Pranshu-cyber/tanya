# Permissions

Tanya's permission layer is a pre-execution gate for tool calls. The engine
decides `allow`, `deny`, or `ask` before a tool reaches the filesystem, shell,
network, or a project-local command.

The first M3 release is intentionally compatible: default mode is `bypass`, so
existing `tanya run` automation keeps unrestricted behavior until a user opts
into stricter modes.

## File locations

User rules:

```text
~/.tanya/permissions.json
```

Project rules:

```text
.tanya/permissions.json
```

Project rules merge over user rules field-by-field. Arrays append by default.
If a config contains `"override": true`, that config replaces earlier arrays.

## Schema

```json
{
  "version": 1,
  "mode": "bypass",
  "alwaysAllow": [],
  "alwaysDeny": [],
  "alwaysAsk": [],
  "pathRules": [],
  "spendRules": []
}
```

Fields:

- `version`: must be `1`.
- `mode`: one of `bypass`, `default`, `ask`, or `plan`.
- `alwaysAllow`, `alwaysDeny`, `alwaysAsk`: rule strings in
  `tool:<regex>` form.
- `pathRules`: `{ "glob": "src/**", "action": "allow|deny|ask" }`.
- `spendRules`: `{ "type": "spend", "scope": "turn|run|session",
  "max_usd": 0.05, "max_tokens": 100000, "action": "deny|ask" }`.
- `override`: optional boolean for replacement merge behavior.

## Pattern format

Rule strings use:

```text
tool:<regex over JSON-stringified input shape>
```

The tool name is matched exactly before the colon. The regex matches the stable
JSON-stringified tool input without the surrounding `{}`. Regexes are not
implicitly anchored; use `^` and `$` if you need exact matches.

Example input:

```json
{"script":"git status --short","timeoutMs":30000}
```

Matching shape:

```text
"script":"git status --short","timeoutMs":30000
```

## Precedence

Most specific wins in this order:

1. `alwaysDeny`
2. `alwaysAllow`
3. `alwaysAsk`
4. `pathRules`
5. `spendRules`
6. Mode default

Mode defaults:

- `bypass`: allow without gating.
- `default`: consult rules; unmatched calls allow.
- `ask`: consult rules; unmatched calls ask.
- `plan`: deny all tool execution.

## Worked examples

### 1. Deny destructive shell commands

```json
{
  "version": 1,
  "mode": "default",
  "alwaysDeny": ["run_shell:.*rm -rf.*"]
}
```

### 2. Ask before package installs

```json
{
  "version": 1,
  "mode": "default",
  "alwaysAsk": ["run_shell:.*npm install.*"]
}
```

### 3. Allow read-only tools in ask mode

```json
{
  "version": 1,
  "mode": "ask",
  "alwaysAllow": ["read_file:.*", "list_files:.*", "search:.*"]
}
```

### 4. Deny production file writes by path pattern

```json
{
  "version": 1,
  "mode": "default",
  "pathRules": [
    { "glob": "src/**/*.production.ts", "action": "deny" }
  ]
}
```

### 5. Ask when a turn would exceed five cents

```json
{
  "version": 1,
  "mode": "default",
  "spendRules": [
    { "type": "spend", "scope": "turn", "max_usd": 0.05, "action": "ask" }
  ]
}
```

### 6. Project override for a trusted fixture workspace

```json
{
  "version": 1,
  "override": true,
  "mode": "bypass",
  "alwaysAllow": ["read_file:.*", "write_file:.*", "run_shell:.*"]
}
```

### 7. Plan mode for text-only review

```json
{
  "version": 1,
  "mode": "plan"
}
```

In plan mode Tanya denies every tool call and asks the model to return a written
plan instead of acting.

## Migration helper

`tanya permissions migrate` scans the last 100 `.tanya/runs/*.json` files and
prints a starter config to stdout:

```bash
tanya permissions migrate --cwd . > .tanya/permissions.suggested.json
```

Review the file before copying it to `.tanya/permissions.json`. The generated
config starts in `ask` mode and includes this built-in low-risk seed list:

```json
[
  "read_file:.*",
  "glob:.*",
  "list_files:.*",
  "run_shell:ls.*",
  "run_shell:git status.*",
  "run_shell:git diff.*"
]
```
