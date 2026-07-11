# Build report — checkride: post-0.3.0 fixes — bugs, hardening, docs sync

**Status:** complete — 19/19 steps, `pnpm check` green, full `test:e2e` green.
Parked 0, open questions 0. The `## Log` in `build-log.md` is the per-step
timeline (SHAs there); this report adds only the synthesis.

## What shipped

The v0.2.0→v0.3.0 upgrade left a residue this build cleared in three bands:

- **Four verified bugs** (steps 3–5, plus the doctor fix in 2): `init --baseline
  --dry-run` wrote a real baseline; new-mode `init` silently overwrote files in
  a `package.json`-less directory (now refuses with exit 2, `--force` overrides);
  a typoed `--only lints` exited 0, silently disabling the gate (now exit 2 — a
  contract change); `doctor` misreported a slow `pnpm --version` as "could not
  parse" (now distinguishes "timed out", 30s probe).
- **Hardening** (steps 8–13): stale `.check/` artifacts cleared per slot before
  re-run; process-group kill on timeout + UTF-8-safe capture; `fix` translated
  to the detected package manager; friendly file-named errors for malformed
  consumer JSON; release tag↔version guard, CI concurrency, security-only
  Dependabot; dogfooded `publint`/`attw`.
- **Docs sync** (steps 14–18) and one late safety fix (step 19): mechanical
  drift corrections, the README restructure that connects all six `docs/` files
  and fixes both install paths, getting-started/tools sync, and the docs gaps
  pass. Step 19 forwards SIGINT/SIGTERM to running checks so Ctrl-C leaves no
  orphans.

Two guardrails held throughout: the local gate was greened first (step 1, 30s
timeouts on subprocess-spawning tests) so every subsequent step verified against
a green baseline, and each bug fix landed with a regression test that fails on
the old code (C5).

## Decisions and why

The plan settled D1–D11 before building; the calls that most shaped the diff:

- **D3 — unknown `--only`/`--skip`/`--include` names exit 2, not 0.** The worst
  remaining vacuous-green hole: a typo silently disabling a definition-of-done
  gate. This is a breaking contract change and carries its **Contract** CHANGELOG
  entry + `docs/contract.md` update, locked by a contract test.
- **D4 — overwrite protection is new-mode only.** Existing-mode `init` is already
  additive-only, so only the new-project path needed the refuse-with-`--force`
  guard.
- **D5 — `init` scaffolds an exact version, README installs with `-E`.** Pre-1.0
  consumers are told to pin exact (contract.md), yet init scaffolded the caret
  footgun; fixed both ends.
- **D6 — the generated Stop hook keeps plain `<pm> run check` (no `--strict`);
  docs explain the omission.** Cross-PM arg forwarding through `run` scripts is
  inconsistent; a fail-open local hook backed by fail-closed `--strict` CI beats
  a hook that can block an agent forever on a misconfigured repo. Flagged as the
  one fork worth revisiting; left as-is.
- **D9 — reconcile the "everything locked by test/contract/" overclaim with two
  cheap contract tests** (stream discipline, digest presence) plus naming the
  real suites for timeout/crash surfaces, rather than moving whole e2e suites
  into `test/contract/` as ceremony.

## Parked & harvested

One item parked, during step 9:

- **Ctrl-C orphans** — step 9's detached spawn (needed for process-group
  timeout kills) meant a terminal's SIGINT no longer reached running checks,
  orphaning in-flight check trees on interrupt. Classified **tangent**, but
  *promoted to step 19* rather than deferred: a real user-facing regression this
  build introduced, small and well-understood (reuse the group-kill machinery).
  Fixed and closed within this build.

No blockers, no pivot signals.

## Final status

Done. All 19 steps checkpointed; `pnpm check` and the full `pnpm test:e2e`
suite are green on this machine. Nothing left in the plan.

## Deferred tangents

None outstanding — the sole parked item became step 19. The one decision worth a
future second look is **D6** (the Stop hook's `--strict` omission): flippable if
cross-PM `run`-script arg forwarding is ever made reliable, which would change
step 17's generated hook and its docs.

## Follow-on (not part of this build)

The batch includes a breaking contract change (D3) and a user-facing fix (step
19), so the natural next move is a `/version` cut. The CONTRIBUTING release
ritual also calls for refreshing the README `$schema` pin and mutation score
(D8) — both hand-maintained numbers that drift each release.

## Checkpoints

- baseline 04a9f8e09d13ccfee948e3989bd1617191868077
- plan b6584565685e05400ac70567d08caf042c345fe2
- step 1 98f93d27953e3662c52725fadc914208a3ec3480
- step 2 3c68c86e7953d44d07b54eda5f727ba2d01e2ec2
- step 3 b27983e43799f8bedb48b4292796095297ea3f1c
- step 4 e732539a0d05b3b30cc06d64eb025ad1da01f5d5
- step 5 5ef7b6c512cdb3aad33d34d52b293c2fbd87a4fb
- step 6 a3098a88954f9d750de033c39fe7ab23118c8f46
- step 7 a028caf8318929a06e445f093e54dfed25c5270f
- step 8 b2d7081f1f384dbd5d55d95aae4dd790c15b7af8
- step 9 13458fed0d0e6d10822df6cd90303f5eaa5fd7f7
- step 10 b6e644ff555fd9a4cad2a7f675c20ef8da6341b6
- step 11 56edb1229b3b747a21e738e4b325e792909e7a35
- step 12 85ef478347844e070c58b9bdc969324663ab27c5
- step 13 d7b2b84fac01c9c961e0eaa4a415b641c85a169d
- step 14 15e3d1500bffb090fae9ee025f820d291697d01f
- step 15 46538ed42d4d96e9e2d0a33bfa381cf61a9cb2e5
- step 16 78010e3bf35d726d313dc9f8119bd631bc3aa74c
- step 17 1cf9d83eb21716ccdae33b8f60b0733f925727af
- step 18 490743e026367614c1d1b4b4fc6c21794ae79fe0
- step 19 401e1131e5952b9cc1ff88cf864de70d717fdd51
