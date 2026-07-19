# Build report — Publish-ready bundle + wave scheduler

**Status:** ✅ complete — 12/12 steps checkpointed, `pnpm check` green at every
boundary, and a full uncapped `checkride --all` (incl. mutation) green on this repo.

*The step-by-step timeline lives in `build-log.md`'s `## Log`; this report is the
synthesis — what shipped, the calls that shaped it, and what was deliberately left
for later.*

## What shipped

Two coupled capabilities that turn checkride from a static-analysis gate into one
that also validates the artifact a consumer installs:

- **A wave scheduler (steps 1–3).** `order` grew from `'first' | 'last'` into one
  value — `number | 'first' | 'last' | 'middle' | 'single' | 'any'` — honored on
  every object-form config entry. Equal numbers run concurrently through a bounded
  pool with a barrier between distinct values; `'single'` runs exclusively; a new
  `--concurrency <n>` flag sizes the pool. `--bail` keeps today's sequential
  fail-fast path. `total_duration_ms` became honest wall-clock; the summary array
  stays in deterministic group order regardless of completion interleaving.
- **The publish-ready bundle — four opt-in slots (steps 4–10).** `build` (wave 10,
  runs the consumer's build script), then `pack` / `smoke` / `snippets` share wave
  20 with `publint`/`attw`, so `checkride --all` orders itself with zero config:
  build → inspect-the-artifact. Each is a built-in or runs the consumer's own
  `build`/`tsc`, so enabling them adds **zero devDependencies**. Detection widened
  with `detectScript` and `detectDeps` (D18) so a dependency — not just a config
  file — can activate a configless-capable slot.
- **Dogfood + close-out (steps 11–12).** checkride's own config now runs the bundle
  on itself; each new slot's verdict was diffed against its fascicle reference
  script (healthy **and** deliberately-broken) and agreed. Step 12 shipped the
  `stryker` adapter uncapped (`timeout: 0`) so `checkride --all` completes mutation
  instead of dying at the 600s cap.

## Decisions and why

- **One `order` value, not a `needs:` DAG (D1, D8).** The only real dependency in
  the catalogue is "build before the artifact checks," which a single integer
  expresses. A dependency DAG would bring cycle detection, partial-failure
  semantics, and schema surface disproportionate to checkride's declarative-table
  ethos. Rejected in writing; revisit only if waves prove too coarse.
- **Omitted order defaults to `'any'` everywhere (D2/D3).** One uniform
  omitted-default beat a customs-only carve-out. The one visible behavior change (a
  config-only custom check with no `order` moves from implicit `'last'` to `'any'`)
  is invisible in a sequential run and CHANGELOG-noted, with `order: 'last'`
  restoring the old placement.
- **The bundle orders itself (D4).** `mutation` `'single'`, `build` 10, artifact
  slots 20 — chosen so the publish bundle needs no ordering config, with gap
  numbering (10/20/30) recommended so inserting a slot never forces a renumber.
- **`smoke` is liveness, not types (D9).** A spawned `node` probe imports each
  `exports` subpath through package self-reference and asserts declared value
  exports are live; a conservative self-contained `.d.ts` scanner (no TypeScript
  dep) errs toward under-collection so a missed name is a weaker assertion, never a
  false failure. Runtime *shapes* stay attw's job — the slots don't overlap.
- **`snippets` matches fascicle byte-for-byte (D11/D12).** So the origin repo adopts
  the slot verbatim; ships as two adapters (`snippets` src / `snippets-dist`) because
  slot→adapter choice is checkride's existing config vocabulary.
- **Built-ins spawn through the runner context (D16).** So pack/smoke/snippets
  children register in `liveChecks` and inherit the timeout + SIGTERM→SIGKILL
  reaping — C6 holds by construction under concurrency.
- **`mutation` ships uncapped (step 12).** The safe-default 600s cap exists to keep
  a hung tool from hanging the definition-of-done gate. A real stryker run
  legitimately takes ~12–20 min, and `mutation` is opt-in and never in that gate —
  so exempting it (`timeout: 0`) costs the gate nothing and unblocks `checkride
  --all`. Confirmed: mutation ran 713491ms (~11.9 min) and passed.

## Parked & harvested

Nothing sat on the park list at any boundary — ideas that surfaced mid-step were
either in-scope for a later planned step or captured as build-log drift notes. Six
steps carried a **seam-drift** note (a step touching slightly beyond its literal
seam), each surfaced at its verify pause and approved rather than swept — most
notably step 11's `smoke` fix for `./package.json` (a `.json` subpath is data, not
a runtime module; skipped and counted like the wildcard/`null` skips), which the
done-when's "green on this repo" explicitly anticipated.

