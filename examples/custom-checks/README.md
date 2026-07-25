# Example: custom checks

The built-in catalogue covers the tools most repos share. Everything else — the
rule that only makes sense in *your* codebase, the tool from another ecosystem,
the script someone wrote years ago — goes in as a **custom check**: any command,
placed where you want it in the pipeline.

This example has four, and they cover the three things worth knowing.

## Run it

From the repo root, build checkride once:

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/custom-checks
pnpm install
pnpm check
```

It exits **0**, and the run looks like this:

```text
✔ tidy           Normalize the JSON fixtures before anything else reads them
✔ types          TypeScript type checking
✔ lint           Oxlint
...
✔ openapi        The OpenAPI document parses and declares every route
○ terraform-fmt  skip  no detect file present
✔ licenses       Every installed dependency carries an allowed license
```

## 1. Running *before* the built-ins

[`scripts/normalize.mjs`](./scripts/normalize.mjs) rewrites `data/*.json` in
canonical form. It is declared with `"order": "first"`:

```json
"tidy": {
  "command": "node",
  "args": ["scripts/normalize.mjs"],
  "order": "first"
}
```

Custom checks run *after* the catalogue by default; `"first"` moves one ahead of
everything, which is what a formatter needs — normalize the tree, then let the
linters and tests read it. `"last"` is the explicit spelling of the default.

`tidy` lands at index 0 of `.check/summary.json`, and the end-to-end suite
asserts that, so the ordering claim is checked rather than asserted.

For ordinary formatting, prefer the blessed `format` slot (`"format":
"prettier"`) — `checkride fix` knows how to drive it. `order: "first"` is for
the one-off the slot doesn't cover.

## 2. Gating on marker files with `detect`

Two checks in this example are gated. One fires and one does not, which is the
whole demonstration:

```json
"openapi": {
  "command": "node",
  "args": ["scripts/validate-openapi.mjs"],
  "detect": ["openapi.json", "openapi.yaml"]
},
"terraform-fmt": {
  "command": "terraform",
  "args": ["fmt", "-check", "-recursive"],
  "detect": [".terraform.lock.hcl", "main.tf"]
}
```

`openapi.json` exists, so `openapi` runs. Neither Terraform marker exists, so
`terraform-fmt` is **skipped — not failed**:

```text
○ terraform-fmt  skip  no detect file present
```

Note what that skip is really proving: `terraform` is not installed here. Were
the gate not working, the check would try to spawn a binary that isn't there and
the run would go red. A green run *is* the evidence.

That is what makes `detect` the load-bearing piece of a shared preset: one
org-wide config can carry checks for every tool anyone uses, and each repo
quietly runs only its own subset. See the
[`shared-preset`](https://github.com/robmclarty/checkride/tree/main/examples/shared-preset)
example.

Two things to remember:

- **Entries are literal paths, not globs.** `"*.tf"` will never match; list real
  marker files (`Cargo.toml`, `go.mod`, `pyproject.toml`,
  `.terraform.lock.hcl`). Any one present is enough.
- **`detect` only gates checks that run alongside the catalogue.** A custom
  check that fills a built-in slot always runs.

## 3. Checking something no linter knows about

[`scripts/validate-openapi.mjs`](./scripts/validate-openapi.mjs) is the reason
custom checks exist. It reads the route table out of
[`src/routes.ts`](./src/routes.ts) and the paths out of
[`openapi.json`](./openapi.json), and fails if they disagree in either
direction:

```text
src/routes.ts serves /refunds, which openapi.json does not document
```

Try it — add `{ method: 'GET', path: '/refunds' }` to `ROUTES` and run
`pnpm check`. No general-purpose linter can catch that, because the rule is
about *this* repo's relationship between two files.

[`scripts/check-licenses.mjs`](./scripts/check-licenses.mjs) is the fourth
check: no `order`, no `detect`, so it runs after the catalogue with everything
else that has no opinion about when it goes.

## Writing your own

A custom check is any key in `checks` that isn't a built-in slot name:

```json
"my-check": {
  "command": "node",
  "args": ["scripts/thing.mjs"],
  "description": "Shown in the run output and in summary.json",
  "detect": ["marker-file"],
  "order": "first",
  "timeout": 120
}
```

The contract is only the exit code: **0 passes, anything else fails.** Write
diagnostics to stdout or stderr and checkride captures them under `.check/`
untouched — it never normalizes a tool's output, so there is no format to
conform to.

## See also

- [Custom checks reference](https://github.com/robmclarty/checkride/blob/main/README.md#custom-checks)
- [When to write a custom check](https://github.com/robmclarty/checkride/blob/main/docs/tools.md#when-to-write-a-custom-check)
