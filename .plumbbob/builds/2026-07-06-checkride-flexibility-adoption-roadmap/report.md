# Report — checkride: flexibility & adoption roadmap

**Status:** shipped (11 of 12 steps landed; step 7 parked by decision, not incomplete).
**Branch:** `roadmap/flexibility-adoption` · **Finish commit:** 350a4738a

## What shipped

A roadmap of independently-shippable increments, each raising flexibility or
lowering adoption friction without breaking the `.check/` contract or the
no-normalization thesis. Sequenced foundation → centerpiece → polish:

- **Config surface & safety (steps 1–2).** Published
  `schema/checkride.config.schema.json` and a version-pinned `$schema` pointer in
  generated configs; gave custom checks a `detect` field so shared presets stay
  safe across heterogeneous repos.
- **Package-manager agnosticism (step 3).** `src/pm/` resolves pnpm | npm | yarn |
  bun from lockfile / `packageManager`, and the orchestrator translates each
  adapter's canonical `pnpm exec <tool>` at run time. Default pnpm behaviour stays
  byte-identical; `security`/`pnpm audit` stays pnpm-only rather than mistranslated.
- **Baseline — the headline lever (steps 4–6).** Per-adapter diagnostic
  fingerprints → `checkride baseline` writes a committed `checkride.baseline.json`
  → a baseline-aware run subtracts grandfathered keys and **ratchets** (prunes
  fixed findings on a fully-observed run, never grows, never prunes on a partial
  run). `init --baseline` grandfathers existing debt instead of disabling slots,
  turning "adopt checkride" from a cleanup project into one command.
- **Slot catalogue (steps 8–9).** Blessed opt-in `format` slot (prettier / biome),
  coexisting with the `order:'first'` escape hatch; opt-in library-publishing pair
  `publint` + `attw`, detect-gated on being a published lib so apps never see them.
- **Ergonomics (steps 10–11).** `extends` presets (string or array, local-wins,
  friendly errors on missing/circular); `--digest` writes a token-bounded
  `.check/digest.md` excerpt so agents spend less context on big repos.
- **Agent onboarding (step 12).** `init` (both modes) and the new `checkride
  agent-setup` write an idempotent Claude Code Stop hook to `.claude/settings.json`
  that gates on the **detected** PM's run command, plus the AGENTS.md stanza. Both
  opt-out via `--no-hook`. The generated stanza now tells the agent the hook owns
  the final full run, closing the duplicate-run gap.

The `.check/summary.json` contract held throughout: every new field (`baselined`,
digest pointer) is additive; `schema_version` never needed a bump.

## Decisions and why

- **Roadmap of independent increments, risk-ordered (D1–D2).** Front-loaded
  low-risk foundation (polish, PM) to de-risk the baseline centerpiece, which the
  user named the biggest adoption unlock and which depends only on things that
  already existed.
- **Baseline is per-adapter fingerprints, never a normalized schema (D3, loosened
  in refine a4).** A fingerprint is a stable per-adapter key *string* —
  `file:rule:message` for the common case, a composite for cross-file findings, or
  none (the adapter sits out). This keeps the no-normalization thesis intact: the
  raw `.check/<slot>.json` stays authoritative.
- **Baseline is a monotonic ratchet (D4)** and lives committed at repo root
  (`checkride.baseline.json`, D9), because it must be committed to function and
  `.check/` is gitignored run output.
- **Ratchet only prunes on a fully-observed run (refine a1).** A partial run
  (`--only`/`--skip`/`--changed`/early `--bail`) masks but never rewrites, so an
  incomplete run can't corrupt the baseline.
- **PM handled as translation + per-PM adapters, not audit mistranslation (D5,
  refine b5).** Audit flags/JSON are PM-specific, so `security` is simply
  unavailable off pnpm until a per-PM adapter lands, rather than breaking its shape.
- **Opt-in slots never light a repo red on upgrade (D7, D10, refine b8).**
  `format`, `publint`, `attw` stay out of the default run; the blessed `format`
  slot and the escape hatch coexist rather than retiring the hatch (a gratuitous
  break).
- **Step 12 hook is PM-aware and avoids double-running by guidance, not fragile
  shell (refine b7).** The hook runs `<pm> run check`; the "don't double-run" fix
  is the documented stanza note (the hook owns the final gate), chosen over an
  artifact-freshness shell hook that could false-pass — unacceptable in a
  definition-of-done gate.

## Parked & harvested

- **Step 7 — per-slot input caching → parked (refine a3, verdict 2026-07-07).**
  D11's conservative whole-tree hash invalidates every slot on any edit, so
  `--cache` barely helps the inner loop it targets while adding correctness surface
  (a false hit in a "done" tool is a correctness bug). Deferred until `--changed` +
  native incremental modes prove insufficient. Not incomplete work — a deliberate
  "don't build this yet."
- No mid-build tangents were chased; the park list stayed empty across the run.

## Build events worth recording

- **Step 12 accidental self-dogfood, reverted (579dea7).** An e2e verification
  command had a bad `--cwd` fallback that ran `checkride init` against *this* repo
  instead of a scratch dir, sweeping a `.claude/settings.json` Stop hook and an
  AGENTS.md stanza into the step-12 checkpoint (bb7974a). Caught via the checkpoint
  seam-drift warning + a post-hoc `git status`; reverted in a follow-up commit
  because the hook changes this repo's own agent behaviour and should be an
  explicit opt-in, not an accident. `pnpm check` green after the revert.

## Deferred tangents (future work)

- **Unpark caching** if the inner loop proves too slow even with `--changed` +
  native incremental — and, if so, decide the baseline interaction (refine a2: a
  cache-skipped slot yields no fingerprints, so hold the baseline intact or disable
  caching while a baseline is active).
- **Per-PM `security` audit adapters** (npm/yarn) so `security` isn't pnpm-only.
- **Per-slot cache input scoping** (D11) — only if whole-tree hashing under-skips
  in practice.

## Checkpoints

- baseline · c6f0754
- step 1 · 7d2953a — JSON Schema + `$schema`
- step 2 · a1ec9bb — custom-check `detect`
- step 3 · ba3a20b — package-manager-agnostic runner
- step 4 · 40da1c1 — baseline part 1 (fingerprints)
- step 5 · 596e02f — baseline part 2 (`checkride baseline`)
- step 6 · 1c75615 — baseline part 3 (ratchet + `init --baseline`)
- step 7 · — parked (no checkpoint)
- step 8 · c5e39b3 — blessed `format` slot
- step 9 · dd74116 — `publint` / `attw`, opt-in
- step 10 · d0615e6 — presets / `extends`
- step 11 · 6f88d90 — token-bounded failure digest
- step 12 · bb7974a — agent setup + `checkride agent-setup`
- revert · 579dea7 — undo accidental self-dogfood
- finish · 350a473
