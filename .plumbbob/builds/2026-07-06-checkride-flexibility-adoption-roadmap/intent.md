# checkride: flexibility & adoption roadmap

**Phase:** frame
**Size:** medium (a roadmap of independently-shippable increments)

## Frame

- **Problem:** checkride v1 is a solid runner, but what limits *who picks it up
  and keeps using it* is not a missing check — it's adoption friction and
  inner-loop cost. Two friction points dominate: (1) every adapter hard-codes
  `pnpm` and `engines` demands pnpm ≥9, excluding most of the TypeScript world at
  the door; (2) an existing repo lights up red on day one (dead-code, struct,
  spell), so "adopt checkride" is a cleanup project, not one command. The check
  catalogue is already strong; the leverage is in flexibility and adoption.
- **Smallest thing that solves it:** a sequence of small, independently-shippable
  enhancements — each raises flexibility or lowers adoption friction — landed
  without breaking the `.check/` contract or the no-normalization thesis. This is
  a roadmap, not one feature; each step ships on its own.
- **Done looks like:** all nine enhancements landed, each with tests, `pnpm check`
  green after every step, docs (README + `docs/`) updated, and the
  `.check/summary.json` contract preserved (additive fields only; `schema_version`
  bumped only when the summary shape changes).
- **Explicitly NOT doing:** no normalization of diagnostics into a common format
  (per-adapter *fingerprints* only, raw output stays authoritative); no rewrite of
  the slot/adapter model; no new runtime dependency in core (keep spawning
  `<pm> exec <tool>`); no hosted service or CI product; no change to the
  stdout/stderr split (machine output stays on stdout only).

## Architecture sketch

The nine ideas map onto the existing layers with almost no new seams — that is
the point. Each idea slots into the module it belongs to:

```
cli.ts ......... new subcommands: `baseline`, `agent-setup`; flags: --cache, --digest
   |
orchestrator.ts  per-check loop gains: cache short-circuit, baseline subtraction, digest emit
   |
config.ts ...... `extends` merge, custom-check `detect`, $schema emission
   |
adapters.ts .... new slots: `format` (prettier/biome), opt-in `publint`/`attw`;
   |             `command: pnpm` becomes pm-agnostic at run time
new modules (deep-modules layout, folder + index.ts barrel):
   src/pm/            — detect package manager, translate the exec prefix
   src/baseline/      — per-adapter fingerprints + baseline read/write/ratchet
   src/cache/         — per-slot input hashing (parked — step 7, see Verdicts)
   src/digest/        — token-bounded failure excerpt
schema/checkride.config.schema.json  — published JSON Schema
```

The one place this brushes the "no normalization" thesis is baseline
fingerprinting — resolved by keeping it a *per-adapter* function (file + rule +
message-key), a far smaller contract than a shared display schema.

## Decisions

- D1: This is a **roadmap of independent increments**, sequenced by a blend of
  build-dependency and risk — *not* by marketing priority. — *because* each step
  is independently shippable, and front-loading low-risk foundational work
  (polish, package-manager) de-risks the centerpiece (baseline).
- D2: Baseline is honoured as the **headline lever** and front-loaded (steps 4–6),
  right after the foundational package-manager change. — *because* the user named
  it the biggest adoption unlock; it depends only on the orchestrator loop and
  per-adapter output, both of which exist today, so nothing blocks pulling it
  forward.
- D3: Baseline uses **per-adapter fingerprint functions**, never a normalized
  schema. A fingerprint is a stable, order-independent key *string* each adapter's
  extractor defines — `file + rule + normalized message` is the common case
  (oxlint/ast-grep/cspell), but an adapter may emit a composite key for cross-file
  findings (fallow cycles/duplication) or emit none and sit out (D12; loosened in the
  2026-07-07 refine, see a4).
  — *because* normalizing diagnostics for display is exactly the layer the thesis
  deletes; a fingerprint is a much smaller per-adapter contract and the raw
  `.check/<slot>.json` stays authoritative.
- D4: The baseline is a **ratchet** — a run prunes fixed diagnostics from it but
  never adds new ones; new diagnostics fail the slot. — *because* "don't make it
  worse" is the adoption-friendly definition of done for incremental work on
  legacy code, and a monotonic-shrink invariant prevents silent regression.
