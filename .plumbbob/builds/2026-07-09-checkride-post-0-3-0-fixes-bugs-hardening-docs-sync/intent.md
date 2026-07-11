# checkride: post-0.3.0 fixes — bugs, hardening, docs sync

**Phase**: frame
**Size:** medium

*Source: the 2026-07-09 post-upgrade evaluation (three-agent review + hands-on
verification, this session). All findings were verified against code before
entering this plan; file:line references below were confirmed at baseline
`04a9f8e`.*

## Frame

- **Problem:** The v0.2.0→v0.3.0 upgrade left a residue: four verified bugs
  (`init --baseline --dry-run` writes a real file; new-mode `init` silently
  overwrites files in a package.json-less directory; a typoed `--only lints`
  exits 0 — a vacuous-green hole in a definition-of-done gate; `doctor`
  misreports a slow `pnpm --version` as "could not parse"), a batch of
  hardening gaps (stale `.check/` artifacts, orphaned grandchildren on timeout,
  `fix` not PM-agnostic, no release tag↔version guard), and ~9 docs-drift items
  led by an AGENTS.md that falsely claims `src/` has no folder modules. The
  docs are individually excellent but connectively broken: the README links to
  none of the onboarding docs and its Install section fails the new-project
  case. Also, the suite is red on any machine with slow process spawn (5s
  vitest default vs ~6.5s Node-CLI startup observed here).
- **Smallest thing that solves it:** Fix the four bugs, close the hardening
  gaps, and make one deliberate docs pass — mechanical drift corrections plus
  the connective fixes (README links/install, jargon ordering, baseline in
  getting-started). No new features, no redesigns.
- **Done looks like:** `pnpm check` exits 0 on this machine (test timeouts
  fixed); each bug has a regression test; contract changes carry a **Contract**
  CHANGELOG entry; every drift item from the evaluation is corrected; the
  README reaches all six `docs/` files and both install paths.
- **Explicitly NOT doing:** Windows support; normalizing diagnostics or
  enriching the digest; fsync in the atomic writer; locking around the baseline
  ratchet; mutation testing in CI; auto-detecting the `--changed` base ref;
  exporting `runBaseline`/`runAgentSetup` programmatically (not in the approved
  report). These match the project's stated philosophy (AGENTS.md "What NOT to
  do") or wait for a real consumer.

## Architecture sketch

No new architecture — this is a fix-and-sync batch across the existing seams:
`src/init.ts`, `src/orchestrator.ts`, `src/doctor.ts`, `src/cli.ts`,
`src/agent-setup/hook.ts`, `.github/workflows/`, and the docs set.

## Decisions