## Open questions — resolved in-build

Both planned open questions were answered during execution (the tracker still counts
them as "open" only because they were closed in the work, not formally moved to
`intent.md`'s Verdicts):

- **Q1 (src-mode snippet path mapping)** → resolved at step 8: dist mode resolves
  via package **self-reference** through `exports`, needing no hand-written `paths`;
  confirmed against fascicle.
- **Q2 (`pnpm pack --dry-run --json` shape)** → resolved at the step-5 spike: pnpm
  emits the npm-compatible `files[].path` shape; pack runs with `--ignore-scripts`
  so a `prepack` build can't rewrite `dist/` mid-wave-20.

## Deferred tangents (future work)

Explicitly out of scope this pass, noted for later:

- **A `needs:` dependency DAG (D8)** — only if waves prove too coarse.
- **yarn/bun adapters** for `pack` (D10) and `security`, currently
  unavailable-until-adapter.
- **Snippet-tag variants** (`expect-error`, per-fence modes) — `check` is the only
  marker, matching fascicle exactly.
- **Floating `'any'` into idle pool slots** — v1 conservatively schedules
  `'any'`/`'middle'` in the numeric-0 group; a later version could float them
  without breaking any documented promise.

## Release

CHANGELOG entries are staged under `[Unreleased]` (a **Contract** section for the
`order`/`--concurrency`/`total_duration_ms` surface plus **Added**/**Changed** for
the bundle and detection widening). Cutting the version is the human's `/version`
call — not part of this build.

## Checkpoints

- baseline 1c22393f38681e9440330d691a56de6bacdd1872
- step 1 4c5b150e21d30e0b0a3f84246c0624e455d25c14
- step 2 b9f7731e2d4acd38560fa49982c51c81937ff2bb
- step 3 2950267643247d404056d54bedf200e8f21b663d
- step 4 5a710199ae78eef372af631b27d78ab1d721cac0
- step 5 73f5a4cef2c96cd8ed72e563f5028411f86d603c
- step 6 cfbec0da704d6526842c82ec8c5f20287d8cb479
- step 7 97a8f08836ef94063db2659e5f826159170f9a64
- step 8 5e982c172c6b83777e5a37b77c17c1d95eda90dc
- step 9 4e06800868bd27ebc705a52c3640c880e0749bc7
- step 10 c8e26f0750e9afcb677aa50875db995149f0b82f
- step 11 02ae9835b832c3cdca8bce81788e697ad3edcbe0
- step 12 803711ee09ed93102f0ffc184c923fabf16a8d74

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 0 | 0 | 0 | 30m |
| 2 | 0 | 0 | 0 | 20m |
| 3 | 0 | 0 | 0 | 6m |
| 4 | 0 | 1 | 0 | 27m |
| 5 | 0 | 1 | 0 | 17m |
| 6 | 0 | 1 | 0 | 67m |
| 7 | 0 | 0 | 0 | 11m |
| 8 | 0 | 1 | 0 | 27m |
| 9 | 0 | 0 | 0 | 38m |
| 10 | 0 | 1 | 0 | 44m |
| 11 | 0 | 1 | 0 | 45m |
| 12 | 0 | 0 | 0 | 21m |
| **total** | 0 | 6 | 0 | 355m |
