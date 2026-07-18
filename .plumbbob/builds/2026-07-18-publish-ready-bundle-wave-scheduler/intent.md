# Publish-ready bundle + wave scheduler

**Phase**: frame
**Size:** medium

*Source: `/pb-plan` inline spec, 2026-07-18. Reference implementations studied in
`/Users/robmclarty/Projects/fascicle/code/fascicle/scripts/` (`check-doc-snippets.mjs`,
`build.mjs` smoke section, `check-publish.mjs`, `check-deps.mjs`).*

## Frame

- **Problem:** checkride's publishing support stops at static analysis — `publint`
  lints package.json declarations and `attw` checks type resolution, but nothing
  ever builds `dist/`, loads the built artifact, or inspects the packed tarball. A
  library can pass the full gate and still throw on `import`, ship its `src/` and
  tests in the tarball, or carry doc examples that no longer compile. The origin
  repo (`fascicle`) still runs four bespoke scripts to cover exactly these gaps.
  Separately, the orchestrator has no ordering vocabulary richer than
  `order: 'first' | 'last'` and runs everything sequentially — so "build before
  the artifact checks" cannot even be expressed, and wall-clock is left on the
  table in CI.
- **Smallest thing that solves it:** (B) generalize `order` to a **wave**
  vocabulary (numbers plus `'first'`/`'last'`/`'middle'`/`'single'`/`'any'` —
  D1): equal-value checks run concurrently in a bounded pool, values run in
  ascending order with a barrier between them, `--bail` falls back to today's
  sequential cheapest-first; then (A) add four **opt-in** slots — `build` (runs
  the consumer's build script, wave 10), `pack` (tarball dry-run content
  validation), `smoke` (runtime import of built entry points), `snippets` (tagged
  doc fences typecheck), the latter three in wave 20 alongside `publint`/`attw` so
  the publish-ready bundle orders itself out of the box.
