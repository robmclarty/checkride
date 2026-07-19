# Step 11 — Dogfood + oracle notes

Closes the loop for D15: checkride's own `checkride.config.json` becomes the
publish bundle's first consumer, and each ported slot's verdict is diffed against
its fascicle reference script on the fascicle repo
(`/Users/robmclarty/Projects/fascicle/code/fascicle`), healthy **and** broken.

## Dogfood (checkride on itself)

`checkride.config.json` now enables the bundle: `"build": "build"`,
`"pack": "pack"`, `"smoke": "smoke"`, `"snippets": "snippets-dist"` (alongside the
pre-existing `publint`/`attw`). Naming a slot opts it into every run, so the full
publish bundle is now part of checkride's own definition of done.

- `pnpm check` (default, 17 checks incl. build → publint/attw/pack/smoke/snippets
  in wave order) — **green**, exit 0.
- `checkride --all --skip mutation` (full concurrent path incl. `security`) —
  **green**, exit 0.
- `checkride --all` including `mutation` (stryker) — **`mutation` times out at
  checkride's default 600s per-check cap** (killed by SIGTERM at 600032ms), so the
  literal `--all` is red *only* on that slot. This is pre-existing and orthogonal:
  `mutation` is not part of the publish bundle, is not in the merge gate
  (`pnpm check` default doesn't run it), and is normally run uncapped via
  `pnpm mutation` (README documents its 69% vs 55 floor, and recommends a higher /
  `0` timeout for it on repos where it runs long). Naming `mutation` in
  `checks` to give it a bigger timeout would opt it into *every* `pnpm check`
  (15+ min of stryker on the daily gate) — undesirable — so it is left as-is and
  recorded here. Verdict for the bundle: every publish-bundle slot plus every
  default and `security` check is green under `--all` (see
  `--all --skip mutation` below); mutation-vs-`--all`-timeout is a separate,
  pre-existing config question, flagged for a human decision.

### Bug found & fixed by dogfooding: `smoke` choked on `./package.json`

checkride's `exports` carries the near-universal `"./package.json":
"./package.json"`. `smoke` enumerated it as an importable subpath and the probe
did `await import('checkride/package.json')`, which fails —
`needs an import attribute of "type: json"`. `pack` and `attw` handle
`./package.json` fine; `smoke` was the outlier, and *any* consumer exposing
`./package.json` (the recommended pattern) would have hit the same false failure.

Fix (in `src/smoke.ts`, `entryToTarget`): skip a subpath whose resolved probe
target ends in `.json`, counted as `{ reason: 'json data subpath' }` — exactly
like the existing wildcard/`null` skips. A `.json` is data, not a runtime module,
and carries no value exports to assert. Added a unit test
(`enumerateExports` skips/counts `./package.json`) and updated the module doc.

> Seam note: this touched `src/smoke.ts` + `src/__tests__/smoke.test.ts`, beyond
> the literal step-11 seam (config/README/notes). It was required to meet the
> done-when ("`checkride --all` green on this repo"), which explicitly anticipates
> fixes; the alternative (dropping `./package.json` from `exports`) would be a real
> regression. Flagged for approval at the pause.

## Oracle (checkride slot vs fascicle reference, on fascicle)

Method: a throwaway `checkride.config.json` in fascicle selected the dist-mode
bundle slots; `checkride --only <slot>` ran there and the config was removed after
(fascicle's git stayed clean; `.check/` is gitignored). Each fascicle break was
reverted and, for smoke, a clean rebuild restored `dist/`.

### pack  ✔ agrees (healthy + broken)

- Reference: `scripts/check-publish.mjs` pack arm (`npm pack --dry-run --json`).
- Healthy: both **pass**, both enumerate the **same 32 files** (checkride via
  `pnpm pack --dry-run --json --config.ignore-scripts=true`).
- Broken (`dist/sneaky.ts` added): both **fail** and name the same offender —
  `dist/sneaky.ts (matched /\.ts$/)`.
- Design difference (no verdict divergence on real tarballs): checkride **derives**
  the required set from the manifest (`exports`/`main`/`types`/`bin` + README.md);
  fascicle **hardcodes** it and additionally requires `CHANGELOG.md`. fascicle
  ships `CHANGELOG.md`, so both agree. checkride's `.d.ts` carve-out is the broader
  superset (`dist/**/*.d.{ts,mts,cts}(.map)` vs fascicle's flat `dist/*.d.ts`).

### snippets (dist mode)  ✔ agrees (healthy + broken)

- Reference: `scripts/check-doc-snippets.mjs --dist`.
- Healthy: both **pass** — 12 tagged snippets compile against built `.d.ts`.
- Broken (a tagged `const x: number = '…'` snippet appended to fascicle README):
  both **fail** with the same diagnostic, `error TS2322: Type 'string' is not
  assignable to type 'number'`.
- Resolution difference (same result): checkride's dist mode uses **package
  self-reference** through `exports` (no `paths`); fascicle hand-writes `paths`
  to `dist/*.d.ts`. Both resolve to the same declaration files.

### smoke  ✔ agrees (healthy + broken)

- Reference: `scripts/build.mjs` smoke arm (rebuilds, then `await import()`s each
  dist subpath and checks a hardcoded expected-export list).
- Healthy: both **pass** — all 7 subpaths (`.`, `./adapters`, `./agents`, `./mcp`,
  `./otel`, `./stdio`, `./ui`) import cleanly.
- Broken (load-time `throw` injected into `src/index.ts`, so the rebuilt
  `dist/index.js` throws on import): both **fail**. checkride reports the `.`
  subpath `ok:false` (others still green) and exits 1; fascicle throws out of its
  smoke import and exits 2.
- Expectation-source difference (worth recording): checkride derives expected value
  exports by **scanning the built `.d.ts`** (conservative, self-updating); fascicle
  hardcodes `EXPECTED_NAMED`. A break that removes an export *from source* would
  make fascicle red (list mismatch) while checkride stays green (its expectation
  tracks the `.d.ts`) — not a bug, a deliberate design choice (D9). The chosen
  "both red" break (import-time throw) is orthogonal to this and agrees.
- Exit-code nuance: an import that throws is a check **failure** for checkride
  (exit 1) but an **orchestrator error** for fascicle (exit 2). Both are red;
  checkride additionally gives a per-subpath failure surface.

### build  — passthrough, no oracle divergence possible

`build` runs the consumer's own `<pm> run build` (D13) with no bespoke checkride
logic, so its verdict *is* the consumer's build script's verdict by construction —
there is nothing to diverge from a reference. Confirmed green on checkride's own
`tsc --build`.

## Outcome

All three ported built-ins (pack, smoke, snippets) agree with their fascicle
reference on both the healthy and the deliberately-broken case. The one real
discrepancy dogfooding surfaced (smoke vs `./package.json`) was **fixed**; the
remaining differences are intentional design choices, **recorded** above.
