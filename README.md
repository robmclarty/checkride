![A flight instructor evaluating a student pilot during a simulator checkride](./checkride_photo.png)

# checkride

**An agent harness for TypeScript repositories**, delivered as one npm package.
It gives an LLM agent two things it otherwise lacks: a definition of done, and
lanes to stay inside.

## The thesis

Agents are good at writing code and bad at knowing when to stop. Checkride fixes
both halves of that problem.

1. **A definition of done.** One command runs the whole verification pipeline —
   types, lint, structure, dead code, tests, docs, links, spelling. **Exit 0
   means the work is complete.** Agents stop guessing; humans stop re-reviewing
   half-finished work.
2. **Structured boundaries.** A module is an encapsulation boundary with a
   narrow public surface. When one grows internals worth hiding it becomes a
   folder whose only public surface is its `index.ts`, and siblings reach only
   that index — never the internals. Enforced mechanically, boundaries keep
   agents inside lanes and let humans and agents work in parallel with minimal
   merge conflicts.

The consumer of the output is an LLM, so checkride never normalizes diagnostics
into a common format. Each tool writes its own raw JSON to `.check/`; the agent
reads whatever the tool emits. That deletes the layer that makes every prior
meta-runner expensive to extend.

## Install

```bash
pnpm add -D checkride
pnpm exec checkride init   # set up a project (new or existing, auto-detected)
```

`init` writes a `"check": "checkride"` alias, so daily usage is `pnpm check`
regardless of the tool's name.

## Commands

```text
checkride              Run the default checks. Exit 0 pass / 1 fail / 2 error.
  --only <a,b>  --skip <a,b>  --bail  --json  --changed  --all  --include <a,b>  --digest
checkride init         Set up a project (new or existing — auto-detected).
  --shape flat|monorepo|hybrid  --name <n>  --scope <@s>  --license <id>  --dry-run
  --baseline   (existing mode) grandfather current debt instead of disabling slots
checkride doctor       Verify environment + every slot's status (read-only, exit 0/1).
checkride fix          Run every active adapter's fix command (oxlint --fix, ...).
checkride baseline     Record current diagnostics as a committed baseline.
```

During iteration, narrow the loop: `checkride --bail`, `checkride --only
types,lint`, `checkride --changed`.

Output streams: human-readable progress goes to stderr; stdout carries machine
output only — the summary JSON under `--json`, mirroring `.check/summary.json`.
So `checkride --json` produces clean JSON on stdout that is safe to pipe, and the
default run leaves stdout empty.

## The pipeline: slots and adapters

A **slot** is a role in the pipeline (order matters — cheapest first). An
**adapter** is a concrete tool that fills a slot. There is one blessed default
per slot; alternates are wired so checkride can run them, but `init` only
generates config for the blessed default.

| Slot       | Role                                   | Blessed default     | Alternates       |
| ---------- | -------------------------------------- | ------------------- | ---------------- |
| `types`    | Type checking                          | `tsc --build`       | —                |
| `format`   | Formatting (opt-in)                    | `prettier`          | `biome`          |
| `lint`     | Linting                                | `oxlint`            | `biome`, `eslint`|
| `struct`   | Structural rules (deep modules)        | `ast-grep`          | —                |
| `dead`     | Dead code, deps, cycles, boundaries    | `fallow`            | `knip`           |
| `test`     | Tests + coverage                       | `vitest`            | `jest`           |
| `docs`     | Markdown lint                          | `markdownlint-cli2` | —                |
| `links`    | Relative markdown links resolve        | built-in            | —                |
| `spell`    | Spelling                               | `cspell`            | —                |
| `mutation` | Mutation testing (opt-in)              | `stryker`           | —                |
| `security` | Dependency audit (opt-in)              | `pnpm audit`        | —                |
| `publint`  | Package publishing lint (opt-in)       | `publint`           | —                |
| `attw`     | Type resolution across module systems (opt-in) | `attw --pack`| —                |

Zero-config: for each slot, checkride runs the first adapter whose config file
exists, and skips slots with no detected tool. The core has **no runtime
dependency** on any checked tool — it spawns `<pm> exec <tool>`; the project
owns the pinned tool versions.

**Opt-in slots** (`format`, `mutation`, `security`, `publint`, `attw`) stay out of the
default run so adopting checkride — or bumping its version — never turns a repo red on a
check it didn't ask for. Turn one on with `--include <slot>` (or `--all`), or by **naming
it in `checks`**: an explicit entry like `"format": "prettier"` opts the slot into every
run. `checkride fix` then runs its write form (e.g. `prettier --write`) alongside the
other fixers. `format` sits before `lint` so the tree is tidy before the linters look.