- D5: Package manager is resolved from the **lockfile / `packageManager` field**,
  falling back to `pnpm`; the *runner* translates the exec prefix while the
  adapter registry keeps its canonical `pnpm exec <tool>` form. — *because* the
  registry already isolates command strings, so a translation layer is a contained
  change that widens the funnel even if `init` stays pnpm-opinionated.
- D6: Caching is **opt-in** (`--cache` / config `cache: true`) and keys on a
  conservative hash (input files + resolved args + tool version); when unsure it
  under-skips (re-runs) rather than wrongly skipping. — *because* a false cache hit
  in a "definition of done" tool is a correctness bug; correctness beats precision.
- D7: `publint` + `attw` land as **two opt-in slots**, not one, and not alternates.
  — *because* they check different things (package.json correctness vs. type
  resolution) and the model is one adapter per slot; they are complementary, so
  each is its own slot, both opt-in like `mutation`/`security`.
- D8: The `.check/` schema stays **backward-compatible**; new fields
  (`cached`, `baselined`, digest pointers) are additive and `schema_version` bumps
  only if the summary *shape* changes. — *because* `.check/` is a public API for
  agents; treat schema changes as breaking.
- D9: The baseline lives at **repo root as `checkride.baseline.json`**, beside
  `checkride.config.json` (committed, *not* under the gitignored `.check/`).
  — *because* it must be committed to function, and sitting next to the config makes
  it discoverable as a peer artifact rather than mistaken for disposable run output.
  *(resolves Q1)*
- D10: The blessed `format` slot and the `order: 'first'` custom-check escape hatch
  **coexist** — the slot is the paved road, the hatch stays for bespoke formatters.
  — *because* they serve different needs and retiring the hatch would be a gratuitous
  breaking change. *(resolves Q3)*
- D11: Caching hashes the **whole tracked tree conservatively** (per D6); per-slot
  input scoping is explicitly deferred, revisited only if the cache under-skips in
  practice. — *because* correctness beats precision and premature scoping adds
  fragility for uncertain gain. *(resolves Q4)*
- D12: Baseline **fingerprintability is decided per-adapter in step 4**, against real
  fixtures — no up-front slot list; a slot with no extractor simply doesn't
  participate. — *because* whether a tool's output is a stable diagnostic set is an
  adapter-specific judgment best made against real output, not guessed now.
  *(resolves Q2)*

## Constraints

- C1: No new **core runtime dependency**. Keep spawning `<pm> exec <tool>`; new
  behaviour is built from Node built-ins (`crypto` for hashing, `fs`, `child_process`).
- C2: **Module boundaries** hold: new modules follow the deep-modules layout
  (a single file until internals grow, then a folder whose only public surface is
  `index.ts`); named exports only; no classes; `.js` extensions on relative imports.
- C3: **Every step ends green** under `pnpm check`, and new logic is unit-tested
  through the codebase's established injectable-dependency pattern (see the
  `runner`, `fixRunner`, `DoctorEnv`, `probeFailures`, `fileExists` seams).
- C4: **Never break `.check/summary.json`.** Additive fields only, gated by
  `schema_version` (D8). Tests that read the contract must keep passing.
- C5: Preserve the **stdout/stderr split** — human progress to stderr, machine
  output (the `--json` summary) to stdout only. The failure digest is a **file**
  (`.check/digest.md`, beside `summary.json`), not a stdout stream (step 11 / b6).
- C6: Each catalogue or config surface change is **documented in the same step**
  (README table + `docs/cheatsheet.md`) **and reflected in
  `schema/checkride.config.schema.json` in the same step** (e.g. steps 2 and 10 add
  the `detect` and `extends` keys); a feature with no docs — or a config key missing
  from the schema — is not done.

## Steps

1. [x] Publish a JSON Schema for `checkride.config.json` and emit a `$schema`
   pointer in generated configs — **done when:** `schema/checkride.config.schema.json`
   exists and describes the config surface (slots, `use`/`false`/custom/`order`,
   `timeout`); `init` (existing mode) writes a version-pinned `"$schema"` URL —
   `https://raw.githubusercontent.com/robmclarty/checkride/v<version>/schema/checkride.config.schema.json`,
   the version read from `init`'s own package.json (the git tag must exist at release) —
   into the config it generates; a test parses a representative config and asserts it validates
   against the schema. Ships in `files` so it's resolvable from the installed package.
   - seam: `schema/checkride.config.schema.json`, `src/init.ts`, `src/config.ts`,
     `src/__tests__/config.test.ts`, `package.json` (`files`), `README.md`

