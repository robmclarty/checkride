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
dependency** on any checked tool — it spawns `pnpm exec <tool>`; the project
owns the pinned tool versions.

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
  "checks": {
    "lint": "biome",        // pick an alternate adapter
    "spell": false,         // disable a slot
    "test": { "use": "vitest", "changedArgs": ["--changed", "origin/master"] },
    "licenses": {           // a custom check (no adapter needed)
      "command": "node",
      "args": ["scripts/check-licenses.mjs"]
    }
  }
}
```

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
