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
  atomic.ts         atomic file writes (temp file + rename)
  agent-setup/      AGENTS.md stanza + Claude Code Stop hook
  baseline/         fingerprints, the committed baseline store, the ratchet
  digest/           token-bounded digest.md of the failing slots
  pm/               package-manager detection + command translation
  __tests__/        colocated unit tests
templates/          shape preset files + shared config templates + rules (shipped)
test/               cross-cutting fixture tests + the slow e2e suite
rules/              ast-grep structural rules (dogfooded here)
```

Same principle either way: a single file is a module; a module only becomes a
folder with a barrel `index.ts` when it grows internals worth hiding, and then
siblings reach only the index. Four modules (`agent-setup/`, `baseline/`,
`digest/`, `pm/`) have crossed that line; the rest are single files. The same
rules ship to consumer projects — see `templates/shared/rules/`.

## What NOT to do

- Do not disable a lint rule to pass the check. Use a scoped inline suppression with a reason, or discuss first.
- Do not add dependencies casually. Fallow will flag unused ones.
- Do not add a file that is not imported by something.
- Do not skip tests for new behavior.
- Do not bypass `pnpm check` by running individual tools and claiming done.
- Do not put logic in a barrel `index.ts` — re-export from a named file.