2. [x] Let custom checks declare a `detect` field so shared presets are safe
   across heterogeneous repos — **done when:** a custom check with
   `detect: ['foo.config.js']` resolves to *skipped* ("no detect file present")
   when the file is absent and *active* when present; a catalogue-slot custom
   check is unaffected; unit test in `config.test.ts` covers both branches.
   - seam: `src/config.ts`, `src/__tests__/config.test.ts`, `README.md`

3. [x] Package-manager-agnostic runner — **done when:** a `src/pm/` module resolves
   pnpm | npm | yarn | bun from lockfile fixtures (`pnpm-lock.yaml`, `package-lock.json`,
   `yarn.lock`, `bun.lock`) and the `packageManager` field, defaulting to pnpm; the
   orchestrator translates **only** each adapter's `pnpm exec <tool>` into the
   resolved PM's invocation (`npx`/`yarn`/`bunx`); the `security`/`pnpm audit` adapter
   is **not** prefix-translated — audit flags and JSON shape are PM-specific, so audits
   are modelled as per-PM registry adapters and `security` is simply unavailable on a
   non-pnpm PM until one lands (b5); default pnpm behaviour is byte-identical to today;
   `doctor` reports the detected PM. Unit tests cover each lockfile → prefix mapping.
   - seam: `src/pm/index.ts`, `src/pm/detect.ts`, `src/orchestrator.ts`,
     `src/doctor.ts`, `src/__tests__/` (new `pm.test.ts` + orchestrator test),
     `README.md`, `docs/tools.md`

4. [x] Baseline part 1 — per-adapter diagnostic fingerprints — **done when:** a
   `src/baseline/fingerprint.ts` exposes a per-adapter extractor that turns a raw
   tool payload (oxlint JSON, fallow JSON, ast-grep compact JSON, cspell text) into
   a stable, order-independent set of keys (`<file>:<rule>:<message-key>`); adapters
   with no extractor return `null` (baseline not supported for that slot, documented);
   fixture-based unit tests assert the same input yields the same key set and that
   cosmetic reordering doesn't change it. Fingerprintability is decided **per-adapter
   against real fixtures** here — no up-front slot list (D12).
   - seam: `src/baseline/fingerprint.ts`, `src/baseline/index.ts`,
     `src/__tests__/baseline-fingerprint.test.ts` (+ fixtures under `src/__tests__/`)

5. [x] Baseline part 2 — `checkride baseline` command — **done when:** `checkride
   baseline` runs the pipeline, fingerprints each fingerprintable slot's output, and
   writes **`checkride.baseline.json` at repo root** (beside `checkride.config.json`,
   committed — *not* under the gitignored `.check/`; D9), shaped
   `{ schema_version, slots: { <slot>: [keys] } }`; CLI dispatch wired; unit test
   drives it against a red fixture via the injectable runner and asserts the written
   key sets.
   - seam: `src/cli.ts`, `src/baseline/index.ts`, `src/orchestrator.ts`,
     `src/__tests__/cli.test.ts`, `src/__tests__/baseline.test.ts`

6. [x] Baseline part 3 — baseline-aware run + ratchet — **done when:** a normal run,
   when a baseline exists, subtracts baselined keys from each slot's current
   fingerprints; a slot passes if its remaining (non-baselined) set is empty and
   fails listing only the *new* keys; keys present in the baseline but absent from a
   **fully-observed** run are *pruned* (baseline rewritten smaller, never larger — the
   ratchet), while a **partial** run (`--only`/`--skip`/`--changed`) never prunes, so an
   incomplete run can't corrupt the baseline (a1); `summary.json` marks affected checks
   with a `baselined` count (additive field, D8); integration test: green when only
   baselined diagnostics remain, red on a new one, and the rewritten baseline shrinks
   after a fix. Baseline supersedes init's slot-disable as the adoption path — init's
   existing-mode offers `--baseline` to grandfather existing debt instead of writing
   failing slots as `false` (c10). Documented in README + AGENTS stanza.
   - seam: `src/orchestrator.ts`, `src/baseline/index.ts`, `src/init.ts` (stanza + `--baseline`),
     `src/__tests__/orchestrator.test.ts`, `README.md`

