![A flight instructor evaluating a student pilot during a simulator checkride](./checkride_photo.png)

# checkride

**One command that tells a coding agent — and you — when the work is actually
done.**

checkride is an npm package that runs your whole verification pipeline as a
single command (`pnpm check`) whose exit code is the verdict, and mechanically
enforces module boundaries so parallel changes stay out of each other's way.
Together those give an LLM agent the two things it otherwise lacks: a
definition of done, and lanes to stay inside.

It is built first for TypeScript, but it is not TypeScript-only: built-in
checks stand down when their tool isn't in the repo, and custom checks run any
command — so the same gate works for a plain-JavaScript package, a
mixed-language monorepo, or a different ecosystem entirely (delivered through
npm either way, for now).

## The thesis

Agents are good at writing code and bad at knowing when to stop. Checkride fixes
both halves of that problem.

1. **A definition of done.** One command runs the whole verification pipeline —
   types, lint, structure, dead code, tests, docs, links, spelling. **Exit 0
   means the work is complete.** Agents stop guessing; humans stop re-reviewing
   half-finished work.
2. **Structured boundaries.** Code is organized into modules with narrow
   public surfaces. In the default layout, a module starts as a single file;
   when it grows internals worth hiding, it becomes a folder whose only public
   surface is its `index.ts`, and sibling modules import that index — never the
   internals. (These are [**deep modules**](./docs/deep-modules.md) —
   Ousterhout's term, from *A Philosophy of Software Design*, for a small
   interface hiding a substantial implementation.) checkride enforces this
   mechanically, which keeps each
   change inside one module's boundary and lets humans and agents work in
   parallel with minimal merge conflicts. Deep modules are checkride's default
   convention, not a hardcoded one — the rules are swappable ast-grep files in
   your repo, and the same slot enforces boundaries in other conventions and
   languages (see [Conventions](#conventions)).

One design choice to know up front: because the consumer of the output is an
LLM, checkride never normalizes diagnostics into a common format. Each tool
writes its own raw JSON to `.check/`, and the agent reads whatever the tool
emits. Skipping normalization deletes the adapter-maintenance layer that makes
traditional run-all-my-tools wrappers expensive to extend.

## Install

For an **existing repository**, install checkride (exact-pinned — see the
[pin policy](./docs/contract.md)) and let `init` adopt the tools you already
have:

```bash
pnpm add -D -E checkride
pnpm exec checkride init
```

For a **new project**, run `init` in an empty directory — no install first;
`dlx` fetches checkride, and the generated `package.json` pins it:

```bash
pnpm dlx checkride init --shape flat --name my-app
pnpm install
pnpm check
```

Both paths end in the same place — `init` auto-detects which case it is in.
It writes a `"check": "checkride"` script alias, so daily usage is `pnpm check`
regardless of the tool's name. It also writes the agent contract: an AGENTS.md
stanza stating the "exit 0 = done" rule, and **hooks** in your agent harness's
config — `.claude/settings.json` for Claude Code, `.cursor/hooks.json` for
Cursor. Three of them: a stop gate (a checkride-owned script that runs your
detected package manager's `run check --strict --digest` and blocks an agent
from finishing while the pipeline is red), an edit marker so turns that touched
no files skip the gate, and a guard that denies edits to
`checkride.baseline.json` and `.check/**`. Select hooks with `--hook <a,b>`
(gate | dirty | protect), harnesses with `--harness <a,b>` (claude | cursor;
detected by default), skip the hooks with `--no-hook`, or take an installed one
back out with `--remove-hook <a,b>`. To add all of this — alias, stanza, hooks,
and the Cursor skills — to a repo you already set up, run
`checkride agent-setup`.

Re-running either command refreshes the stanza in place, but never behind your
back: the marker carries a hash of what checkride wrote, so a stanza you have
since edited stops the run (exit 2) instead of being overwritten. Keep
repo-specific additions outside the markers, where nothing rewrites them — or
pass `--force` to discard the edits and refresh. A stanza written before the hash
existed is matched against the wordings checkride released, so upgrading is not
itself mistaken for an edit.

To add or remove a hook on its own, use `checkride hooks add <a,b>` /
`checkride hooks remove <a,b>`. It writes only the harness config and the
generated scripts, and never reads or writes AGENTS.md — managing a hook is not
managing your contract file, and an edited stanza does not stand in its way.

## Docs

Task-focused guides live in [docs/](./docs/README.md):

- [Why checkride](./docs/why.md) — the case for adopting it: what it's
  selling, the ROI versus ad-hoc scripts or a task runner, and answers to the
  common objections.
- [Getting started](./docs/getting-started.md) — prerequisites, adding
  checkride to a project (new or existing), your first run, and the daily loop.
- [Cheat sheet](./docs/cheatsheet.md) — one-screen reference for commands,
  flags, npm-script aliases, and the `.check/` output files.
- [Tools and installation](./docs/tools.md) — what each pipeline check runs,
  and how to install a missing tool when `doctor` reports one.
- [Running in CI](./docs/ci.md) — a copy-paste GitHub Actions recipe (and
  npm/yarn/bun variants), and why gates should pass `--strict`.
- [The contract](./docs/contract.md) — the surfaces consumers may rely on:
  exit codes, the `summary.json` schema discipline, flags, exports, and the
  pin policy.
- [The Claude Code plugin](./docs/plugin.md) — the bundled `/checkride:check`
  and `/checkride:qa` skills: install, what each one reads, and what they
  deliberately do not do.
- [Cursor](./docs/cursor.md) — what `agent-setup` writes for Cursor, where
  Cursor's hook API differs from Claude Code's, and the assumptions not yet
  verified against a live Cursor.
- [Reliability](./docs/reliability.md) — why checkride is safe to build a
  gate on.

Runnable counterparts live in [examples/](./examples/): standalone projects you
can install and run on their own, each demonstrating one thing — what an agent
reads when the gate is red, or how a repo with existing debt adopts checkride
without a cleanup project first. Each one declares the run it expects, and the
end-to-end suite asserts it on every push.

The rest of this README is the reference: the command surface, the pipeline
model, the `.check/` output contract, configuration, and the baseline.

## Commands

The pipeline is a sequence of **slots** — roles like `types`, `lint`, `test` —
each filled by an **adapter**, the concrete tool that runs it (the full
catalogue is [below](#the-pipeline-slots-and-adapters)). The commands refer to
both:

```text
checkride              Run the default checks. Exit 0 pass / 1 fail / 2 error.
  --only <a,b>  --skip <a,b>  --bail  --json  --changed  --all  --include <a,b>
  --digest  --strict (zero checks running = exit 2 — use wherever checkride gates)
checkride init         Set up a project (new or existing — auto-detected).
  --shape flat|monorepo|hybrid  --name <n>  --scope <@s>  --license <id>  --author <a>
  --add <a,b>  (existing mode) scaffold blessed configs for the named empty slots
  --baseline   (existing mode) grandfather current debt instead of disabling slots
  --force      (new mode) overwrite existing files instead of refusing
  --hook <a,b> write only these hooks (gate | dirty | protect)
  --no-hook    skip writing the agent hooks
  --remove-hook <a,b>  remove these installed hooks (entry + generated script)
  --harness <a,b> write them for these harnesses (claude | cursor; default: detected)
  --dry-run    plan only; write nothing
checkride doctor       Verify environment + every slot's status (read-only, exit 0/1).
checkride fix          Run every active adapter's fix command (oxlint --fix, ...).
checkride baseline     Record current diagnostics as a committed baseline.
checkride agent-setup  Add the "check" alias, AGENTS.md stanza + agent hooks to a repo.
  --hook <a,b> write only these hooks (gate | dirty | protect)
  --no-hook    skip the hooks (write only the stanza)
  --remove-hook <a,b>  remove these installed hooks; with --no-hook, remove only
  --harness <a,b> which harnesses to write for (claude | cursor; default: detected)
  --force      refresh a stanza that has local edits (refused otherwise)
checkride gate         Run the check script as a stop gate, answering a harness's
                       hook protocol. The generated hook scripts invoke this.
checkride triage       Triage a red gate: run it, then read .check/ as a bounded report.
checkride qa           Read the quality artifacts a previous run left.
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
| `struct`   | Structural rules (deep modules by default) | `ast-grep`      | —                |
| `dead`     | Dead code, deps, cycles, boundaries    | `fallow` (dead-code)| `knip`           |
| `dupes`    | Code duplication (opt-in)              | `fallow` (dupes)    | —                |
| `health`   | Complexity / maintainability (opt-in)  | `fallow` (health)   | —                |
| `test`     | Tests + coverage                       | `vitest`            | `jest`           |
| `docs`     | Markdown lint                          | `markdownlint-cli2` | —                |
| `links`    | Relative markdown links resolve        | built-in            | —                |
| `spell`    | Spelling                               | `cspell`            | —                |
| `mutation` | Mutation testing (opt-in)              | `stryker`           | —                |
| `security` | Dependency audit (opt-in)              | `pnpm audit`        | —                |
| `publint`  | Package publishing lint (opt-in)       | `publint`           | —                |
| `attw`     | Type resolution across module systems (opt-in) | `attw --pack`| —                |

Most of these tools you already know. The one unfamiliar name, `fallow`, is a
Rust-native codebase-analysis tool covering dead code, duplication, and
complexity; the [tools guide](./docs/tools.md) covers it and every other
adapter.

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

To **configure a slot without opting it in** — say, give `attw` a `--profile` but keep it
in the full sweep only — add `"optIn": true` to its entry: it stays out of the default run
and runs solely under `--all`/`--include <slot>`. The same field demotes a normally-default
slot (or a heavy custom check like `test:integration`) to full-sweep-only; `"optIn": false`
does the opposite, forcing a slot into the default run.

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

Every run writes to `.check/`. This is a public API for agents — the promised
surfaces (exit codes, summary shape, flags, exports) are spelled out in
[docs/contract.md](./docs/contract.md) and locked by a `test/contract/` suite.
The summary shape is published as a JSON Schema at
[`schema/checkride.summary.schema.json`](./schema/checkride.summary.schema.json);
fields are additive-only under a given `schema_version`.

- `summary.json` — the aggregate report:

  ```jsonc
  {
    "schema_version": 1,
    "timestamp": "…",
    "ok": true,
    "checks_run": 8, // checks that actually executed
    "total_duration_ms": 4200,
    "checks": [
      { "name": "lint", "adapter": "oxlint", "description": "…",
        "ok": true, "exit_code": 0, "duration_ms": 470, "output_file": "lint.json" }
    ]
  }
  ```

  `ok: true` with `checks_run: 0` means **nothing was verified** — every slot
  sat out (no tool detected, disabled, or skipped). That state is a **vacuous
  green**: a pass that verified nothing. The run warns loudly on stderr when it
  happens, and `--strict` turns it into exit 2, so a gate can never mistake
  "nothing ran" for "everything passed". Anything that gates on checkride (CI,
  commit hooks) should pass `--strict`.

- `<slot>.json` — the raw tool JSON when stdout parses as JSON; otherwise
  `<slot>.stdout.txt` / `<slot>.stderr.txt`. Tools that write their own files
  (vitest `--outputFile`, stryker) keep doing so.

When a [baseline](#baseline) masks a slot's findings, that check gains an additive
`"baselined": <n>` field counting the grandfathered diagnostics; it is absent on
runs with no baseline, so `schema_version` is unchanged.

- `digest.md` — written only under `--digest`: a **token-bounded** Markdown
  excerpt of the *failing* slots, so an agent working through a big red repo
  reads a capped index instead of every raw file. Each section lists the first
  findings (reusing the baseline fingerprint extractors, or a tail of raw text
  for slots without one) and links the authoritative `.check/<slot>.json`, which
  is never modified. The bound: **ten findings per slot, 8 kB overall** —
  roughly two thousand tokens; past the cap, remaining failing slots are named
  but not rendered. It **truncates, never normalizes**; a green run leaves no
  digest (any stale one is removed), so its presence always means "this run
  failed". It is a file, never stdout — the machine-output split holds.

To debug a failure: read `summary.json` to find the failing slot, then read that
slot's raw output for structured diagnostics. On a large repo, `--digest` writes
`digest.md` as a capped starting point.

## The Claude Code plugin

The package root is also a [Claude Code](https://claude.com/claude-code) plugin
— two skills that consume the contract above, bundled in the same npm package
and versioned with it:

```text
/plugin marketplace add robmclarty/agent-tools
/plugin install checkride@robmclarty
```

- **`/checkride:check`** — triage a red gate. It runs the repo's own `check`
  script, branches on the promised 0/1/2 exit split, and names **one root cause**
  plus what it is deliberately not reading. It covers the corners a summary read
  by hand gets wrong — exit 2 versus exit 1, vacuous green, a narrow run's green,
  `baselined` counts, `skipped` slots, `exit_code: -1`, stale artifacts — then
  opens exactly one raw file.
- **`/checkride:qa`** — read the quality signal. It folds `mutation.json`,
  `dead.json`, `dupes.json` and `health.json` into a report under 8 kB, runs
  nothing, and reports which dimensions were never measured rather than guessing
  at them.

Both are **readers**: no new command, no new flag, no config, no hook. They
exist because reading `.check/` by hand is unbounded (`mutation.json` is 2.2 MB
in this repo) and credulous (every run overwrites `summary.json`, so an
`ok: true` on disk may describe three of seventeen slots from a while ago). The
readers ship prebuilt in `dist/`, so installing the plugin needs no build step,
and they run without it too — `node node_modules/checkride/dist/triage/cli.js`
prints the same report. Full details in [docs/plugin.md](./docs/plugin.md).

## Configuration

`checkride.config.json` is optional — add it only to deviate from the defaults:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/robmclarty/checkride/v0.4.0/schema/checkride.config.schema.json",
  "extends": "@acme/checkride-preset", // inherit a shared preset, then override below
  "timeout": 1200,          // global per-check timeout in seconds (default: 600)
  "checks": {
    "format": "prettier",   // enable the opt-in format slot (blessed: prettier)
    "lint": "biome",        // pick an alternate adapter
    "spell": false,         // disable a slot
    "test": { "use": "vitest", "timeout": 0, "changedArgs": ["--changed", "origin/main"] },
    "tidy": {           // a bespoke custom check that runs FIRST, ahead of the built-ins
      "command": "pnpm",
      "args": ["exec", "some-formatter", "--write"],
      "order": "first"
    },
    "licenses": {           // a custom check (runs last by default)
      "command": "node",
      "args": ["scripts/check-licenses.mjs"],
      "description": "License audit",     // rendered beside the check in the output
      "note": "Legal asked for this in RFC-114; drop it when the SBOM job lands."
    }
  }
}
```

### `description` vs `note`

Two strings, deliberately not one. **`description`** is user-facing: it is the
text a run prints beside the check in its status line and records in
`.check/summary.json`, so it wants to be short. **`note`** is the opposite —
maintainer commentary that never renders anywhere, the JSON-comment this file
otherwise has no room for. Put "why is this check here", "revisit after the
2.0 upgrade", or a ticket number in `note` and keep the output readable.

`note` is accepted on any check entry — an adapter override (`{ "use": … }`) or
a custom check (`{ "command": … }`) — and at the top level of the file for a
note about the config as a whole. It is validated as a string (a typo is a
config error, not silence) and then dropped: no code path carries it onto an
adapter, so it cannot reach the CLI output or the summary.

### The `$schema` pointer

The `"$schema"` pointer is optional but recommended: it turns on validation and
autocompletion for `checkride.config.json` in editors that understand JSON
Schema (VS Code and friends). `checkride init` writes a version-pinned pointer
into the config it generates; the schema itself ships in the package at
[`schema/checkride.config.schema.json`](./schema/checkride.config.schema.json).

### Custom checks

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

### Gating a custom check with `detect`

Add `"detect": ["<file>", …]` to a custom check to gate it on marker files: it
runs only when at least one listed file exists in the repo, and is skipped —
skipped, not failed — otherwise. This keeps a shared config safe across repos
that don't all use the same tools: a check for a tool a given repo lacks quietly
stands down instead of lighting up red. `detect` applies only to custom checks
that run alongside the catalogue; a custom check that fills a built-in slot
always runs.

### Sharing presets with `extends`

Use `"extends"` to inherit a shared preset — a file path (`"./base.json"`) or an
installed package (`"@acme/checkride-preset"`), or an array of them to layer
several. Bases merge left to right and your local config wins over all of them:
objects deep-merge (so overriding one field of a check keeps the rest), while
arrays and scalars replace outright — arrays are **not** concatenated. Pair it
with `detect` above to publish one org-wide preset that stays safe across repos
that don't all use the same tools. An `extends` that can't be found, or a config
that extends itself in a loop, fails fast with
`invalid checkride.config.json: <reason>`.

For operating a preset across many repos — versioning it, rolling a rule out as
a release, and automating the per-repo bump — see
[Running a fleet with shared presets](./docs/presets.md).

### Timeouts

A per-check timeout guards against a hung tool, and it is **on by default**: a
definition-of-done gate that can hang forever fails its one job on the worst
day. The default cap is a generous **600 seconds per check**; a check that hits
it gets SIGTERM (then SIGKILL after a short grace) and is recorded as failed
with a `timed out after 600s` note — red, never vacuous. Tune it with a global
`timeout` (seconds), override it per check (`"timeout": <n>`), or set
`"timeout": 0` (globally or per check) to disable the cap. Give `dead`, `test`,
and `mutation` a higher cap — or `0` — on a large repo where they legitimately
run long.

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

Two operational notes. **Merge conflicts:** the file is canonical (slots and
keys are sorted), so parallel branches usually merge cleanly; when they do
conflict, resolve by keeping both sides' entries and running a full
`checkride` — the ratchet prunes anything already fixed, so an over-generous
union self-heals, while a dropped entry that still fails simply resurfaces as
a red check. **Deliberate re-baseline:** `checkride baseline` re-records
*everything* currently failing — including brand-new debt you might rather
fix — so treat re-running it as a reviewed change: do it deliberately (say,
after adopting a stricter rule set) and read the `checkride.baseline.json`
diff in the PR like code.

Only slots whose tool has a fingerprint extractor participate (currently `lint` via
oxlint, `struct` via ast-grep, `spell` via cspell, and the fallow slots `dead`/`dupes`/
`health`); other slots (`types`, `test`, …) never appear in the baseline. A crash or
empty output is never masked — a slot only goes green when there are findings and all
of them are grandfathered.

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

At runtime, checkride itself is workspace-agnostic: whatever the shape, it runs
each tool **once, from the repo root** — one pipeline, one `.check/`. Workspace
awareness comes from the tools' own configs, which is what the monorepo scaffold
sets up: `tsc --build` follows the root tsconfig's project references, and
vitest, oxlint, ast-grep, and the rest walk the whole tree. There is no
per-package orchestration and no way to check a single package — narrow a run
with `--only`/`--changed`, not per-directory.

## Conventions

`init` scaffolds one **default** convention — [deep
modules](./docs/deep-modules.md), whose boundaries are enforced by `ast-grep`
(the `struct` slot) and `fallow`:

- A module is a unit of encapsulation. A single file is a module; promote it to
  a folder with a barrel `index.ts` when it grows internals worth hiding — a
  one-file folder is just ceremony.
- A folder module's `index.ts` is its only public surface: it re-exports, it
  holds no logic. Siblings import it via `'../<sibling>/index.js'`, never its
  internals.
- Named exports only; no classes; `.js` extensions on relative imports
  (NodeNext); tests colocated with the code they cover.

None of this is hardcoded into checkride. The `struct` slot just runs whatever
ast-grep rules live in your repo's `rules/` directory (the barrel rule is
`rules/no-deep-sibling-import.yml`), so the convention is whatever those files
encode:

- **A different convention, same language.** Edit or replace the rules to match
  how your repo is organized — public/private folders, a naming prefix, an
  allowed-import list — and `struct` enforces the new shape unchanged.
- **Another language.** ast-grep is polyglot; set each rule's `language`
  (`typescript`, `python`, `go`, `rust`, …) and the same slot covers boundaries
  there.
- **Beyond ast-grep.** When a rule can't be expressed in ast-grep, or lives in
  another ecosystem's tooling (`import-linter`, `depguard`, `dependency-cruiser`),
  wire it as a [custom check](./docs/tools.md#when-to-write-a-custom-check).

checkride ships an opinionated default; it does not lock you to it.

## Tested envelope

Every push runs the full suite — unit, contract, and end-to-end (generated
projects, installed and checked for real) — on **macOS and Linux**, at **Node
22.18.0 (the exact supported floor) and Node 24**, and the e2e suite exercises
the full package-manager quartet: **pnpm, npm, yarn, and bun**. Windows is not
tested and not claimed; it waits for a real consumer who needs it.

The promised surfaces (exit codes, `summary.json` shape, flags, exports) are
locked by a dedicated [contract suite](./test/contract/) — see
[docs/contract.md](./docs/contract.md). Beyond line coverage (enforced at 70%),
the test suite is itself tested: Stryker mutation testing runs with a hard
floor of 55; the current mutation score is **69%** (`pnpm mutation` to
reproduce).

See [AGENTS.md](./AGENTS.md) for the contract agents follow,
[CONTRIBUTING.md](./CONTRIBUTING.md) for the release ritual, and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

## Programmatic API

The CLI is the primary interface, but every command is also a function. Import
from the package root to run the pipeline inside your own tooling; the result
carries the same summary written to `.check/summary.json`, plus the exit code the
CLI would return:

<!-- snippet: check -->
```ts
import { runChecks, type RunResult } from 'checkride';

const result: RunResult = await runChecks({ cwd: process.cwd(), strict: true });
process.exitCode = result.exitCode;
```

`runChecks` sits alongside `runInit`, `runDoctor`, `runFix`, and the
`loadConfig`/`resolveChecks` pair; the adapter registry (`SLOTS`, `ADAPTERS`) and
every public type are re-exported too. The full surface is the package's
`exports`, and it is part of the [contract](./docs/contract.md).

## License

[Apache-2.0](./LICENSE)