- D1: Scope is the full 2026-07-09 evaluation — "now" + "soon" + docs sections
  2–4 together — *because* the human approved the report as-is ("all of these
  suggestions").
- D2: Fix the local red with explicit 30s timeouts on subprocess-spawning
  tests, not machine tuning — *because* the flake class hits any slow-spawn
  machine (CI under load, cold caches), not just this one.
- D3: Unknown names in `--only`/`--skip`/`--include` exit 2 (usage error), not
  0 — *because* a typo silently disabling the gate is the worst remaining
  vacuous-green hole; this is a contract change and gets a Contract CHANGELOG
  entry.
- D4: `init` overwrite protection is new-mode only: refuse with exit 2 listing
  the collisions, `--force` overrides — *because* existing mode is already
  additive-only and needs nothing.
- D5: `init` scaffolds an exact checkride version (no caret) and the README
  install becomes `pnpm add -D -E checkride` — *because* docs/contract.md:120
  tells pre-1.0 consumers to pin exact; init currently scaffolds the footgun.
- D6: The generated Stop hook keeps plain `<pm> run check` (no `--strict`);
  the docs explain the omission instead — *because* cross-PM arg forwarding
  through `run` scripts is inconsistent, and a fail-open local hook backed by
  `--strict` CI beats a Stop hook that can block an agent forever on a
  misconfigured repo. (Flippable — say the word and step 17 changes.)
- D7: CHANGELOG 0.3.0 gets its missing **Contract** heading retroactively
  (`checks_run`, `--strict`, `DEFAULT_TIMEOUT_SECONDS`); the 2026-07-10 date
  stays — *because* the ritual in docs/contract.md:124 demands the heading, and
  the date is the UTC release date, not an error.
- D8: README's `$schema` example is bumped to v0.3.0 now, and the CONTRIBUTING
  release ritual gains "refresh the README `$schema` pin and mutation score" —
  *because* both are hand-maintained numbers that silently drift each release.
- D9: The contract.md "everything is locked by test/contract/" overclaim is
  resolved by adding two cheap contract tests (stream discipline, digest
  presence semantics) and naming the real suite locations for the
  timeout/crash surfaces — *because* moving whole e2e suites would be ceremony.
- D10: Dependabot is security-only — *because* deps are exact-pinned
  (`save-exact=true`) and full version-bump PRs would be noise.
- D11: `doctor`'s version probes get a 30s timeout and report "timed out"
  distinctly from "could not parse" — *because* a diagnostic tool must not
  misdiagnose; 5s is proven too tight on real machines.

## Constraints

- C1: `pnpm check` exits 0 at the end of every step (iterate with
  `--bail`/`--only`; full run before claiming a step done).
- C2: Contract discipline — any change to a promised surface updates
  docs/contract.md and adds a **Contract** entry under Unreleased in
  CHANGELOG.md; never quietly edit `test/contract/`.
- C3: No new runtime dependencies; `publint`/`attw` land as devDependencies
  only.
- C4: Docs edits must keep the `docs`, `links`, and `spell` slots green (add
  genuinely new words to `cspell.json`, never bend prose to the dictionary).
- C5: Every bug fix lands with a regression test that fails on the old code.

## Steps

1. [x] Green the local gate: explicit 30s timeouts on subprocess-spawning tests
   — **done when:** the five 5000ms-timeout failures are gone and the `test`
   slot passes in a full `pnpm check` on this machine.
   - seam: `src/__tests__/cli.test.ts`, `src/__tests__/doctor.test.ts`, `src/__tests__/generated-spell.test.ts`
   - model: sonnet — mechanical, fully specified by the done-when
2. [x] `doctor`: distinguish "timed out" from "could not parse", 30s probe
   timeout — **done when:** a unit test with an injected hanging `env.version`
   yields a hint containing "timed out" (not "parse"), and `checkride doctor`
   exits 0 on this machine.
   - seam: `src/doctor.ts`, `src/__tests__/doctor.test.ts`
3. [x] Bug: `init --baseline --dry-run` must not write the baseline — **done
   when:** a regression test proves a dry run leaves no
   `checkride.baseline.json` (guard around `src/init.ts:570-573`).
   - seam: `src/init.ts`, `src/__tests__/init.test.ts`
   - model: sonnet — one-line guard plus a test
4. [x] Bug: new-mode `init` refuses to overwrite existing files; add `--force`
   — **done when:** `init` in a dir containing e.g. `README.md` but no
   `package.json` exits 2 listing every collision and writes nothing;
   `--force` proceeds; both tested.
   - seam: `src/init.ts`, `src/cli.ts`, `src/__tests__/init.test.ts`, `src/__tests__/cli.test.ts`
5. [x] Bug: unknown slot names in `--only`/`--skip`/`--include` exit 2 —
   **done when:** `checkride --only lints` exits 2 naming the unknown slot and
   the valid set (catalogue slots + config custom-check names); a contract
   test locks it; docs/contract.md and CHANGELOG (Unreleased, **Contract**)
   record it.
   - seam: `src/orchestrator.ts`, `test/contract/flags.contract.test.ts`, `docs/contract.md`, `CHANGELOG.md`
6. [x] Pin policy: `init` writes an exact checkride version; README installs
   with `-E` — **done when:** the generated-project test asserts
   `"checkride": "<version>"` with no caret (`src/init.ts:441`), and
   README's install command uses `pnpm add -D -E checkride`.
   - seam: `src/init.ts`, `src/__tests__/init.test.ts`, `README.md`
   - model: sonnet — mechanical
7. [x] CLI polish: per-command `--help`, `baseline` parses its argv, `init`
   prints next steps — **done when:** `checkride init --help` lists init's
   flags; `checkride baseline --garbage` exits 2; new-project `init` output
   ends with "next: `<pm> install && <pm> run check`"; all tested. Fold in the
   `--include` help-text fix (all five opt-in slots, `src/cli.ts:69`).
   - seam: `src/cli.ts`, `src/init.ts`, `src/__tests__/cli.test.ts`
   - model: sonnet — mechanical, fully specified
8. [x] Orchestrator: clear a slot's stale `.check/` outputs at the start of its
   run — **done when:** a test proves a slot's prior `<slot>.stdout.txt`/
   `<slot>.json` are gone after a later run of that slot succeeds with empty
   output (today they linger — see `persistOutput`,
   `src/orchestrator.ts:222-235`).
   - seam: `src/orchestrator.ts`, `src/__tests__/orchestrator.test.ts`
9. [x] Orchestrator: process-group kill on timeout + UTF-8-safe capture —
   **done when:** a timed-out check's *grandchild* (spawned via a wrapper) is
   dead and the check resolves promptly (detached spawn + `kill(-pid)` in
   `spawnCheck`, `src/orchestrator.ts:172-210`); `setEncoding('utf8')`
   replaces per-chunk `toString()` with a multibyte-boundary test.
   - seam: `src/orchestrator.ts`, `src/__tests__/orchestrator.test.ts`
   - model: opus — subtle process-lifecycle semantics
10. [x] `checkride fix` translates to the detected package manager — **done
    when:** a unit test with an npm-detected fixture shows `defaultFixRunner`
    (`src/orchestrator.ts:471`) spawning the `npx` form via `translateExec`,
    matching the run path.
    - seam: `src/orchestrator.ts`, `src/__tests__/orchestrator.test.ts`
    - model: sonnet — mirrors an existing pattern
11. [x] Friendly file-named errors for malformed consumer JSON — **done when:**
    a malformed `.claude/settings.json` (`src/agent-setup/hook.ts:101`) or
    consumer `package.json` (`src/init.ts:531`) produces an error naming the
    file, no bare stack; tested for both.
    - seam: `src/agent-setup/hook.ts`, `src/init.ts`, tests alongside each
    - model: sonnet — mirrors `src/config.ts:131` which already does it right
12. [x] Repo automation: release tag↔version guard, CI concurrency, Dependabot
    — **done when:** release.yml fails fast when the pushed tag ≠
    `v<package.json version>` (and a `workflow_dispatch` run verifies the
    `v<version>` tag exists and points at HEAD) — guard command shell-tested
    locally; ci.yml has a `concurrency` group; `.github/dependabot.yml` exists,
    security-only.
    - seam: `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `.github/dependabot.yml`
    - model: sonnet — well-trodden YAML
13. [x] Dogfood the library-publishing pair — **done when:** `publint` and
    `attw` are devDependencies, enabled in `checkride.config.json`, and
    `pnpm check --include publint,attw` is green (fix whatever they flag, e.g.
    a missing `sideEffects`).
    - seam: `package.json`, `checkride.config.json`
14. [ ] Docs drift batch (mechanical corrections) — **done when:** each is
    fixed and `pnpm check` is green: AGENTS.md layout diagram + the false "no
    folder modules" claim (AGENTS.md:49-69; the four folder modules +
    `atomic.ts` exist); README `$schema` example → v0.3.0 (README.md:181);
    README config example `origin/master` → `origin/main` (README.md:188);
    README command block gains `--add`/`--author`; `agent-setup` docs say it
    also writes the `check` alias (getting-started:160 "nothing else",
    README:58, cheatsheet:14); CHANGELOG 0.3.0 gains its **Contract** heading
    (per D7).
    - seam: `AGENTS.md`, `README.md`, `docs/getting-started.md`, `docs/cheatsheet.md`, `CHANGELOG.md`
    - model: sonnet — a checklist of verified corrections
15. [ ] Reconcile contract.md's "everything locked by test/contract/" claim —
    **done when:** new contract tests assert stream discipline (default-run
    stdout empty; `--json` stdout parses) and digest presence semantics
    (present iff a failing run passed `--digest`), and contract.md names the
    real suite for timeout/crash surfaces so every listed surface maps to an
    existing test.
    - seam: `test/contract/`, `docs/contract.md`
16. [ ] README restructure (connective fixes) — **done when:** a "Docs" section
    links all six `docs/` files; Install splits into existing-repo
    (`pnpm add -D -E checkride && pnpm exec checkride init`) and new-project
    (`pnpm dlx checkride init --shape flat …`) paths; § Configuration gains
    per-topic subheadings with `detect` introduced before the `extends`
    paragraph that references it (README.md:214 vs 230); slot/adapter defined
    before first use; "deep modules" gets a one-line definition (Ousterhout
    ref); "vacuous green" introduced in prose, not a JSON comment.
    - seam: `README.md`
    - model: opus — prose restructuring with judgment
17. [ ] getting-started + tools.md sync — **done when:** the existing-repo
    section introduces `init --baseline` (the ratchet) instead of only
    "failing checks get disabled"; the prerequisites rows in both files say
    "a package manager: pnpm (default) / npm / yarn / bun" with a one-line
    substitution note; bare `checkride agent-setup` becomes
    `pnpm exec checkride agent-setup`; the "restored by `pnpm install`" claim
    gets its existing-repo caveat; the hard-gate section explains why the hook
    omits `--strict` (D6) and links docs/ci.md.
    - seam: `docs/getting-started.md`, `docs/tools.md`
18. [ ] Docs gaps — **done when:** each has a home and the docs slots are
    green: uninstall/eject paragraph; monorepo runtime behavior note (verify
    actual behavior in code first); `.check/` gitignore guidance for existing
    adopters — plus `init` (existing mode) appending `.check/` to `.gitignore`
    if missing, with test; a generic "any CI" paragraph in ci.md; one line on
    what `fallow` is in tools.md; baseline operations (merge conflicts,
    deliberate re-baseline) in README § Baseline; the digest's actual token
    bound stated; where the coverage threshold lives; CONTRIBUTING release
    ritual gains the D8 refresh line.
    - seam: `docs/getting-started.md`, `docs/ci.md`, `docs/tools.md`, `README.md`, `CONTRIBUTING.md`, `src/init.ts`, `src/__tests__/init.test.ts`

## Open questions

*(none — every fork surfaced during evaluation is settled in D1–D11; D6 is the
one most worth a second look before step 17.)*

## Verdicts

- 2026-07-09 — Stop hook `--strict` fork → chose "document the omission" (D6)
  over changing the generated hook, because cross-PM arg forwarding is
  inconsistent and a fail-open local hook + fail-closed CI is the safer pair.