7. [x] Per-slot input caching (opt-in) — **PARKED 2026-07-07 (a3):** deferred until
   `--changed` + native incremental modes prove insufficient — D11's whole-tree hash
   invalidates every slot on any edit, so `--cache` barely helps the inner loop it
   targets while adding correctness surface (D6); D6/D11 ride with this step. Original
   **done when:** with `--cache` (or config
   `cache: true`) a slot whose input hash — tracked source files + its config file +
   resolved args + tool version — matches the previous run is *not* spawned, is
   reported `skipped: "cached"`, and its prior `.check/<slot>.json` is preserved;
   touching any input invalidates and re-runs; the cache is a no-op unless opted in;
   hashing is **conservative whole-tree** (per-slot input scoping deferred — D11);
   unit tests via an injectable hash/store assert skip-on-match, run-on-change, and
   that a false hit is impossible (unknown inputs → always run).
   - seam: `src/cache/index.ts`, `src/orchestrator.ts`, `src/config.ts`, `src/cli.ts`,
     `src/__tests__/cache.test.ts`, `README.md`, `docs/cheatsheet.md`

8. [x] Blessed `format` slot — **done when:** `SLOTS` gains an **opt-in** `format` slot
   before `lint` (excluded from the default run like `mutation`/`security`, so an
   upgrading repo can't go red on it; `init` new-mode may enable it in the generated
   config so greenfield formats by default); `prettier` (blessed) and `biome` (alternate) adapters
   registered with detect files, a `--check`-style pipeline command, and `fixArgs`
   that write; `checkride fix` runs the write form; `doctor` shows it; `init`
   scaffolds the blessed config; adapters test asserts detection + fix wiring. The
   blessed slot and the documented `order: 'first'` custom-check workaround
   **coexist** — the slot is the paved road, the hatch stays for bespoke formatters
   (D10); README frames it that way rather than deprecating the hatch.
   - seam: `src/adapters.ts`, `src/init.ts` (+ `templates/`),
     `src/__tests__/adapters.test.ts`, `README.md`, `docs/tools.md`

9. [x] Library-publishing slots (`publint`, `attw`), opt-in — **done when:** two
   opt-in slots added with adapters for `publint` and `@arethetypeswrong/cli`;
   excluded from the default run (need `--include`/`--all`), surfaced by `doctor` as
   opt-in (automatic via `classifySlot`); a test asserts opt-in selection and JSON
   output capture; README opt-in table updated. Great fit for the "definition of
   done" story for packages published to npm.
   - seam: `src/adapters.ts`, `src/__tests__/adapters.test.ts`,
     `src/__tests__/orchestrator.test.ts`, `README.md`

10. [x] Presets / `extends` — **done when:** `checkride.config.json` accepts
    `"extends": "<pkg-or-path>"` (string or array); configs merge with local keys
    overriding the base and arrays replacing (not concatenating); a missing/circular
    extend fails with the friendly `invalid checkride.config.json: <reason>` message;
    unit tests cover path resolution, package resolution, local-wins, and the error path.
    - seam: `src/config.ts`, `src/__tests__/config.test.ts`, `README.md`

11. [x] Token-bounded failure digest — **done when:** `checkride --digest` writes a
    capped Markdown excerpt (first N diagnostics per *failing* slot, byte/'item
    budget, truncation not normalization) to `.check/digest.md`, each section
    pointing at the authoritative raw `.check/<slot>.json`; the raw files are
    unchanged; on a green run the digest is empty/absent; unit test asserts the cap
    and that raw output is untouched. Saves agents real context on big repos.
    - seam: `src/digest/index.ts`, `src/orchestrator.ts`, `src/cli.ts`,
      `src/__tests__/digest.test.ts`, `README.md`, `docs/cheatsheet.md`

12. [x] Agent setup at init + `checkride agent-setup` — **done when:** `init` (new
    and existing modes) writes/refreshes an idempotent Claude Code Stop hook in
    `.claude/settings.json` that runs `pnpm check` *without double-running* the
    pipeline (respecting the pattern documented in `docs/`); `checkride agent-setup`
    adds the AGENTS.md stanza + hook to an existing repo without a full init; both are
    idempotent and opt-out; tests cover create + refresh + no-op-second-run.
    - seam: `src/cli.ts`, `src/init.ts`, `src/agent-setup/index.ts` (+ `templates/`),
      `src/__tests__/cli.test.ts`, `src/__tests__/init.test.ts`, `README.md`, `docs/getting-started.md`

