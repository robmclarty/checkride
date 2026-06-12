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
- **Unit tests colocated:** `foo.ts` and `foo.test.ts` in the same directory.

## Repository layout

A single flat package using the deep-modules layout under `src/`.

```text
src/                  the product, one deep module per first-level directory
  cli/                arg parsing, command dispatch (bin entry)
  orchestrator/       slot selection, spawning, .check/ writing
  adapters/           the registry (data-only)
  config/             checkride.config.json loading, resolution, detection
  init/               shape presets, existing-repo adoption, AGENTS stanza
  doctor/
  links/              built-in links check
templates/            shape preset files + shared config templates + rules
test/                 cross-cutting integration & e2e
rules/                ast-grep structural rules (dogfooded here)
scripts/              interim check orchestrator (removed once the CLI dogfoods)
```

Phase 0 ships only `src/index.ts`; the modules above land in later phases.

## Deep modules within `src/`

Every first-level directory under `src/` is a **module**. A module's `index.ts` is its only public surface. Sibling modules import each other via `'../<sibling>/index.js'`, never through internals. Enforced by `rules/no-deep-sibling-import.yml`.

## What NOT to do

- Do not disable a lint rule to pass the check. Use a scoped inline suppression with a reason, or discuss first.
- Do not add dependencies casually. Fallow will flag unused ones.
- Do not add a file that is not imported by something.
- Do not skip tests for new behavior.
- Do not bypass `pnpm check` by running individual tools and claiming done.
- Do not reach into a sibling module's internals (`'../other/internal.js'`) — go through its `index.ts`.
