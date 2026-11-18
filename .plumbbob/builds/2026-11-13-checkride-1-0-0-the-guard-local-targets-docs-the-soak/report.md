# Report: checkride 1.0.0: the guard, local targets, docs, the soak

All 21 steps landed across seven ranges, 2026-11-14 to 2026-11-18. The build
ends untagged, as D30 (major-after-the-build) decided. It is not yet ready to
tag: the soak has not run, and one gate on the last commit is still owed. See
[Final status](#final-status).

## What shipped

- **The baseline guard and the step summary (steps 1, 2).**
  `checkride baseline diff <ref> --fail-on-added` exits 1 when the working
  tree grandfathers more than `<ref>`, and `--summary github` (or
  `CHECKRIDE_SUMMARY`) appends the run's table to the file
  `GITHUB_STEP_SUMMARY` names.
- **A fix the first stop found (step 21).** Cursor's command-form protect
  hook now drains its payload when checkride is missing. It was parked in
  range 1, settled as a blocker, and landed before the barrel trim.
- **The barrel trim (step 3).** The package root keeps the names consumers
  use, the one break in the build.
- **Local targets (steps 4 to 7).** A target entry may say `"local": true`
  and keep its config at its own root, a root config may `include` files that
  declare targets, and a run finds the repo's config from inside a target.
  `examples/local-targets` shows a web and an api target.
- **Baseline shards (steps 8 to 13).** A local target keeps its keys in
  `<root>/checkride.baseline.json`, and the run's read, the ratchet,
  `baseline`, `baseline diff`, `recover`, the protect hook and `doctor` each
  cover every shard.
- **The docs for 1.0 (steps 14 to 18).** The README is the happy path in
  under 200 lines, its reference sections moved to the pages that own them,
  `docs/team.md` walks a team merging agent-written code, `docs/README.md`
  lists the pages by job, and `SECURITY.md` says how to report a problem.
- **The pin policy (steps 19, 20).** `init` writes `^<version>` in a
  `package.json` from 1.0.0 on and an exact version in a `mise.toml`. The
  contract, `docs/reliability.md`, the install commands and `SECURITY.md` say
  the same, the contract gains "What a minor may do", and the changelog's
  `[Unreleased]` section opens with the upgrade note.

Steps 1 to 13 and 21 shipped in 0.23.0, the only release cut during the
build. Steps 14 to 20 are on `main`, unreleased.

## Decisions and why

- **D1 (freeze-as-is)**: 1.0.0 freezes the surfaces in `docs/contract.md` as
  they stand. Every consumer already reads them, so everything here is
  additive apart from the barrel trim.
- **D4 (minors-then-one)**: each change ships in a 0.x minor, and 1.0.0 is cut
  from the last once the consumers are green and fourteen days pass with no
  Contract entry. A mistake then costs a minor, not a major.
- **D5 (root-export-only)**: the barrel dropped every name no consumer imports
  and no doc shows, since whatever stays is bound for 1.x.
- **D8 (local-targets)** and **D9 (groups-are-files-not-names)**: a target's
  config and an included group live in files at their own roots, with target
  names one flat set, so a monorepo's teams stop sharing two root files.
- **D7 (one-orchestrator)**: the hierarchy is composed into one run, and
  checkride never spawns itself.
- **D10 (baseline-shards)** and **D22 (shards-in-six)**: a local target's keys
  live in its own baseline file, landed as six steps with each reader and
  writer covered in turn.
- **D28 (ratchet-moves-keys)** and **D37 (shards-move-both-ways)**: keys move
  between the root file and a shard on the next full green run, so flipping
  `local` never turns grandfathered findings red.
- **D31 (guard-stays-strict)**: `--fail-on-added` has no override, and the
  recipes run it as its own job outside the required set.
- **D13 (readme-is-the-happy-path)**, **D15 (reference-moves-out)** and
  **D17 (docs-by-job)**: the README holds the pitch, one install and a real
  run, and reference lives under `docs/`, listed by the job a reader has.
- **D19 (support-policy)**: the contract promises that a 1.x minor adds and
  never turns a green repo red, because a caret range is only safe against a
  written promise.
- **D30 (major-after-the-build)**: the build ends at step 20 and never runs
  `/version major`. The tag is Rob's call, and the one step that can't be
  taken back.
- **D32 (soak-clock)**: the fourteen days count Contract entries in a
  published release, with steps 19 and 20's entries exempt by name.

## Parked & harvested

| Park | Why it matters | Settled |
| --- | --- | --- |
| **P1**: [Cursor hook skips stdin](build-log.md#L54) | the payload write raced the hook's exit and turned main's CI red | blocker: 0.23.0 shouldn't ship over a red main; landed as step 21 |
| **P2**: [TOOLS named in packs.md](build-log.md#L55) | the prose named a table the barrel no longer exports | tangent: a wording fix that blocks nothing |
| **P3**: [Six commands don't walk up](build-log.md#L56) | `target add`, `init`, `hooks`, `protect`, `triage` and `qa` read only the directory they are typed in | tangent: it fails loudly and blocks none of the shard steps |
| **P4**: [Local targets missing from docs](build-log.md#L57) | the cheatsheet, README and site said nothing of local targets | tangent: the docs range rewrote those pages anyway |
| **P5**: [Padding flakes under load](build-log.md#L58) | two tests fail when a duration crosses a digit boundary | tangent: test-only, and no shipped behaviour is wrong |
| **P6**: [Hint budget flakes under load](build-log.md#L59) | one orchestrator test misses its 750ms budget on a loaded machine | tangent: the budget is the product's on purpose |
| **P7**: [Old pin wording remains](build-log.md#L60) | `docs/polyglot.md`, an example README and `docs/why.md` don't yet match the caret policy | tangent: three lines outside the seam, and an exact pin is still a valid pin |
| **P8**: [Full mutation run owed](build-log.md#L61) | the done-when's run was stopped at nine hours, so the last commit hasn't had one | tangent: it gates the tag, which is outside this build |

## Final status

Done as a build: every step is checkpointed, and `pnpm check` and the full
`pnpm test:e2e` (253 tests) are green on `ec4d727`.

Not yet ready to tag 1.0.0. What is left before `/version major`:

- **The docs range is unreleased.** The last tag is `v0.23.0`. A
  `/version minor` cut from the current commit would file the 1.0.0 upgrade
  note in `[Unreleased]` under a 0.x release, so move the note out first.
- **The soak has not run.** The five consumers have not moved to the last
  0.x release, and the fourteen days of D4 (minors-then-one) have not
  started.
- **The full mutation run is owed.** Step 20's done-when names it. It was
  stopped after nine hours on Rob's word: a stale `stryker.incremental.json`
  reused 244 of 30,738 results. A focused run over the new pin code killed 6
  of 6 mutants.
- **Private vulnerability reporting was off** on the repository at range 5's
  stop, and `SECURITY.md` points reporters at that form.

D30 (major-after-the-build) has the gates re-run on whatever commit is
tagged.

## Deferred tangents

- Make `target add`, `init`, `hooks`, `protect`, `triage` and `qa` walk up
  from inside a target, as D33 (walk-up-everywhere) intends (P3).
- Steady the three load-sensitive tests (P5, P6).
- Bring `docs/polyglot.md`, `examples/existing-repo-baseline/README.md` and
  `docs/why.md` in line with the caret policy (P7).
- Run the full mutation suite on a quiet machine, which also refreshes
  `stryker.incremental.json` (P8).

## Checkpoints

- baseline e43b39676bdd304da034833b555242a962485ecb
- step 1 76c63b8ef5c92dc5fc3f2196a0ae20ce36a74751
- step 2 8bfec69f340acd89735a40244e26cd7d53cb08b8
- step 21 6e9c0254f823d0c5aa7b94552a66334abc4b54ce
- step 3 35f9a3cc81bc5fc639249bf5e9c6406bc531f316
- step 4 f74492d89c160e4ed8c0a8d6a37f1b0933698e82
- step 5 e9bbb82fc4d9c701b4c3dcec5f85536d333317b3
- step 6 cfc6495a7feb5c6b7d79aa42b681aae88491fca4
- step 7 739405cccb49e377fedee32af70f1d72137db0f4
- step 8 286d7544b9c2630e92df5909c3a6cf35dd4c519d
- step 9 f6297db8f05414a136ebfa76aa53ffe45100f417
- step 10 a658f1681fdbeaf75c152badc135530b0ee44e21
- step 11 61cdbd2dacd96d6a3e8bcbe2fcf595243dfd24ad
- step 12 0bcb35c0dc53342fdc4a38c7ac5e7b1efccbf2cd
- step 13 518b3558d19ba0bd13702930593a1bb365851d00
- step 14 66bfc581d48c46942b75fcae89c601e31251e3ca
- step 15 cc96b35e34b4e2f52a97544455e7bceb3abefcaf
- step 16 5a1ab303e70829106f11e5a82954f6f839753495
- step 17 614392bebc25e817f76582ad42ab3f59c3134e32
- step 18 c42a111b35b58134171cc5e86dee14de4a025fa4
- step 19 ebce3460d1d8dd5c9bc08ba45e475e0a08ee054b
- step 20 ec4d7277ff8ebb88d73ffd2599eb5c6a2968737d

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
| ---- | ---------- | -------------- | ------- | ---------- |
| 1 | 0 | 1 | 0 | 6m |
| 2 | 1 | 0 | 0 | 14m |
| 3 | 0 | 1 | 0 | 15m |
| 4 | 2 | 1 | 0 | 44m |
| 5 | 0 | 1 | 0 | 8m |
| 6 | 0 | 1 | 0 | 11m |
| 7 | 0 | 1 | 0 | 14m |
| 8 | 0 | 0 | 0 | 14m |
| 9 | 1 | 1 | 0 | 19m |
| 10 | 0 | 1 | 0 | 12m |
| 11 | 0 | 1 | 0 | 13m |
| 12 | 0 | 1 | 0 | 9m |
| 13 | 0 | 1 | 0 | 11m |
| 14 | 2 | 0 | 0 | 655m |
| 15 | 0 | 0 | 0 | 7m |
| 16 | 0 | 0 | 0 | 5m |
| 17 | 0 | 1 | 0 | 7m |
| 18 | 0 | 1 | 0 | 3m |
| 19 | 0 | 0 | 0 | 4m |
| 20 | 0 | 1 | 0 | 580m |
| 21 | 1 | 0 | 0 | 58m |
| **total** | 7 | 14 | 0 | 1508m |
