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
   src/cache/         — per-slot input hashing
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
  schema. A fingerprint is a stable key set (file + rule + normalized message).
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
  output (JSON, digests destined for pipes) to stdout only.
- C6: Each catalogue or config surface change is **documented in the same step**
  (README table + `docs/cheatsheet.md`); a feature with no docs is not done.

## Steps

1. [ ] Publish a JSON Schema for `checkride.config.json` and emit a `$schema`
   pointer in generated configs — **done when:** `schema/checkride.config.schema.json`
   exists and describes the config surface (slots, `use`/`false`/custom/`order`,
   `timeout`); `init` (existing mode) writes `"$schema"` into the config it
   generates; a test parses a representative config and asserts it validates
   against the schema. Ships in `files` so it's resolvable from the installed package.
   - seam: `schema/checkride.config.schema.json`, `src/init.ts`, `src/config.ts`,
     `src/__tests__/config.test.ts`, `package.json` (`files`), `README.md`

2. [ ] Let custom checks declare a `detect` field so shared presets are safe
   across heterogeneous repos — **done when:** a custom check with
   `detect: ['foo.config.js']` resolves to *skipped* ("no detect file present")
   when the file is absent and *active* when present; a catalogue-slot custom
   check is unaffected; unit test in `config.test.ts` covers both branches.
   - seam: `src/config.ts`, `src/__tests__/config.test.ts`, `README.md`

3. [ ] Package-manager-agnostic runner — **done when:** a `src/pm/` module resolves
   pnpm | npm | yarn | bun from lockfile fixtures (`pnpm-lock.yaml`, `package-lock.json`,
   `yarn.lock`, `bun.lock`) and the `packageManager` field, defaulting to pnpm; the
   orchestrator translates each adapter's `pnpm exec <tool>` (and `pnpm audit`) into
   the resolved PM's invocation (`npx`/`yarn`/`bunx`, `npm audit`, …); default pnpm
   behaviour is byte-identical to today; `doctor` reports the detected PM. Unit tests
   cover each lockfile → prefix mapping and the audit translation.
   - seam: `src/pm/index.ts`, `src/pm/detect.ts`, `src/orchestrator.ts`,
     `src/doctor.ts`, `src/__tests__/` (new `pm.test.ts` + orchestrator test),
     `README.md`, `docs/tools.md`

4. [ ] Baseline part 1 — per-adapter diagnostic fingerprints — **done when:** a
   `src/baseline/fingerprint.ts` exposes a per-adapter extractor that turns a raw
   tool payload (oxlint JSON, fallow JSON, ast-grep compact JSON, cspell text) into
   a stable, order-independent set of keys (`<file>:<rule>:<message-key>`); adapters
   with no extractor return `null` (baseline not supported for that slot, documented);
   fixture-based unit tests assert the same input yields the same key set and that
   cosmetic reordering doesn't change it. Fingerprintability is decided **per-adapter
   against real fixtures** here — no up-front slot list (D12).
   - seam: `src/baseline/fingerprint.ts`, `src/baseline/index.ts`,
     `src/__tests__/baseline-fingerprint.test.ts` (+ fixtures under `src/__tests__/`)

5. [ ] Baseline part 2 — `checkride baseline` command — **done when:** `checkride
   baseline` runs the pipeline, fingerprints each fingerprintable slot's output, and
   writes **`checkride.baseline.json` at repo root** (beside `checkride.config.json`,
   committed — *not* under the gitignored `.check/`; D9), shaped
   `{ schema_version, slots: { <slot>: [keys] } }`; CLI dispatch wired; unit test
   drives it against a red fixture via the injectable runner and asserts the written
   key sets.
   - seam: `src/cli.ts`, `src/baseline/index.ts`, `src/orchestrator.ts`,
     `src/__tests__/cli.test.ts`, `src/__tests__/baseline.test.ts`