- **Done looks like:**
  - `checkride --all` on a library runs build → artifact checks in that order and
    goes green only when the shipped package imports, packs cleanly,
    type-resolves, and its tagged doc snippets compile.
  - Default `checkride` run is byte-for-byte unchanged (all four slots opt-in;
    bumping checkride never turns a repo red on a check it didn't ask for).
  - A repo with no `order` anywhere runs its default-wave checks concurrently and
    still produces a deterministic, contract-valid `summary.json`.
  - `--bail` behaves as today: sequential, cheapest-first, stop at first failure.
  - checkride's own `checkride.config.json` has the bundle turned on and
    `checkride --all` is green on itself; each new slot's verdict matches its
    fascicle reference script on the fascicle repo (the oracle).
  - `pnpm check` exits 0 at every step boundary.
- **Explicitly NOT doing:**
  - No `needs: [...]` dependency DAG (see D8 — rejected in writing).
  - No normalization layer over tool diagnostics; the orchestrator persists raw
    output per check as today.
  - None of the four new slots joins the default run.
  - No yarn/bun `pack` adapters in this pass (unavailable-until-adapter, D10).
  - No snippet-tag variants (`expect-error`, per-fence modes) — `check` is the
    only marker, matching fascicle exactly.

## Architecture sketch

```
selection (--only/--skip/--include/--all)          ← unchanged, runs FIRST
        │
        ▼
effective order per check:
  config `order` (number | 'first'|'last'|'middle'|'single'|'any')
    ?? adapter.order ?? slot.order ?? 'any'
        │
        ▼
default run:                          --bail run:
  'first' group      ─ pool(N) ──▶     flat sort (D1 group order,
  numeric line, asc: equal values      catalogue pos, config key),
    = one concurrent group, barrier    one at a time, stop at first
    between values; 'any'/'middle'     failure (≡ today's order for
    join the 0 group (v1); build 10;   the default set); --concurrency
    publint attw pack smoke            ignored with a stderr note
    snippets-dist 20
  'single's — exclusive, one at a
    time, catalogue order (mutation)
  'last' group
        │
        ▼
summary.json: array in (group, catalogue pos, config key) order —
              deterministic, independent of completion interleaving
```

New slots (all `optIn: true`, no `fixArgs` → `checkride fix` skips them for free):

| Slot | Kind | Wave | Mechanism |
|---|---|---|---|
| `build` | spawned | 10 | `<pm> run build` (detected from `scripts.build`) |
| `pack` | built-in | 20 | pm pack `--dry-run --json` → require/deny file list |
| `smoke` | built-in | 20 | spawned `node` probe imports each `exports` subpath |
| `snippets` | built-in | `'any'` (src) / 20 (dist adapter) | tagged fences → `.check/doc-snippets/*.ts` → `<pm> exec tsc` |

## Decisions

- D1: Ordering lives in one `order` value — `order?: number | OrderString` on
  `Slot` with an `Adapter`-level override; effective order = config `order` ??
  `adapter.order` ?? `slot.order` ?? `'any'`. **Numbers** sit on a single
  line: sort ascending; checks with equal values run concurrently as one
  group (the bounded pool); a barrier sits between distinct values. Integers
  are the conventional wave numbers; decimals sequence steps within a wave
  (the `1` group runs before `1.1`, which runs before `1.2`); duplicated
  values — integer *or* decimal — run concurrently, uniformly and by design
  (equal value = same group; no validation error, a duplicate is the user's
  intent). **Strings**: `'first'` = one concurrent group before the numeric
  line; `'last'` = one after everything, singles included; `'middle'` =
  promised after every `'first'` and before every `'last'`, nothing more;
  `'any'` = no ordering promise at all (the default when omitted — catalogue
  and custom checks alike); `'single'` = exclusive — runs with nothing else
  in flight, after the numeric line and before the `'last'` group, one at a
  time in catalogue order. v1 scheduler realization: `'any'` and `'middle'`
  are both placed in the numeric-0 group — a conservative placement their
  weak promises permit, which also avoids `types`' `tsc --build` floating
  alongside a consumer build script that is usually *also* `tsc --build`;
  later versions may float `'any'` into idle pool slots without breaking any
  documented promise. Report order (feeds D7): firsts, numeric groups
  ascending, singles, lasts; within a group catalogue position, then config
  key order for customs — *because* scheduling stays declarative in the
  SLOTS/ADAPTERS tables, one sort rule covers waves, intra-wave sequences,
  and exclusivity, and the `snippets` slot needs two adapters with different
  orders (src=`'any'`, dist=20).
- D2: `'first'`/`'last'` keep exactly their existing meaning (before/after
  every other check), pinned by a backward-compat contract test. The one
  deliberate default change: a config-only custom check with **no** `order`
  now defaults to `'any'` (the main group) instead of the old implicit
  `'last'` — invisible in a sequential default run (within a group, customs
  sort after the catalogue members, same order as today), visible under
  concurrency or beside wave-10/20 slots; CHANGELOG Contract note, and
  `order: 'last'` restores the old placement — *because* one uniform
  omitted-default (`'any'`) is worth more than a customs-only carve-out.
- D3: `order` is honored everywhere an object-form config entry can carry it:
  `UseConfig` gains the field, and a catalogue-filling custom entry's
  previously documented-ignored `order` flips to honored (a plain-string
  entry can't carry one — use `{ use, order }`). A config that already set
  the ignored field changes behavior deliberately, CHANGELOG-noted —
  *because* a per-slot order override is the natural escape hatch and one
  rule beats slot-kind carve-outs.
- D4: Defaults: every existing catalogue slot `'any'`, except `mutation` =
  `'single'` (stryker saturates every core and its vitest-runner races the
  real vitest run's cache — exclusivity is correctness *and* the fastest
  schedule); `build` 10; `publint`, `attw`, `pack`, `smoke`, `snippets-dist`
  20; the `snippets` src adapter `'any'` — *because* the publish-ready bundle
  must order itself with zero config. Moving publint/attw to 20 is
  observationally safe: they already sit last in SLOTS order. Docs recommend
  gap numbering (10/20/30) so inserting a slot never forces a renumber.
- D5: Concurrency default `min(4, max(1, os.cpus().length − 1))`, overridable via
  a new `--concurrency <n>` flag (`1` = sequential; no separate `--sequential`
  alias) — *because* heavy checks (test, mutation, build) parallelize internally
  and oversubscription is worse than a conservative cap; one flag is enough.
- D6: `--bail` = flat sequential sort in D1's group order (firsts, numeric
  line asc, singles, lasts; catalogue position then config key within a
  group), stop at first failure — *because* fail-fast is incompatible with
  already-launched concurrent work, and for the default set (all `'any'`)
  this is exactly today's cheapest-first order. Even under `--bail`, `build` still precedes wave-20.
  With `--concurrency > 1` given alongside, `--bail` wins: the run is fully
  sequential and a one-line stderr note says the concurrency flag was ignored
  (not a usage error — the combination is safe, just slower; Q6).
- D7: `summary.json` array order = D1's group order (firsts, numeric asc,
  singles, lasts; catalogue position then config key within a group), collected
  deterministically regardless of completion interleaving; `total_duration_ms`
  becomes wall-clock of the run — *because* the summary must stay reproducible
  byte-shape under concurrency, and wall-clock is what the field honestly means
  (identical to the old sum whenever execution is sequential). Schema unchanged;
  contract.md carries the clarification.
