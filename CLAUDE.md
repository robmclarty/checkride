# CLAUDE.md

Claude Code-specific instructions for this repository.

Read [AGENTS.md](./AGENTS.md) for the universal contract. This file only adds what is Claude-specific.

## Workflow

1. Plan in text first for any task larger than a typo. Reference files with full paths.
2. Implement with small, focused diffs.
3. Verify with `pnpm check`. Do not claim done until it exits 0.

## Tool use

- For faster iteration: `pnpm check --bail --only <checks>`, `pnpm check --changed` (affected-only), or `pnpm exec tsc --build`. Run the full `pnpm check` once at the end.
- This project is being built in strict phases. See `plans/checkride-plan.md` for the build plan and gates.
