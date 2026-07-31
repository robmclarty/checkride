<!-- checkride:begin -->

## Checkride: the definition of done

`pnpm check` is the single source of truth for "done". Exit 0 means the work is
complete; any other exit code means it is not. Never claim a task is finished while
`pnpm check` is red.

When it fails:

1. Read `.check/summary.json` to see which check failed.
2. Read that check's raw output (`.check/<slot>.json` or `.check/<slot>.stdout.txt`).
3. Fix the root cause, then re-run.

`pnpm exec checkride triage` runs this procedure in full and reads `.check/` for you
(`/checkride:check` and `/checkride-check` are the same thing as a skill).

Tight feedback loops: `pnpm check --bail`, `pnpm check --only types,lint`, and
`pnpm check --changed`.

If a stop-gate hook is configured (`.claude/settings.json` or `.cursor/hooks.json`),
it runs the full `pnpm check` as the final gate — so while iterating, prefer the narrow
commands above and let the hook run the authoritative pipeline once at the end rather
than running the full check yourself every loop.

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

Active checks in this repo: types, lint, links.

<!-- checkride:end -->
