# Example: a repo that isn't TypeScript

checkride is TypeScript-*first*, not TypeScript-only. This example is the
evidence: a Python service with no TypeScript in it at all, gated by the same
`checkride` command and the same one-command contract.

Three mechanisms carry it, and they are the same three any non-TypeScript repo
would use.

## Run it

You need `python3` on your PATH (3.11+). From the repo root, build checkride
once:

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/polyglot
pnpm install
pnpm check
```

It exits **0**:

```text
✔ py-syntax  Every Python source compiles
○ types      skip  no tool detected for slot
○ lint       skip  no tool detected for slot
○ dead       skip  no tool detected for slot
○ test       skip  no tool detected for slot
✔ links      Relative markdown link targets exist on disk
✔ py-test    The unittest suite passes
✔ struct     Structural rules (ast-grep)
```

## 1. Built-ins stand down

There is no `tsconfig.json` and no vitest here, so `types`, `lint`, `dead`, and
`test` report `no tool detected for slot` and sit out. **Skipped is not failed** —
the pipeline doesn't demand a TypeScript toolchain from a repo that has no
TypeScript.

The one thing to watch is that this makes a *vacuous* green possible: if every
slot stands down, `checkride` exits 0 having verified nothing. That is what
`--strict` is for — it exits 2 when zero checks ran, and it belongs anywhere
checkride is used as a gate. `.check/summary.json` reports `checks_run` for the
same reason.

## 2. `struct` is already polyglot

The `struct` slot runs [ast-grep](https://ast-grep.github.io), which parses far
more than TypeScript. Point a rule at another language and the same slot
enforces boundaries there — nothing about checkride changes:

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

Two rules ship here: no wildcard imports, and no `print` in library code. Prove
they bite — add this to `src/reporting.py` and run `pnpm check`:

```python
from pricing import *


def debug_cart(items: list) -> None:
    print("cart", items)
```

```text
✘ struct    2 error(s) found in code
```

The deep-modules convention checkride scaffolds by default is *a* rule set, not
a hardcoded one. `struct` runs whatever is in your `rules/` directory, in
whatever language you set.

## 3. Custom checks carry the ecosystem's own tools

Everything Python-specific is a custom check running the real tool:

```json
"py-test": {
  "command": "python3",
  "args": ["-m", "unittest", "discover", "-s", "tests", "-q"],
  "description": "The unittest suite passes",
  "detect": ["pyproject.toml"]
}
```

The contract is just the exit code, so anything that exits 0 on success
qualifies — `pytest`, `ruff`, `mypy`, `cargo clippy`, `go vet`, `terraform fmt`.
Output is captured under `.check/` exactly as the tool emitted it; checkride
never normalizes it, which is why adding a tool from another ecosystem costs a
config entry rather than an adapter.

Both checks here are gated on `detect: ["pyproject.toml"]`. In a single-language
repo that gate is redundant — it matters when this config is shared across a
fleet, so the Python checks stand down in the repos that aren't Python. See the
[`shared-preset`](https://github.com/robmclarty/checkride/tree/main/examples/shared-preset)
example.

## What this example does *not* claim

There is no Python adapter. `py-syntax` and `py-test` are ordinary custom
checks, which means no `doctor` integration, no `checkride fix` support, and no
baseline fingerprints — the baseline only covers slots whose adapter has a
fingerprint extractor.

What you get is the part that matters most: **one command whose exit code is the
definition of done**, in a repo checkride was not written for. Native adapters
for other ecosystems are a separate question from whether the harness works at
all.

Note that the toolchain is still delivered through npm — `package.json`,
`pnpm install`, and a linked `checkride`. A Python team adopting this takes on a
Node dependency for the harness itself.

## See also

- [Conventions — another language](https://github.com/robmclarty/checkride/blob/main/README.md#conventions)
- [When to write a custom check](https://github.com/robmclarty/checkride/blob/main/docs/tools.md#when-to-write-a-custom-check)