- D8: **Rejected: a `needs: [...]` dependency DAG.** The only real dependency in
  the catalogue is "build before artifact checks", which one integer expresses.
  A DAG brings cycle detection, partial-failure propagation semantics, schema
  surface, and doc burden — disproportionate to checkride's ethos of declarative
  tables and a small orchestrator. Revisit only if waves prove too coarse;
  noted as a possible follow-up, not scaffolded for.
- D9: `smoke` is a **liveness** check, not a type check: spawn a `node` probe
  (never in-process — isolation, per-check timeout, and the existing
  SIGTERM→SIGKILL reaping apply) that `await import()`s each `exports` subpath's
  built entry and asserts (a) it loads without throwing, (b) every **value**
  export named in the matching dist `.d.ts` is present at runtime. Export names
  come from a conservative self-contained `.d.ts` scanner (no TypeScript
  dependency) that collects only unambiguous value exports (`export declare
  function/const/class/enum`, non-`type` `export { … }`) and errs toward
  under-collection — a missed name is a weaker assertion, never a false failure.
  Fallback if the scanner proves brittle against real-world `.d.ts` output:
  ship liveness-only and say so. Runtime *shapes* stay attw's job — the slots
  do not overlap. Probe resolution (Q9): imports go through package
  **self-reference** (`import '<pkg>/<subpath>'`), exercising the real
  `exports`-map resolution; a dual package is probed through both conditions —
  `await import()` for `import`, a `createRequire` call for `require` — inside
  the same probe process; v1 enumerates **literal** subpaths only, with
  wildcard (`./*`) and `null` entries skipped and counted in the JSON output.
