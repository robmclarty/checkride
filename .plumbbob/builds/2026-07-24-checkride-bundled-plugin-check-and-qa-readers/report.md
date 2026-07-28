# Report — checkride bundled plugin: check and qa readers

**Status:** done — 8 of 8 steps checkpointed, `pnpm check` green (17 slots) at the
last one. 2026-07-25 → 2026-07-28.

## What shipped

checkride's package root is now also a Claude Code plugin. The `## Log` below has
the step-by-step; the shape of it is four pieces:

- **The vehicle** — `.claude-plugin/plugin.json` at the package root, with
  `.claude-plugin` and `skills` added to `files` so the published tarball carries
  the plugin. A test asserts the manifest's version equals `package.json`'s, and
  `/version` was taught to move both numbers in one commit — the coupling was
  fixed in the step that created it, not left for release day.
- **The readers** — `src/artifacts/` (the single shared read: parse, schema pin,
  freshness window, raw-output resolution), `src/triage/`, `src/qa/`, all shipped
  in the existing `dist/` and dependency-free. Both are runnable without Claude
  Code: `node node_modules/checkride/dist/{triage,qa}/cli.js`.
- **The skills** — `/checkride:check` triages a red gate to one root cause;
  `/checkride:qa` reads the four quality artifacts and says what the suite
  actually proves. The judgment lives in the prose; the bounded reading lives in
  the code.
- **The prose** — one added line in the AGENTS.md stanza `init` writes, a README
  section, `docs/plugin.md`, and a `CHANGELOG.md` `[Unreleased]` entry.

Step 4 was not in the original plan. Step 3's dogfood — a real install against a
deliberately-reddened tree — found the reader dropping the gate's own stderr on
the one branch where it is the only evidence there is, so a step was inserted and
the qa work renumbered. That is the plan working, not the plan failing: the
reader looked correct until something disagreed with it.

## Decisions and why

The full set is in `intent.md`. The ones that shaped the build:

- **Bundled inside checkride, not in agent-tools** (D1). The reader asserts
  `schema_version` against a pre-1.0 contract, so shipping it in the same package
  makes reader and engine version in lockstep. Cost accepted: the agent-tools
  marketplace entry is now gated behind a publish (C6).
- **TypeScript in `src/`, shipped in `dist/`** (D4). Forced by a verified
  collision, not a preference: `src/pack.ts`'s `DENY` forbids `scripts/` in the
  tarball, so C2 (gate stays green) and C3 (files array) could not both hold as
  written. The original *because* — "a skill must run in a consumer repo with no
  build step" — turned out to be false, since the published package and the
  installed plugin cache both already carry a built `dist/`. Cost accepted: the
  readers now sit inside this repo's own coverage, health and mutation surface.
- **Reader, never runner** (D2), and **no wrapper skills** (D10). No new command,
  flag, config file or hook. A skill that runs one command is strictly worse than
  the command; `doctor` and `fix` fold into the triage flow at the moment each is
  the right answer instead.
- **The summary is an index, not evidence** (D12, D13). Triage runs the gate
  itself rather than trusting whatever `summary.json` happens to hold, and
  resolves a failing slot's raw output by the documented convention when
  `output_file` is null — which it is for 8 of this repo's 17 slots, `test` among
  them.
- **The freshness window is measured off the run's start** (D11). The first form
  of this rule — compare mtime against `summary.json`'s `timestamp` — was wrong
  and measurably so: `timestamp` is stamped when the summary is *built*, so every
  artifact the run just wrote is older than it and the rule called everything
  stale. `Date.parse(timestamp) - total_duration_ms` is the run's start, and both
  fields are promised surfaces, so the derivation is contract-legal.
- **A gap is a finding** (D14). Three of qa's four artifacts come from opt-in
  slots and this repo's own gate never runs `mutation`, so partial data is the
  normal case. qa reports present / stale / not-opted-in and names the command
  that would close each gap, and launches nothing.
- **The AGENTS.md stanza stays standalone** (D15). `init` runs in repos that will
  never install the plugin, so the prose procedure is unchanged and gained exactly
  one line naming `/checkride:check` as the fuller path.

## Parked and harvested

Seven items parked, six closed, one still open. Two harvest boundaries are
recorded in full in `build-log.md` (after step 3, after step 5).

