# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, Cursor, Windsurf, Amp) operating in this repository.

This repository is `checkride` itself — the agent harness. It dogfoods every convention it enforces.

## The contract

**`pnpm check` is the single source of truth for "done".** If it exits 0, the work is complete. If it exits non-zero, it is not.

Before declaring a task finished:

1. Run `pnpm check`.
2. If it fails, read `.check/summary.json` to find which check failed.
3. Read the corresponding per-tool JSON (`.check/lint.json`, `.check/dead.json`, etc.) for structured diagnostics.
4. Fix the root cause, not the symptom.
5. Re-run `pnpm check`.

Never claim a task is done while `pnpm check` is red.

## Tight feedback loops

During iteration, use narrower commands:

```bash
pnpm check --bail              # stop at first failure
pnpm check --only types,lint   # just the fast checks
pnpm check --changed           # affected mode (tsc is incremental; vitest --changed origin/main)
pnpm test:watch                # watch-mode tests
pnpm exec tsc --build          # incremental type-check / build
```

Full `pnpm check` is for the final verification.

## Conventions

- **TypeScript strict.** No `any`, no `!` non-null assertions without justification.
- **No classes.** Enforced by `rules/no-class.yml`.
- **Named exports only.** Enforced by `rules/no-default-export.yml`.
- **File extensions:** import with `.js` from `.ts` files (NodeNext resolution). Enforced by `rules/require-js-extension.yml`.
- **No logic in barrels.** `index.ts` only re-exports (`export { x } from './x.js'`); functions and classes live in named files. Enforced by `rules/no-logic-in-barrel.yml`.
- **A single file does not need a folder.** Each module is a named file (`src/orchestrator.ts`), not a one-file folder.
- **Tests:** colocate `foo.test.ts` next to `foo.ts`; once a directory would hold more than two, move them to a sibling `__tests__/` folder.

## Repository layout

A single flat package. Named module files under `src/`, with `src/index.ts` as the package's barrel (the public programmatic surface).

```text
src/
  index.ts          barrel: re-exports the public API (no logic)
  cli.ts            arg parsing, command dispatch (the bin)
  orchestrator.ts   slot selection, spawning, .check/ writing
  adapters.ts       the registry (data-only)
  config.ts         checkride.config.json loading, resolution, detection
  init.ts           shape presets, existing-repo adoption, AGENTS stanza
  doctor.ts
  links.ts          built-in links check
  __tests__/        colocated unit tests
templates/          shape preset files + shared config templates + rules (shipped)
test/               cross-cutting fixture tests + the slow e2e suite
rules/              ast-grep structural rules (dogfooded here)
```

Same principle either way: a single file is a module; a module only becomes a
folder with a barrel `index.ts` when it grows internals worth hiding, and then
siblings reach only the index. The product's modules are one file each today, so
none are folders. The same rules ship to consumer projects — see
`templates/shared/rules/`.

## What NOT to do

- Do not disable a lint rule to pass the check. Use a scoped inline suppression with a reason, or discuss first.
- Do not add dependencies casually. Fallow will flag unused ones.
- Do not add a file that is not imported by something.
- Do not skip tests for new behavior.
- Do not bypass `pnpm check` by running individual tools and claiming done.
- Do not put logic in a barrel `index.ts` — re-export from a named file.

<!-- checkride:begin -->

## Checkride: the definition of done

`pnpm check` is the single source of truth for "done". Exit 0 means the work is
complete; any other exit code means it is not. Never claim a task is finished while
`pnpm check` is red.

When it fails:

1. Read `.check/summary.json` to see which check failed.
2. Read that check's raw output (`.check/<slot>.json` or `.check/<slot>.stdout.txt`).
3. Fix the root cause, then re-run.

Tight feedback loops: `pnpm check --bail`, `pnpm check --only types,lint`, and
`pnpm check --changed`.

If a Claude Code Stop hook is configured (`.claude/settings.json`), it runs the full
`pnpm check` as the final gate — so while iterating, prefer the narrow commands above
and let the hook run the authoritative pipeline once at the end rather than running
the full check yourself every loop.

### Baseline

If `checkride.baseline.json` is present, checkride grandfathers the diagnostics it
lists: a slot is green as long as only baselined findings remain, while a genuinely
new diagnostic still fails it. Fixing a baselined finding prunes it from the file —
the ratchet, so the baseline only ever shrinks. Never add to the baseline to make a
check pass; fix the finding.

### Module boundaries

A module is a unit of encapsulation. A single file is a module; promote it to a
folder with a barrel `index.ts` when it grows internals worth hiding. A folder
module's `index.ts` is its only public surface — re-exports only, no logic. Import
siblings through `'../<sibling>/index.js'`, never their internals.

Named exports only; no classes; `.js` extensions on relative imports.

Active checks in this repo: types, lint, struct, dead, test, docs, links, spell.

<!-- checkride:end -->