- D10: `pack` v1 supports npm and pnpm (`pack --dry-run --json`, parsing
  `files[].path` per fascicle's `check-publish.mjs`); yarn/bun are
  unavailable-until-adapter, mirroring the pnpm-only `security` slot precedent.
  Required set is **derived from the manifest** (resolved `exports`/`main`/
  `types`/`bin` targets + `README.md`); deny list is fixed (`\.ts$` except
  `dist/**/*.d.ts(.map)`, `\.test\.`, `src/`, `test/`, `docs/`, `scripts/`,
  `.check/` and kin). No config knobs in v1 — *because* a repo with bespoke pack
  invariants writes a custom check (that's the documented path, D14). Pack
  spawns with `--ignore-scripts` (Q7): a bare `pack --dry-run` runs
  `prepack`/`prepare`, and the common `"prepack": "<build>"` would rewrite
  `dist/` mid-wave-20 under smoke/snippets-dist — flag support confirmed in
  the Q2 spike. The deny-list carve-out covers every declaration flavor:
  `dist/**/*.d.{ts,mts,cts}` plus their `.map`s (Q8).
- D11: `snippets` matches fascicle byte-for-byte so the origin repo adopts the
  slot verbatim: files = `README.md` + non-recursive `docs/*.md`; marker regex
  `/<!--\s*snippet:\s*check\s*-->/` on the line immediately above the fence;
  fence langs `ts`|`typescript` only; untagged fences skipped (counted, not
  errors); **zero tagged snippets = hard error** (fascicle exits 2 — opting in
  with nothing to check is misconfiguration, not vacuous green). Snippets are
  emitted verbatim (no preamble) to `.check/doc-snippets/<slug>__<n>.ts` with a
  generated tsconfig extending the repo's own, relaxing `verbatimModuleSyntax`,
  `isolatedModules`, `noPropertyAccessFromIndexSignature`; compile via spawned
  `<pm> exec tsc --noEmit -p`; failures append the `snippet -> source map:`
  legend mapping generated files back to `<doc>:<line>`.
- D12: `snippets` ships as two adapters on one slot — `snippets` (src mode,
  `'any'`, fast) and `snippets-dist` (wave 20, checks against built `.d.ts`) —
  *because* slot→adapter choice is checkride's existing config vocabulary
  (`"dead": "fallow"` precedent); config picks the mode by naming the adapter.
- D13: `build` = `<pm> run build` (canonical `pnpm`, translated per detected PM);
  `src/pm/translate.ts` learns to translate `pnpm run <script>` alongside the
  existing `pnpm exec <tool>` — *because* all four PMs support `run`, keeping
  the adapter table canonical-form-only.
- D14: fascicle's `check-deps.mjs` (manifest invariants: required optional peer
  deps, publishability) becomes the docs' worked example of a **custom check**
  — *because* it's genuinely repo-specific and demonstrates where the
  slot-catalogue boundary sits.
- D15: Dogfood + oracle close the loop: checkride's own config enables the
  bundle as first consumer, and each slot's verdict is diffed against its
  fascicle reference script run on fascicle before the slot is called done.
- D16: New built-ins follow the `links` contract: return `CheckOutcome` with
  machine JSON on `stdout`, human progress on `stderr`; the orchestrator
  persists to `.check/<outputFile>` via `persistOutput`. `devDeps: {}` for all
  four — zero new dependencies, core still never imports a checked tool.
  Built-ins that spawn children (pack, smoke, snippets) receive the
  orchestrator's spawn capability through the runner context, so every
  subprocess registers in `liveChecks` and inherits the timeout +
  SIGTERM→SIGKILL reaping — C6 holds by construction, and each spawning
  built-in carries a real-subprocess reaping test (Q11).
- D17: Human stderr progress under concurrency stays line-oriented and
  interleaved: the `▸ start` line at spawn, the status line at completion,
  each an atomic single line, no per-check buffering — *because* liveness
  beats tidiness (buffering worst-cases to silence until the slowest check
  ends), the summary is the ordered authority, and stderr shape is not
  contract-bound (Q13).
- D18: Detection widens with two declarative `Adapter` fields (Q10):
  `detectScript?: string` — the slot is available when `scripts.<name>`
  exists in package.json (`build` uses it; an opted-in `build` with no build
  script stands down as a skip with a named reason, never red) — and
  `detectDeps?: string[]` — a backup signal that activates the slot when a
  detect file exists OR a named package appears in
  dependencies/devDependencies. `detectDeps` is populated deliberately, only
  on adapters whose tool runs correctly with zero config (vitest, prettier,
  oxlint, knip, cspell — judged per adapter at step 4), never blanket —
  *because* a repo that installed a tool but never wrote its config file is
  opting in by dependency; the widened default-run activation is a
  deliberate, CHANGELOG-noted behavior change, and doctor names which signal
  matched.

## Constraints

- C1: Core keeps NO runtime dependency on any checked tool; every check spawns
  `<pm> exec <tool>` / `<pm> run <script>` or is a self-contained built-in.
  Package-manager-agnostic throughout.
- C2: stdout = machine output only (`--json` summary); human progress to stderr.
  Raw per-check output still lands in `.check/<name>.{json,txt}`; the
  orchestrator never normalizes diagnostics.
- C3: `.check/summary.json` stays additive-only under `schema_version` 1; the
  `test/contract/` suite must stay green (a deliberate contract change updates
  doc + test + CHANGELOG together, never quietly).
- C4: `--strict` / vacuous-green semantics hold: opt-in slots sitting out is not
  a silent pass; `checks_run` keeps meaning executed-only.
- C5: Exact-pin devDeps policy and the CLI flag contract are preserved
  (`--concurrency` is a deliberate, documented, contract-tested addition).
- C6: The detached-process-group + SIGTERM→SIGKILL reaping (`liveChecks`,
  `killGroup`, the `interrupted` latch) and per-check timeouts must hold for
  every concurrently-running check — the spawn/kill layer already supports N
  simultaneous groups; the scheduler may not weaken it.
- C7: Every step lands with `pnpm check` exit 0 — each increment is
  independently mergeable and the gate never goes red between steps.

## Steps

1. [ ] Order data model + `order` widening (no scheduler yet) — **done when:**
   `Slot`/`Adapter` carry `order?: number | string`; SLOTS populated per D4
   (`'any'` defaults, `mutation` `'single'`, `build` 10, artifact slots 20);
   config accepts `order: number | 'first'|'last'|'middle'|'single'|'any'` on
   every object-form entry (`UseConfig` gains the field; catalogue-filling
   entries honored per D3) with a friendly error on anything else, non-finite
   numbers included; JSON Schema `order` widened to `oneOf` [five-string enum,
   number]; execution still sequential but sorted in D1's group order (firsts,
   numeric asc with `'any'`/`'middle'` at 0, singles, lasts; catalogue
   position then config key within a group); unit tests pin the precedence
   chain (config > adapter > slot > `'any'`), the group sort (decimals
   sequence within a wave, duplicate values share a group), and the
   customs-default change per D2; full suite + contract suite green — the
   only visible diff for existing configs is the deliberate D2/D3 reorders,
   CHANGELOG'd at step 3.
   - seam: `src/adapters.ts`, `src/config.ts`, `schema/checkride.config.schema.json`, `src/__tests__/config.test.ts`, `src/__tests__/adapters.test.ts`
   - model: sonnet — data/schema widening fully specified by D1–D4