6. [ ] Baseline part 3 — baseline-aware run + ratchet — **done when:** a normal run,
   when a baseline exists, subtracts baselined keys from each slot's current
   fingerprints; a slot passes if its remaining (non-baselined) set is empty and
   fails listing only the *new* keys; keys present in the baseline but absent from the
   current run are *pruned* (baseline rewritten smaller, never larger — the ratchet);
   `summary.json` marks affected checks with a `baselined` count (additive field, D8);
   integration test: green when only baselined diagnostics remain, red on a new one,
   and the rewritten baseline shrinks after a fix. Documented in README + AGENTS stanza.
   - seam: `src/orchestrator.ts`, `src/baseline/index.ts`, `src/init.ts` (stanza copy),
     `src/__tests__/orchestrator.test.ts`, `README.md`

7. [ ] Per-slot input caching (opt-in) — **done when:** with `--cache` (or config
   `cache: true`) a slot whose input hash — tracked source files + its config file +
   resolved args + tool version — matches the previous run is *not* spawned, is
   reported `skipped: "cached"`, and its prior `.check/<slot>.json` is preserved;
   touching any input invalidates and re-runs; the cache is a no-op unless opted in;
   hashing is **conservative whole-tree** (per-slot input scoping deferred — D11);
   unit tests via an injectable hash/store assert skip-on-match, run-on-change, and
   that a false hit is impossible (unknown inputs → always run).
   - seam: `src/cache/index.ts`, `src/orchestrator.ts`, `src/config.ts`, `src/cli.ts`,
     `src/__tests__/cache.test.ts`, `README.md`, `docs/cheatsheet.md`

8. [ ] Blessed `format` slot — **done when:** `SLOTS` gains a `format` slot
   positioned before `lint`; `prettier` (blessed) and `biome` (alternate) adapters
   registered with detect files, a `--check`-style pipeline command, and `fixArgs`
   that write; `checkride fix` runs the write form; `doctor` shows it; `init`
   scaffolds the blessed config; adapters test asserts detection + fix wiring. The
   blessed slot and the documented `order: 'first'` custom-check workaround
   **coexist** — the slot is the paved road, the hatch stays for bespoke formatters
   (D10); README frames it that way rather than deprecating the hatch.
   - seam: `src/adapters.ts`, `src/init.ts` (+ `templates/`),
     `src/__tests__/adapters.test.ts`, `README.md`, `docs/tools.md`

9. [ ] Library-publishing slots (`publint`, `attw`), opt-in — **done when:** two
   opt-in slots added with adapters for `publint` and `@arethetypeswrong/cli`;
   excluded from the default run (need `--include`/`--all`), surfaced by `doctor` as
   opt-in (automatic via `classifySlot`); a test asserts opt-in selection and JSON
   output capture; README opt-in table updated. Great fit for the "definition of
   done" story for packages published to npm.
   - seam: `src/adapters.ts`, `src/__tests__/adapters.test.ts`,
     `src/__tests__/orchestrator.test.ts`, `README.md`

10. [ ] Presets / `extends` — **done when:** `checkride.config.json` accepts
    `"extends": "<pkg-or-path>"` (string or array); configs merge with local keys
    overriding the base and arrays replacing (not concatenating); a missing/circular
    extend fails with the friendly `invalid checkride.config.json: <reason>` message;
    unit tests cover path resolution, package resolution, local-wins, and the error path.
    - seam: `src/config.ts`, `src/__tests__/config.test.ts`, `README.md`

11. [ ] Token-bounded failure digest — **done when:** `checkride --digest` writes a
    capped Markdown excerpt (first N diagnostics per *failing* slot, byte/'item
    budget, truncation not normalization) to `.check/digest.md`, each section
    pointing at the authoritative raw `.check/<slot>.json`; the raw files are
    unchanged; on a green run the digest is empty/absent; unit test asserts the cap
    and that raw output is untouched. Saves agents real context on big repos.
    - seam: `src/digest/index.ts`, `src/orchestrator.ts`, `src/cli.ts`,
      `src/__tests__/digest.test.ts`, `README.md`, `docs/cheatsheet.md`

12. [ ] Agent setup at init + `checkride agent-setup` — **done when:** `init` (new
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
