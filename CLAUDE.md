# CLAUDE.md

Claude Code-specific instructions for this repository.

Read [AGENTS.md](./AGENTS.md) for the universal contract. This file only adds what is Claude-specific.

## Workflow

1. Plan in text first for any task larger than a typo. Reference files with full paths.
2. Implement with small, focused diffs.
3. Verify with `pnpm check`. Do not claim done until it exits 0.

## Tool use

- For faster iteration: `pnpm check --bail --only <checks>`, `pnpm check --changed` (affected-only), or `pnpm exec tsc --build`. Run the full `pnpm check` once at the end.
- The v1 build plan is complete and removed; build history lives in `.plumbbob/` and `CHANGELOG.md`. The surfaces consumers rely on are frozen in `docs/contract.md` and locked by `test/contract/` — a change that breaks a contract test is a breaking change (update the contract doc and CHANGELOG deliberately; never quietly edit the test).

## Skills

- **`/version <major|minor|patch>`** — bump the package version, summarize commits since the last release into a new `CHANGELOG.md` section, commit as `vX.Y.Z`, and create plus push an annotated tag. See `.claude/skills/version/SKILL.md`.