2. [ ] Concurrent wave scheduler + `--concurrency` — **done when:**
   `executeChecks` runs D1's group sequence — firsts, the numeric line
   ascending (equal values through a bounded pool, default per D5; barrier
   between distinct values; `'any'`/`'middle'` in the 0 group), `'single'`s
   exclusively one at a time in catalogue order, lasts; `--bail` takes the
   flat sequential path (D6; `--concurrency` ignored with a stderr note);
   `--concurrency <n>` parses and is contract-tested; summary array order and
   wall-clock `total_duration_ms` per D7; unit tests (via the injectable
   `runner` seam and a recording runner) prove intra-group overlap, the
   between-values barrier, decimal steps running sequentially, a `'single'`
   running with nothing else in flight, bail fail-fast sequencing, and
   deterministic summary order under randomized completion; a backward-compat
   contract test pins `order: 'first' | 'last'` behavior; real-subprocess
   tests confirm timeout + SIGTERM→SIGKILL reaping still hold with ≥2
   concurrent checks in flight.
   - seam: `src/orchestrator.ts`, `src/cli.ts`, `src/__tests__/orchestrator.test.ts`, `test/contract/flags.contract.test.ts`, `test/contract/` (new order-compat test)
   - model: opus — concurrency interleaved with the kill/reap path needs care
3. [ ] Scheduler docs + CHANGELOG — **done when:** `docs/contract.md` documents
   the widened `order`, `--concurrency`, and the `total_duration_ms`
   clarification; `docs/cheatsheet.md` replaces "cheapest-first" prose with the
   wave model + gap-numbering recommendation; CHANGELOG carries a **Contract**
   entry; `pnpm check` green (links/spell/docs checks pass).
   - seam: `docs/contract.md`, `docs/cheatsheet.md`, `docs/reliability.md`, `CHANGELOG.md`
   - model: sonnet — prose from settled decisions