`publint` and `attw` are the **library-publishing** pair — turn them on for a package you
ship to npm to make "the published artifact is correct" part of your definition of done.
`publint` lints `package.json`'s publishing surface (exports, files, types); `attw` runs
`attw --pack` to check that your types resolve under every module system (`--format json`,
captured to `.check/attw.json`). Both stay opt-in so apps that never publish don't run
them.

### Package managers

checkride is package-manager-agnostic. It detects the repo's package manager
from the `packageManager` field or the lockfile (`pnpm-lock.yaml`,
`package-lock.json`, `yarn.lock`, `bun.lock`), defaulting to **pnpm**, and
translates each adapter's canonical `pnpm exec <tool>` into that manager's form
(`npx`, `yarn`, or `bunx`). The default pnpm run is unchanged; `doctor` reports
the detected manager. One exception: the opt-in `security` slot is `pnpm audit`,
whose flags and JSON shape are pnpm-specific, so it is **unavailable on a
non-pnpm manager** until a per-manager audit adapter lands.

## The `.check/` contract

Every run writes to `.check/`. This is a public API for agents; treat schema
changes as breaking.

- `summary.json` — the aggregate report:

  ```jsonc
  {
    "schema_version": 1,
    "timestamp": "…",
    "ok": true,
    "total_duration_ms": 4200,
    "checks": [
      { "name": "lint", "adapter": "oxlint", "description": "…",
        "ok": true, "exit_code": 0, "duration_ms": 470, "output_file": "lint.json" }
    ]
  }
  ```

- `<slot>.json` — the raw tool JSON when stdout parses as JSON; otherwise
  `<slot>.stdout.txt` / `<slot>.stderr.txt`. Tools that write their own files
  (vitest `--outputFile`, stryker) keep doing so.