- **Folded into the plan** — the reader dropping the gate's stderr on a red gate
  with no failing slot. Classed a blocker by *action*, not obstruction: the plan
  was incomplete, so the fix went into the plan (as step 4) rather than into step
  3's diff. Weight came from traffic, not severity — `tsc --build && node
  dist/cli.js` is the shape `init` writes and a type error is the usual way a TS
  repo goes red.
- **Split** — the `raw.ts` stdout-over-stderr preference. The actionable slice
  (naming each alternate candidate with its size, not a bare `(+N)`) landed in
  step 4; the reader-side fix was **killed on purpose**, because no reader can
  know which tools invert checkride's stream discipline without a per-adapter
  table. That judgment stays in the check skill's prose.
- **Merged and closed** — the pnpm-11 trigger condition, which turned out to be an
  annotation on an earlier item. Its lasting value is that it *confirms* D3: the
  pollution fires only when checkride runs with no outer pnpm process, and the
  triage reader runs `<pm> run check`, which is exactly the invocation that avoids
  it.
- **Parked and then fixed at the close-out**, on the human's ask: `/version` would
  have inserted a new release section *above* the `[Unreleased]` block this build
  added, stranding it. `.claude/skills/version/SKILL.md` now folds an existing
  `Unreleased` section into the new release heading instead.

## What is left

- **C6 — the agent-tools marketplace entry.** It cannot land until a checkride
  release carrying `.claude-plugin/plugin.json` is on npm; that repo's CI probes
  the latest npm tarball for it and fails the build if absent. So the order is:
  `/version` here, publish, then the catalog entry. `CHANGELOG.md` carries an
  `[Unreleased]` section ready for the fold.
- **Deploying `checkride agent-setup` across the fleet** — a deployment task,
  deliberately out of this build's frame.

## Deferred tangents

In the order they are worth picking up:

1. **The pnpm 11 stdout pollution — this should be the next build.** pnpm 11.1.2's
   `verifyDepsBeforeRun` prints `Already up to date / Done in Xms` to stdout ahead
   of every `pnpm exec`, so `dead`/`dupes`/`health`/`attw` fail with exit 0 and
   "did not emit valid JSON". It hits *every consumer on pnpm 11*, and it is an
   adapter bug, not a plugin bug — a different seam, which is why it was not folded
   in here. Real fix: adapters tolerate leading non-JSON, or tools stop routing
   through `pnpm exec`. Workaround today: `--config.verify-deps-before-run=false`.
2. **The Stop-hook guidance** (the one still-open park item). `src/agent-setup/hook.ts`
   still carries the thin procedure and never names `/checkride:check`. Deferred
   because changing that command string rewrites `.claude/settings.json` in every
   repo on upgrade — a migration question, not a wording one.
3. **Co-locating unit tests** in per-directory `src/**/__tests__/` folders instead
   of the single `src/__tests__/`. Two notes for whoever runs it: `fallow.toml`'s
   entry glob already covers nested dirs, and **ast-grep is the wrong enforcement
   tool** — it matches patterns inside files and has no concept of a file being in
   the wrong directory. fallow's path-aware `policy_violations` or a custom check
   fit better.

## Checkpoints

- baseline cb168f6d5961edbd981f039aaee60f2b2eafe841
- step 1 cf4856b177eda52e573657c06950afc205ebd4fc
- step 2 5850a1685c315578a5a71432b5f7893e035fd9b5
- step 3 661907892b0679fbc3293804ffe92cb8c2b184a8
- step 4 281d5ff3a0a38278d147815cfd45cf3f65520950
- step 5 92bf88bc1cd0fda32da2e442d720d3aa0b91ab0c
- step 6 6e303f588944f3269428b09508f093237005c0f2
- step 7 f1498bcb22f575e6f1dbdb1873700c03281ff8a6
- step 8 1f0892de51e02390661382927f80f8076d2e4ddb

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 2 | 0 | 0 | 20m |
| 2 | 0 | 1 | 0 | 26m |
| 3 | 0 | 0 | 0 | 5056m |
| 4 | 0 | 1 | 0 | 13m |
| 5 | 0 | 1 | 0 | 29m |
| 6 | 0 | 1 | 0 | 8m |
| 7 | 0 | 1 | 0 | 5m |
| 8 | 0 | 0 | 0 | 28m |
| **total** | 2 | 5 | 0 | 5185m |