4. [ ] `build` slot + detection widening — **done when:** slot (optIn, wave
   10) + adapter spawning `<pm> run build` per D13; `translateExec` (or
   sibling) handles `pnpm run <script>` for all four PMs with unit tests;
   `detectScript`/`detectDeps` land per D18 — `build` detects via
   `scripts.build` (opted-in but scriptless stands down as a skip), and
   `detectDeps` is populated for the configless-capable adapters; doctor
   shows `build` as opt-in and names which detection signal matched; raw
   output to `.check/build.txt`; unit tests cover script/dep/file detection
   precedence, the stand-down skip, translation, and a fixture-script run
   through the real-subprocess path.
   - seam: `src/adapters.ts`, `src/config.ts`, `src/pm/translate.ts`, `src/doctor.ts`, `src/__tests__/config.test.ts`, `src/__tests__/pm.test.ts`, `src/__tests__/doctor.test.ts`
   - model: sonnet — small, precedent-shaped addition
5. [ ] `pack` built-in — **done when:** `src/pack.ts` (builtin `'pack'`,
   dispatched in `defaultRunner` beside `links`) runs the detected PM's pack
   dry-run (npm/pnpm; yarn/bun → unavailable per D10), derives the required set
   from the manifest, applies the deny list with the `dist/**/*.d.ts` carve-out,
   and reports misses/violations as JSON on stdout (exit 1) per D16; unit tests
   over fixture manifests cover: all-required-present pass, missing required
   file, forbidden path (named pattern in the finding), carve-out honored,
   yarn/bun unavailable; wave 20 confirmed in adapters test.
   - seam: `src/pack.ts` (new), `src/adapters.ts`, `src/orchestrator.ts`, `src/__tests__/pack.test.ts` (new)
6. [ ] `smoke` built-in — **done when:** `src/smoke.ts` enumerates `exports`
   subpaths (fallback `main`), writes a probe script under `.check/`, spawns
   `node` on it (timeout + reaping apply), and fails on import-throw or a
   missing scanned value export per D9; the `.d.ts` scanner has direct unit
   tests including `export type` / `interface` exclusion and aliased
   re-exports; fixture-package tests cover: healthy dist passes, throwing
   module fails, missing named export fails, type-only export ignored,
   missing dist artifact fails with a "did build run?" hint.
   - seam: `src/smoke.ts` (new), `src/adapters.ts`, `src/orchestrator.ts`, `src/__tests__/smoke.test.ts` (new)
   - model: opus — the conservative d.ts scanner is the subtle surface
7. [ ] `snippets` extraction core (pure) — **done when:** `src/snippets.ts`
   exports pure functions for doc discovery (README + non-recursive `docs/*.md`),
   tag/fence parsing (exact regexes per D11), snippet emission naming
   (`<slug>__<n>.ts`), and tsconfig generation (extends + relaxations + mode
   paths); unit tests over fixture markdown pin: tag-on-previous-line only,
   `ts`/`typescript` fences only, untagged counted as skipped, zero-tagged →
   hard error, slug collisions impossible for distinct docs.
   - seam: `src/snippets.ts` (new), `src/__tests__/snippets.test.ts` (new)
   - model: opus — strong-assertion tests pin the tag semantics for fascicle parity
8. [ ] `snippets` adapters + execution — **done when:** builtin `'snippets'`
   wired with two adapters per D12 (`snippets` src wave 0, `snippets-dist` wave
   20); compile via spawned `<pm> exec tsc --noEmit -p` on the generated
   config; failure output includes tsc's raw text plus the source-map legend;
   src-mode path mapping per Q1's verdict; fixture-repo tests cover a passing
   snippet, a failing snippet (legend maps back to `<doc>:<line>`), and both
   modes.
   - seam: `src/snippets.ts`, `src/adapters.ts`, `src/orchestrator.ts`, `src/__tests__/snippets.test.ts`
9. [ ] init library bundle + doctor polish — **done when:** init's library path
   (and `--add`) can scaffold the publish-ready bundle (build, pack, smoke,
   snippets-dist + existing publint/attw) into `checkride.config.json`;
   `snippets-dist` is scaffolded only when at least one tagged fence is
   detected in README/docs — otherwise init prints the tag-syntax pointer
   instead of enabling a slot that hard-errors on zero snippets (Q12); doctor
   renders all four with correct opt-in enablement and detection notes
   (exports/files for smoke+pack, `scripts.build` for build, tagged fences for
   snippets); init + doctor unit tests updated.
   - seam: `src/init.ts`, `src/doctor.ts`, `src/__tests__/init.test.ts`, `src/__tests__/doctor.test.ts`
   - model: sonnet — wiring along existing rails