When a [baseline](#baseline) masks a slot's findings, that check gains an additive
`"baselined": <n>` field counting the grandfathered diagnostics; it is absent on
runs with no baseline, so `schema_version` is unchanged.

- `digest.md` — written only under `--digest`: a **token-bounded** Markdown
  excerpt of the *failing* slots, so an agent working through a big red repo
  reads a capped index instead of every raw file. Each section lists the first few
  findings (reusing the baseline fingerprint extractors, or a tail of raw text
  for slots without one) and links the authoritative `.check/<slot>.json`, which
  is never modified. It **truncates, never normalizes**; a green run leaves no
  digest (any stale one is removed), so its presence always means "this run
  failed". It is a file, never stdout — the machine-output split holds.

To debug a failure: read `summary.json` to find the failing slot, then read that
slot's raw output for structured diagnostics. On a large repo, `--digest` writes
`digest.md` as a capped starting point.

## Configuration

`checkride.config.json` is optional — add it only to deviate from the defaults:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/robmclarty/checkride/v0.1.6/schema/checkride.config.schema.json",
  "extends": "@acme/checkride-preset", // inherit a shared preset, then override below
  "timeout": 600,           // global per-check timeout in seconds (off by default)
  "checks": {
    "format": "prettier",   // enable the opt-in format slot (blessed: prettier)
    "lint": "biome",        // pick an alternate adapter
    "spell": false,         // disable a slot
    "test": { "use": "vitest", "timeout": 0, "changedArgs": ["--changed", "origin/master"] },
    "tidy": {           // a bespoke custom check that runs FIRST, ahead of the built-ins
      "command": "pnpm",
      "args": ["exec", "some-formatter", "--write"],
      "order": "first"
    },
    "licenses": {           // a custom check (runs last by default)
      "command": "node",
      "args": ["scripts/check-licenses.mjs"]
    }
  }
}
```

The `"$schema"` pointer is optional but recommended: it turns on validation and
autocompletion for `checkride.config.json` in editors that understand JSON
Schema (VS Code and friends). `checkride init` writes a version-pinned pointer
into the config it generates; the schema itself ships in the package at
[`schema/checkride.config.schema.json`](./schema/checkride.config.schema.json).

Use `"extends"` to inherit a shared preset — a file path (`"./base.json"`) or an
installed package (`"@acme/checkride-preset"`), or an array of them to layer
several. Bases merge left to right and your local config wins over all of them:
objects deep-merge (so overriding one field of a check keeps the rest), while
arrays and scalars replace outright — arrays are **not** concatenated. Pair it
with `detect` above to publish one org-wide preset that stays safe across repos
that don't all use the same tools. An `extends` that can't be found, or a config
that extends itself in a loop, fails fast with
`invalid checkride.config.json: <reason>`.

A custom check (one keyed by a name that isn't a built-in slot) runs *after* the
built-in catalogue by default. Set `"order": "first"` to run it ahead of every
built-in check instead — handy for a **bespoke** formatter that should normalize
the tree before the linters and tests look at it. `"order": "last"` is the explicit
form of the default. Within each group, custom checks run in the order they appear
in the config.

For formatting, the blessed `format` slot (prettier, or biome) is the paved road —
enable it with `"format": "prettier"` and `checkride fix` writes formatting for you.
The `order: "first"` custom-check hatch coexists with it, for a one-off formatter the
slot doesn't cover; the slot didn't retire it.

Add `"detect": ["<file>", …]` to a custom check to gate it on marker files: it
runs only when at least one listed file exists in the repo, and is skipped —
skipped, not failed — otherwise. This keeps a shared config safe across repos
that don't all use the same tools: a check for a tool a given repo lacks quietly
stands down instead of lighting up red. `detect` applies only to custom checks
that run alongside the catalogue; a custom check that fills a built-in slot
always runs.

A per-check timeout guards against a hung tool. It is **off by default** — a cap
short enough to catch a hang on a small repo is short enough to kill a legitimate
slow run on a large one, and CI job timeouts already bound true hangs. Set a
global `timeout` (seconds) to opt in, override it per check (`"timeout": <n>`),
and use `"timeout": 0` to exempt a slot. Leave `dead`, `test`, and `mutation`
generous or uncapped — they legitimately run long.

## Baseline

Adopting checkride on an existing repo shouldn't be a cleanup project. A
**baseline** grandfathers the diagnostics a repo has *today* so day-one runs pass,
while any *new* diagnostic still fails — "don't make it worse" as the definition of
done for legacy code.

```bash
checkride baseline        # record current diagnostics into checkride.baseline.json
```

`checkride.baseline.json` lives at the repo root beside `checkride.config.json` and
**is committed** — it must be in version control to work. It records a per-slot set
of stable *fingerprints* (a `file:rule:message` key that survives line moves), not
raw output:

```jsonc
{
  "schema_version": 1,
  "slots": {
    "lint":  ["src/legacy.ts:no-explicit-any:Unexpected any"],
    "spell": ["docs/old.md::teh"]
  }
}
```

Once it exists, every normal run is **baseline-aware**:

- Each slot's current findings have the grandfathered ones subtracted. A slot is
  **green when only baselined findings remain**, and **fails listing only the new
  ones** — the raw `.check/<slot>.json` still holds everything, and the failing
  check gains a `"baselined": <n>` count.
- The baseline is a **ratchet**: fixing a grandfathered finding prunes it from the
  file (it only ever shrinks), so debt can't silently creep back. A partial run
  (`--only`, `--skip`, `--changed`, or a `--bail` that stops early) never prunes —
  it can't tell an unobserved finding from a fixed one, so it leaves the baseline
  untouched.
- Never add to the baseline to make a check pass; fix the finding, or re-run
  `checkride baseline` deliberately to re-grandfather.

Only slots whose tool has a fingerprint extractor participate (currently `lint` via
oxlint, `struct` via ast-grep, `spell` via cspell); other slots (`types`, `dead`,
`test`, …) never appear in the baseline. A crash or empty output is never masked —
a slot only goes green when there are findings and all of them are grandfathered.

To adopt on an existing repo, `checkride init --baseline` grandfathers today's
failing (fingerprintable) slots into the baseline and keeps them enabled, instead of
writing them off as `false`; a failing slot with no extractor still falls back to a
disable.

## Project shapes

`init` scaffolds three shapes. They share everything except `tsconfig.json`,
`fallow.toml`, and `pnpm-workspace.yaml`:

- **flat** — a single package using the deep-modules layout under `src/`.
- **monorepo** — a pnpm workspace of `apps/*` (deployable leaves) and `libs/*`
  (reusable internals); libs may not import from apps.
- **hybrid** — a root app in `src/` plus internal packages under `packages/*`.

Every generated shape is green out of the box — an end-to-end test enforces it.

## Conventions

Module boundaries, enforced by `ast-grep` and `fallow`:

- A module is a unit of encapsulation. A single file is a module; promote it to
  a folder with a barrel `index.ts` when it grows internals worth hiding — a
  one-file folder is just ceremony.
- A folder module's `index.ts` is its only public surface: it re-exports, it
  holds no logic. Siblings import it via `'../<sibling>/index.js'`, never its
  internals.
- Named exports only; no classes; `.js` extensions on relative imports
  (NodeNext); tests colocated with the code they cover.

See [AGENTS.md](./AGENTS.md) for the contract agents follow, and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

[MIT](./LICENSE)
