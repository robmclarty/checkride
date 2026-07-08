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
  --only <a,b>  --skip <a,b>  --bail  --json  --changed  --all  --include <a,b>
checkride init         Set up a project (new or existing — auto-detected).
  --shape flat|monorepo|hybrid  --name <n>  --scope <@s>  --license <id>  --dry-run
checkride doctor       Verify environment + every slot's status (read-only, exit 0/1).
checkride fix          Run every active adapter's fix command (oxlint --fix, ...).
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
| `lint`     | Linting                                | `oxlint`            | `biome`, `eslint`|
| `struct`   | Structural rules (deep modules)        | `ast-grep`          | —                |
| `dead`     | Dead code, deps, cycles, boundaries    | `fallow`            | `knip`           |
| `test`     | Tests + coverage                       | `vitest`            | `jest`           |
| `docs`     | Markdown lint                          | `markdownlint-cli2` | —                |
| `links`    | Relative markdown links resolve        | built-in            | —                |
| `spell`    | Spelling                               | `cspell`            | —                |
| `mutation` | Mutation testing (opt-in)              | `stryker`           | —                |
| `security` | Dependency audit (opt-in)              | `pnpm audit`        | —                |

Zero-config: for each slot, checkride runs the first adapter whose config file
exists, and skips slots with no detected tool. The core has **no runtime
dependency** on any checked tool — it spawns `<pm> exec <tool>`; the project
owns the pinned tool versions.

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

To debug a failure: read `summary.json` to find the failing slot, then read that
slot's raw output for structured diagnostics.

## Configuration

`checkride.config.json` is optional — add it only to deviate from the defaults:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/robmclarty/checkride/v0.1.6/schema/checkride.config.schema.json",
  "timeout": 600,           // global per-check timeout in seconds (off by default)
  "checks": {
    "lint": "biome",        // pick an alternate adapter
    "spell": false,         // disable a slot
    "test": { "use": "vitest", "timeout": 0, "changedArgs": ["--changed", "origin/master"] },
    "format": {             // a custom check that runs FIRST, ahead of the built-ins
      "command": "pnpm",
      "args": ["exec", "biome", "format", "--write"],
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

A custom check (one keyed by a name that isn't a built-in slot) runs *after* the
built-in catalogue by default. Set `"order": "first"` to run it ahead of every
built-in check instead — handy for a formatter like `biome format --write` that
should normalize the tree before the linters and tests look at it. `"order":
"last"` is the explicit form of the default. Within each group, custom checks
run in the order they appear in the config.

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