10. [ ] Slot docs + CHANGELOG — **done when:** `docs/tools.md` slot table gains
    the four rows (detect/install columns; install = none, built-in);
    `docs/cheatsheet.md` opt-in table updated; `docs/reliability.md` names the
    failure modes smoke/pack/snippets close ("passes publint+attw but throws on
    import", "ships src/ in the tarball", "doc examples rot"); a custom-check
    section works fascicle's `check-deps.mjs` as the example per D14; CHANGELOG
    entry for the four slots and the D18 detection widening (dep-without-config
    repos gain checks on upgrade); `pnpm check` green.
    - seam: `docs/tools.md`, `docs/cheatsheet.md`, `docs/reliability.md`, `CHANGELOG.md`
    - model: sonnet — prose from settled decisions
11. [ ] Dogfood + oracle — **done when:** checkride's own `checkride.config.json`
    enables build/pack/smoke/snippets-dist; `checkride --all` (self-hosted via
    `pnpm check -- --all` equivalent) is green on this repo; each slot run
    against the fascicle repo agrees with its reference script's verdict
    (including at least one deliberately-broken case per slot to confirm both
    sides go red together); discrepancies either fixed or recorded as verdicts.
    - seam: `checkride.config.json`, `README.md`, `.plumbbob/builds/2026-07-18-publish-ready-bundle-wave-scheduler/` (oracle notes)

## Open questions

- Q1: src-mode `snippets` path mapping — how does `import { x } from
  '<pkg-name>'` resolve against *source* without fascicle's hand-written map?
  Leading option: derive from the repo's own tsconfig `paths` when present, else
  the `src/index.ts` convention, else fail with a message recommending
  `snippets-dist` (which needs no mapping — package self-reference via `exports`
  resolves the built types). — *resolve by:* decide at step 8, after step 7's
  pure core makes the options concrete.
- Q2: does `pnpm pack --dry-run --json` emit the npm-compatible `files[].path`
  shape across the pnpm versions checkride supports? — *resolve by:* spike at
  step 5 (five-minute check against pnpm 9/10); fallback is npm-only v1 with
  pnpm repos shelling through `npm pack --dry-run --json` (spawned with
  `--ignore-scripts` per Q7/D10; no lockfile involvement).

## Verdicts

- Q6 → `--bail` wins over `--concurrency`: fully sequential, one stderr note,
  not a usage error (folded into D6).
- Q7 → `pack` spawns with `--ignore-scripts`; the "read-only" aside repaired
  (D10, Q2).
- Q8 → deny-list carve-out widened to `dist/**/*.d.{ts,mts,cts}` + maps (D10).
- Q9 → smoke probes via package self-reference, both conditions on dual
  packages, literal subpaths only (D9).
- Q11 → built-ins get the spawn capability via the runner ctx; their children
  join `liveChecks` reaping (D16).
- Q12 → D11's zero-snippets hard error retained; init gates the snippets-dist
  scaffold on detected tagged fences (step 9).
- Q13 → interleaved atomic progress lines, no per-check buffering (D17).
- Q3+Q4+Q5 → the order vocabulary, converged 2026-07-18 and folded into
  D1–D4: `order?: number | 'first'|'last'|'middle'|'single'|'any'`; equal
  numeric values (duplicate integers *and* decimals) run concurrently by
  design; omitted = `'any'` everywhere (customs' implicit `'last'`
  superseded, D2); v1 schedules `'any'`/`'middle'` as the 0 group;
  `'single'`s run after the numeric line, before `'last'`, one at a time in
  catalogue order; `mutation` is the only `'single'` default.
- Q10 → detection widening folded into D18: `detectScript` (build; scriptless
  stands down as a skip, not red) plus `detectDeps` as a backup signal,
  populated only for adapters whose tool runs correctly configless;
  activation widening CHANGELOG'd at step 10.
