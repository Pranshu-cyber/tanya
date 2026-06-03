---
slug: lang/python
title: Python
loadWhen:
  - kind: hint.language
    value: python
  - kind: workspace.has
    path: pyproject.toml
  - kind: workspace.has
    path: requirements.txt
  - kind: workspace.has
    path: setup.py
sizeTarget: 500
priority: 5
---
# Python
## When this applies
Use this for Python projects detected through pyproject.toml, requirements.txt, or setup.py.

## Core rules
- Prefer pyproject.toml as the source of project configuration.
- Use uv for dependency management and command execution when available.
- Keep application code under src/.
- Use pytest for testing.
- Add type hints to public functions, methods, and classes.
- Use pathlib.Path instead of os.path.
- Use dataclasses or Pydantic models for structured data.
- Keep functions small and testable.

## Common pitfalls
- MUTABLE-DEFAULT: Never use [] or {} as default arguments.
- BARE-EXCEPT: Avoid bare except clauses.
- IMPORT-SIDE-EFFECT: Avoid running application logic during import.
- TYPE-IGNORE-SPRAWL: Don't silence type errors unnecessarily.
- PYTHONPATH-HACKS: Prefer proper package structure over sys.path manipulation.

## House style

Reference projects use:
- pyproject.toml
- uv
- pytest
- type hints
- src/ package layout

## Verification commands
- uv run pytest
- python -m pytest
- uv run python -m pytest
- python -m compileall src
- uv run python -m compileall src

## Canonical sources

- pyproject.toml
- src/
- tests/