## Open questions

*(All four planning-time questions resolved 2026-07-07 — see Decisions D9–D12 and
Verdicts. Q2 and Q3's implementation details are intentionally settled at their
build step, not guessed now.)*

**Refine pass 2026-07-07 (`/pb-refine`) — holes surfaced against the code, to
converge at each step's `/pb-step`:**

- **a1 (step 6) —** The ratchet must rewrite only slots *fully observed* this run — no
  pruning under `--only`/`--skip`/`--changed`, or a partial run corrupts the baseline.
  How is "fully observed" tracked and enforced?
- **a2 (step 7, deferred) —** When caching unparks: a cache-skipped slot yields no
  fingerprints, so the ratchet would prune its whole baseline. Hold the baseline intact
  and/or disable caching while a baseline is active — which?
- **a4 (step 4) —** With D3 relaxed to a per-adapter key string, does fallow participate
  for cross-file findings (cycles/duplication) via a composite key, or sit out per D12?
  Start with lint/struct/spell.
- **b5 (step 3) —** Confirm the adapter-not-translation model for audit: add per-PM
  `security` adapters (npm/yarn) as needed, leaving `security` unavailable on non-pnpm
  meanwhile, rather than translating `pnpm audit` and breaking `security.json`'s shape.
- **b6 (step 11) —** Digest reuses step 4's per-adapter extractors (render first N of the
  same items; text-tail fallback for slots with no extractor) and writes the file
  `.check/digest.md`, not stdout. Sequence step 11 after baseline; confirm.
- **b7 (step 12) —** agent-setup's Stop hook must use the *detected* PM's run command
  (depends on step 3's PM module), not a literal `pnpm check`, or npm/yarn/bun repos get
  a broken hook.
- **c10 (steps 5–6) —** Baseline supersedes init's slot-disable as the adoption path
  (init offers `--baseline`). Does the auto-`false` path retire entirely, or stay as a
  fallback for slots with no extractor?
- **c11 (step 9) —** publint = normal adapter; attw = `attw --pack` (fails if the package
  can't pack — correct for publish-readiness); both opt-in *and* detect-gated on being a
  published lib (`exports`/`types` present, not `private`) so apps never see them. Confirm.

## Verdicts

- 2026-07-07 — Q1 (baseline location) → chose **repo root
  `checkride.baseline.json`** beside the config, over a path under `.check/`, because
  the baseline must be committed and `.check/` is gitignored run output (D9).
- 2026-07-07 — Q2 (which slots are fingerprintable) → chose to **decide per-adapter
  in step 4 against real fixtures**, not to enumerate up front; a slot with no
  extractor simply doesn't participate (D12).
- 2026-07-07 — Q3 (`format` slot vs. `order: 'first'` hatch) → chose **coexist** —
  the blessed slot is the paved road, the escape hatch stays for bespoke formatters;
  retiring it would be a gratuitous breaking change (D10).
- 2026-07-07 — Q4 (caching input scoping) → chose **conservative whole-tree
  hashing**, deferring per-slot input scoping until/unless the cache under-skips in
  practice; correctness beats precision (D11).
- 2026-07-07 (refine) — a3 (caching value) → **parked step 7**: D11's whole-tree hash
  invalidates every slot on any edit, so `--cache` barely helps the inner loop while
  adding correctness surface (D6). Revisit if `--changed` + native incremental proves
  insufficient.
- 2026-07-07 (refine) — a4 (fingerprint shape) → **loosened D3**: a fingerprint is a
  per-adapter stable key *string*, not a fixed file+rule+message triple; fallow's
  cross-file categories emit a composite key or sit out (D12).
- 2026-07-07 (refine) — b8 (format default vs red-on-upgrade) → **`format` is opt-in**
  (like mutation/security); init new-mode may enable it for greenfield. A new default
  slot would light up existing repos red on version bump — the friction the Frame deletes.
- 2026-07-07 (refine) — c9 (`$schema` value) → **version-pinned raw URL**
  (`.../checkride/v<version>/schema/...`); C6 now requires the schema to move in lockstep
  with any config-surface change.
