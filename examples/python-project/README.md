# Example: a Python project on the python pack

A small Python service checked by checkride's python pack, with no TypeScript
and no `package.json` in it. checkride picks a repo's implicit pack from the
markers at its root, and a `package.json` would come first, so with only a
`pyproject.toml` here the python pack's checks run under their bare slot
names: `lint`, `types` and `test`.

## Run it

You need `uv` on your `PATH`, and `ast-grep` for the `struct` rules;
`mise install` at the repo root installs the versions this repo pins. Build
checkride once from the repo root, since the example runs the working tree
rather than a published release:

```bash
pnpm install && pnpm build
```

Then sync the project's environment, which is the one step that needs the
network, and check it:

```bash
cd examples/python-project
uv sync
node ../../dist/cli.js
```

It exits **0**:

```text
✔ struct    Structural rules (ast-grep)  [detected: sgconfig.yml]
✔ lint      ruff: Python lint  [detected: pyproject.toml: [tool.ruff.lint]]
✔ links     Relative markdown link targets exist on disk  [built-in]
✔ lockfile  uv.lock matches pyproject.toml  [custom]
✔ types     mypy: Python type checking  [detected: pyproject.toml: [tool.mypy]]
✔ test      pytest: Python tests  [detected: pyproject.toml: [tool.pytest.ini_options]]
```

## 1. The pack finds the tools from `pyproject.toml`

Nothing in `checkride.config.json` names ruff, mypy or pytest. Each is
detected by its table in `pyproject.toml`, `[tool.ruff.lint]`, `[tool.mypy]`
and `[tool.pytest.ini_options]`, and the summary's `detected_by` names the
header it found.

`uv.lock` pins all three as dev dependencies, so each check runs the copy
`uv sync` installed into `.venv`, never one on `PATH`, and records
`pin_source: "uv-lock"` with the version the lock pins. Every check runs with
`UV_OFFLINE=1` and `PIP_NO_INDEX=1`, so nothing downloads during a run, and
with `PYTHONDONTWRITEBYTECODE=1`, so nothing writes `__pycache__` into the
checkout. Skip `uv sync` and the checks fail naming it, rather than reach for
another copy.

## 2. `struct` is already polyglot

The `struct` slot runs [ast-grep](https://ast-grep.github.io), which parses far
more than TypeScript. Point a rule at Python and the same slot enforces
boundaries there:

```yaml
# rules/no-star-import.yml
id: no-star-import
language: python
severity: error
files:
  - src/**/*.py
rule:
  pattern: from $MODULE import *
```

Two rules ship here: no wildcard imports, and no `print` in library code.

## 3. A custom check carries what no pack ships

`lockfile` runs `uv lock --check`, which fails when `pyproject.toml` asks for
something `uv.lock` doesn't hold. No pack ships it, so it's a custom check: any
command whose exit code means pass or fail fits, and its output is captured
under `.check/` exactly as the tool printed it.

```json
"lockfile": {
  "command": "uv",
  "args": ["lock", "--check"],
  "description": "uv.lock matches pyproject.toml"
}
```

## Prove each check bites

`expected.json` plants one violation per check, and the examples suite runs
each: an unused import fails `lint`, a function that returns the wrong type
fails `types`, a broken assertion fails `test`, a `print` in `src/` fails
`struct`, and a dependency added to `pyproject.toml` without `uv lock` fails
`lockfile`.

## See also

- [Packs and pins: the python pack](https://github.com/robmclarty/checkride/blob/main/docs/packs.md#the-python-pack)
- [When to write a custom check](https://github.com/robmclarty/checkride/blob/main/docs/tools.md#when-to-write-a-custom-check)
