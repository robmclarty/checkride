<!--
build-log.md: your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time. CLI-maintained: `build`,
              `checkpoint`, and `revert` keep this mirror and the Current step line
              in sync with intent.md; you never hand-edit them.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /plumbbob:finish report, which rides the branch into the PR.
-->

# Build log: checkride 1.0.0: the guard, local targets, docs, the soak

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(baseline): fail baseline diff on added keys
- ☑ 2. feat(cli): add --summary github for the step summary
- ☑ 3. feat(api)!: trim the barrel to the names consumers use
- ☑ 21. fix(agent-setup): drain the payload in Cursor's protect hook when checkride is missing
- ☑ 4. feat(config): read a local target's config
- ☑ 5. feat(examples): add a web and api example with local targets
- ☑ 6. feat(config): read included config files with flat target names
- ☑ 7. feat(cli): find the repo's config from inside a target
- ☑ 8. feat(baseline): map each check to its shard and read them all
- ☑ 9. feat(baseline): ratchet each shard on its own
- ☑ 10. feat(baseline): capture and re-record every shard
- ☑ 11. feat(baseline): walk every shard in baseline diff
- ☑ 12. feat(recover): rebuild every shard from history
- ☑ 13. feat(protect): guard every shard from edits
- ☑ 14. docs: move the README's reference sections out
- ☑ 15. docs(readme): rewrite the README to the happy path
- ☑ 16. docs(team): write the page for a team merging agent-written code
- ☑ 17. docs: list the docs by job and shrink getting-started
- ☑ 18. docs: add SECURITY.md
- ☑ 19. feat(init): write a caret pin from 1.0.0 on
- ☑ 20. docs(contract): rewrite the pin policy and promise what a minor may do

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] Cursor protect hook never reads stdin when checkride is missing: the payload write races its exit (spawnSync EPIPE in binary.e2e 'no node' test, CI run 43534933010, ubuntu/node 24); drain stdin with a builtin read loop in protectHookCommand's fallback branch
- [x] docs/packs.md names the TOOLS table six times in prose; with TOOLS off the barrel, reword it as checkride's tool table (step 14's docs move is the natural home)
- [x] target add, init, hooks, protect, triage and qa do not look above the directory they are typed in (step 7 covered the run, fix, doctor, baseline, recover and gate, as its done-when lists): target add typed in web/ writes targets into the local file, which the next run refuses with exit 2 naming it; D33 says every command that reads the config
- [x] docs/cheatsheet.md, README.md and site/ say nothing yet of local targets, include, or running from inside a target; docs/targets.md and docs/contract.md hold all three (the docs range, steps 14 to 17, is the natural home)
- [x] two tests compare a run's stderr with durations replaced by <ms> but keep the column padding, so they fail when a duration crosses a digit boundary under load: test/integration/prose-exemplars.test.ts ('a link out to a directory that exists') and src/orchestrator/__tests__/annotations.test.ts ('nothing else about the run changes'); both flaked once each during range 4 with the machine's load average over 100
- [x] src/orchestrator/__tests__/orchestrator.test.ts 'a red run whose new findings history grandfathered prints the hint' fails when the machine is loaded: the hint's 750ms budget expires before real git answers (seen once in range 4 at load average 147)
- [x] docs/polyglot.md:38 and examples/existing-repo-baseline/README.md:130 still install with -E, and docs/why.md:204 still says a consumer sits on an exact version; all three are outside step 20's seam, so they don't yet match the caret policy
- [x] the full mutation run step 20's done-when names was stopped after nine hours on Rob's word (2026-11-18): a stale incremental report reused 244 of 30,738 results; run it on a quiet machine before tagging 1.0.0

## Harvest  *(run `/plumbbob:harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                               |
| ---------------- | ----------------------------------------- | ------------------------------------ |
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/plumbbob:revert`, fold into intent |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.         |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.           |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- 2026-11-14, at range 1 of 7's stop: 1 parked idea, classified.
- **blocker**: park 1 · Cursor protect hook never reads stdin when checkride is missing: the payload write races its exit (spawnSync EPIPE in binary.e2e 'no node' test, CI run 43534933010, ubuntu/node 24); drain stdin with a builtin read loop in protectHookCommand's fallback branch → main's CI is red on it, and 0.23.0 shouldn't ship over a red main
- 2026-11-14, at the step 3 boundary: 1 parked idea, classified.
- **tangent**: park 2 · docs/packs.md names the TOOLS table six times in prose; with TOOLS off the barrel, reword it as checkride's tool table (step 14's docs move is the natural home) → a prose wording fix that blocks nothing, and step 14's docs move is the natural place to make it
- 2026-11-14, at range 3 of 7's stop: 2 parked ideas, classified.
- **tangent**: park 3 · target add, init, hooks, protect, triage and qa do not look above the directory they are typed in (step 7 covered the run, fix, doctor, baseline, recover and gate, as its done-when lists): target add typed in web/ writes targets into the local file, which the next run refuses with exit 2 naming it; D33 says every command that reads the config → it fails loudly and blocks none of the shard steps
- **tangent**: park 4 · docs/cheatsheet.md, README.md and site/ say nothing yet of local targets, include, or running from inside a target; docs/targets.md and docs/contract.md hold all three (the docs range, steps 14 to 17, is the natural home) → the docs range, steps 14 to 17, rewrites these pages anyway
- 2026-11-17, at range 4 of 7's stop: 2 parked ideas, classified.
- **tangent**: park 5 · two tests compare a run's stderr with durations replaced by <ms> but keep the column padding, so they fail when a duration crosses a digit boundary under load: test/integration/prose-exemplars.test.ts ('a link out to a directory that exists') and src/orchestrator/__tests__/annotations.test.ts ('nothing else about the run changes'); both flaked once each during range 4 with the machine's load average over 100 → a test-only flake that needs a loaded machine to show, and no shipped behaviour is wrong
- **tangent**: park 6 · src/orchestrator/__tests__/orchestrator.test.ts 'a red run whose new findings history grandfathered prints the hint' fails when the machine is loaded: the hint's 750ms budget expires before real git answers (seen once in range 4 at load average 147) → the 750ms budget is the product's on purpose, and only the test's real git misses it under load
- 2026-11-18, at range 6 of 7's stop: 2 parked ideas, classified.
- **tangent**: park 7 · docs/polyglot.md:38 and examples/existing-repo-baseline/README.md:130 still install with -E, and docs/why.md:204 still says a consumer sits on an exact version; all three are outside step 20's seam, so they don't yet match the caret policy → three lines of wording outside the seam, and an exact pin is still a valid pin
- **tangent**: park 8 · the full mutation run step 20's done-when names was stopped after nine hours on Rob's word (2026-11-18): a stale incremental report reused 244 of 30,738 results; run it on a quiet machine before tagging 1.0.0 → it gates the tag, which is outside this build, and no range is left to hold it

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends an entry here
every time a step lands (via `/plumbbob:build` or `/plumbbob:verify`): the dated line,
and beneath it the pause as you approved it, so this fills in as you go, not at the
end, and an older step's detail is a scroll away. Add your own decision/event lines too: this is what
you point at to say "I did that: the LLM helped, but those were my calls."
`/plumbbob:finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*

- 2026-11-14 — step 1 checkpointed · 76c63b8ef — feat(baseline): fail baseline diff on added keys (1 drift, 6m)

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  seam         strayed: 1 path outside the seam
               → docs/spec-v1.md
  diff         +598 -14 across 12 files
               - CHANGELOG.md +24 -0
               - README.md +5 -1
               - docs/cheatsheet.md +1 -0
               - docs/ci.md +37 -0
               - docs/consumers.md +3 -0
               - docs/contract.md +13 -1
               - docs/spec-v1.md +336 -0
               - and 5 more
  spent        6 min · 73s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve it. The read checked every seam against HEAD, each done-when against a test or check that can measure it, and each range's stop against the brief's list of calls; the five holes it found in the spec's done-when lines are settled as D25 to D29. The first two findings sit in range 3 and later, so `/plumbbob:refine` can write them up before step 4 builds, and the third is one commit to make before range 1:

  ```sh
  git add docs/spec-v1.md
  git commit -m "docs: add the 1.0.0 spec"
  ```

  **1.** `extends` in a local file can carry repo-wide keys past the refusal in D8 (step 4)

  D8 lets a local file hold `extends` and refuses `targets`, `schemas`, `unclaimed` and anything
  else that belongs to the whole repo. It doesn't say whether the refusal applies to what a
  preset brings in. Today `resolveExtends` deep-merges a preset, `placedPicks` moves its tool
  picks into `packs.<pack>`, and `presetProblem` stops a preset from declaring targets. A preset
  written for a root config will often carry `gate`, `changedBase` or `schemas`. A builder has to
  guess between refusing the preset (exit 2 naming the key and both files) and dropping the keys
  quietly. Closing it takes one line on step 4: the refused keys are refused after `extends`
  resolves, with the preset named in the error.

  **2.** No decision says what `target add` does once targets are local or included (steps 6 and 10)

  `src/target-command.ts` and `src/target-files.ts` write the root config and rename slots in the
  root baseline. With an `include` in play, the target a team adds may belong in
  `services/checkride.config.json`, and with shards its renamed keys may belong in a shard. Step
  10's seam names `src/target-files.ts`, but no done-when covers it. The cheapest answer is that
  `target add` keeps writing the root config and root baseline, never writes `local` or an
  included file, and `docs/targets.md` says so; a contract test in step 10 pins it.

  **3.** `docs/spec-v1.md` is untracked, and the session's baseline was recorded over a dirty tree

  The intent links to the spec as the design record, but the plan commit takes only the build
  folder, so the link points at a file no commit holds. Step 14's seam doesn't name it either,
  and `/pb-finish` sweeps stray untracked files into its commit. The spec passes `docs`, `spell`,
  `prose` and `links` as it stands (run 2026-11-13), so it won't turn step 1's gate red. Closing
  it is a commit of the spec before range 1 runs, which is Rob's to make. The build is also on
  `main`, as the last several were.

- 2026-11-14 — step 2 checkpointed · 8bfec69f3 — feat(cli): add --summary github for the step summary (1 red, 14m)
- 2026-11-14 — range 1 of 7's stop recorded — push, and confirm this repo's CI run shows the step summary table on the run's page

  **Summary**: The first half of 0.23.0 is in: `checkride baseline diff <ref> --fail-on-added` exits 1 when a change adds a baseline key or grows a count, and `docs/ci.md` runs it as its own job against the merge base. `--summary github` appends a verdict table to the GitHub step summary, and this repo's `ci.yml` turns it on in one job. Neither change is on a remote yet, so the stop's proof, the table on the run's page, comes only after a push.

  1. Both landings were a hair off, and neither is a defect
  2. The step summary gives a row only to checks that ran
  3. The summary's base never falls back to HEAD
  4. The guard reads growth as D2 and the count rule define it

  **Readout**:

  ```text
  steps        2 of 2 landed
               - 1 76c63b8 · 2 8bfec69
  check        green: 1 of 1 checks, 2 landings
  done-when    met
  decisions    3 of 3 honored
               - D31 (guard-stays-strict), D39 (summary-in-ci), D40 (guard-base)
               - D46 (summary-variable)
  constraints  10 of 10 honored
  seam         strayed: 1 path outside step 1's seam
               → docs/spec-v1.md
  diff         +1287 -31 across 22 files
               - .github/workflows/ci.yml +15 -0
               - CHANGELOG.md +42 -0
               - README.md +6 -1
               - docs/cheatsheet.md +2 -0
               - docs/ci.md +69 -0
               - docs/consumers.md +3 -0
               - docs/contract.md +61 -6
               - and 15 more
  spent        20 min · 1 red run · 1 drift warning
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: **1** of 1 parked idea open

  | Park | Why it matters | Lean |
  | --- | --- | --- |
  | **P1**: [Cursor hook stdin race](#park-list) | with no checkride on PATH the hook exits unread, so the payload write can EPIPE | blocker: main's CI is red on it, and 0.23.0 shouldn't ship over a red main |

  **Recommendation**: Confirm the table on run 43534933010's page, then take P1 as a blocker: a one-step bare range ahead of step 3 that drains stdin in the hook's fallback branch, so main goes green before the barrel trim. The pushed run's `pnpm check` passed in the summary job with `CHECKRIDE_BASE` at the commit before the push and no summary warning, so only the e2e race is red, and it predates this range:

  ```sh
  gh run view 43534933010 --web
  ```

  **1.** Both landings were a hair off, and neither is a defect

  Step 1's checkpoint committed the untracked `docs/spec-v1.md` with it, which is outside the seam. It's the spec this plan absorbed and links to, so it belongs in the repo, and it rode along with the first commit. Step 2's first checkpoint was refused because three tests timed out at 5s, while the machine's load average sat near 50 (Proton Drive and other sessions). Those tests passed alone and on the retry, and none of them touches the step-summary code.

  **2.** The step summary gives a row only to checks that ran

  D18 asks for "each check". Here, a check that ran gets a row and every skipped check is named on one `Skipped:` line beneath the table. In a consumer repo most catalogue slots sit out, and a row each would bury the few that ran. The contract doc and the contract test both pin this shape, so changing it later would need a Contract entry.

  **3.** The summary's base never falls back to HEAD

  `--changed` falls back to `HEAD` with a warning when `origin/main` doesn't resolve. Counting against `HEAD` would always show zero keys, so the summary uses D25's order and stops at `origin/main`. When that base can't be read, the two key columns drop out and a line says why. `ci.yml` passes the pull request's base sha, or `github.event.before` on a push, and fetches full history only in the ubuntu/Node 24 job that writes the table.

  **4.** The guard reads growth as D2 and the count rule define it

  A count grows when it rises or turns from a number into `null` ("any number"). It never grows from `null`, and a drop is never growth. The `--json` object keeps its eight fields, and stderr carries the one line saying why it failed.

- 2026-11-14 — step 21 checkpointed · 6e9c0254f — fix(agent-setup): drain the payload in Cursor's protect hook when checkride is missing (1 red, 58m)

  **Summary**: Cursor's command-form protect hook now reads its payload to the end with a builtin `while IFS= read -r line; do :; done` before it answers on any path where `checkride protect` didn't succeed, so a missing checkride no longer closes the pipe under the writer. A unit test pins the read and its place in the line, and the binary e2e's no-node Cursor case passes with a payload four times the pipe buffer.

  1. The drain sits right after checkride's own answer, so every fallback path reads first
  2. The unit test fails without the fix and runs the real command on a bare PATH
  3. The e2e case gains a payload past the pipe buffer, so the race no longer depends on timing
  4. CHANGELOG gains a Fixed section under Unreleased

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  10 of 10 honored
  seam         held: 4 of 4 declared, no strays
  diff         +54 -3 across 4 files
               - CHANGELOG.md +8 -0
               - src/agent-setup/__tests__/hooks.test.ts +27 -3
               - src/agent-setup/scripts.ts +14 -0
               - test/e2e/binary.e2e.test.ts +5 -0
  spent        58 min · 2 turns · 209s gate · 1 red run
  ```

  **Verdict**: ◐ A hair off (1 red run before green)

  **Recommendation**: Approve it, then push `main` and watch the CI run through every job, which is this range's stop. This step exists because CI went red on the race, so a green run on the pushed commit is the proof that matters, more than the local e2e: after `looks good` lands it, run:

  ```sh
  git push origin main
  gh run watch --exit-status
  ```

  **1.** The drain sits right after checkride's own answer, so every fallback path reads first

  `src/agent-setup/scripts.ts` adds `DRAIN_STDIN` as the second statement of the one-line hook, between `out=$(checkride protect ...) && { ...; exit 0; }` and the guard's message. Both fallback branches (checkride missing, and checkride present but `protect` failed) pass through it. On the second branch checkride already read stdin, so the loop meets end of input at once and costs nothing. It uses only `read`, a builtin, because the `PATH` this runs on may hold no `cat`, as D48 asks. A last line with no newline still ends the loop, since `read` consumes it before it reports end of input.

  **2.** The unit test fails without the fix and runs the real command on a bare PATH

  `src/agent-setup/__tests__/hooks.test.ts` gains a test that splits the command on `; ` and asserts the three parts of the loop sit after the `out=$(` step and before the first `printf`, for both the PATH and mise entries. It then runs the PATH form under `/bin/sh` with `PATH=/nonexistent` and a 256 KiB payload and expects no spawn error, exit 0 and an `allow` body. With `scripts.ts` stashed it fails; with the fix all 157 tests in the file pass. The `PATH_FORM` and `MISE_FORM` prefixes the existing tests compare against now include the loop.

  **3.** The e2e case gains a payload past the pipe buffer, so the race no longer depends on timing

  The CI failure (run 43534933010) was a race: a small payload usually fits in the pipe before the shell exits. `test/e2e/binary.e2e.test.ts`'s no-node Cursor case now also sends a 256 KiB `beforeShellExecution` payload on `EMPTY_PATH`, which a hook that skips the drain cannot dodge. `pnpm test:e2e test/e2e/binary.e2e.test.ts` passed 34 of 34 against a fresh SEA build, in the foreground per C6 (foreground-only). I ran only the binary suite, not the whole e2e set; the change touches no other e2e path.

  **4.** CHANGELOG gains a Fixed section under Unreleased

  One entry names the symptom (EPIPE on a `PATH` with no checkride) and the fix. No contract surface moved: the hook's text isn't promised in `docs/contract.md`, so C3 (contract-moves-loudly) has nothing to update.

- 2026-11-14 — step 3 checkpointed · 35f9a3cc8 — feat(api)!: trim the barrel to the names consumers use (1 drift, 15m)

  **Summary**: The package root now exports `runChecks` and `runDoctor` plus five types (`RunOptions`, `RunResult`, `Summary`, `SummaryCheck`, `DoctorCheck`), and drops 12 values and 18 types that no consumer imports and no doc example shows. `checkride/findings` is unchanged. The contract test lists exactly the names that stay, values and types both, and the contract's Programmatic surface section names the same seven.

  1. The survey: who imports what, and what stays
  2. Two removed names are still used by options a kept type takes
  3. Four test files outside the seam moved with the trim
  4. The contract lost its promises about the registries' data

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  bent: C3 (contract-moves-loudly)
               → four test files outside the seam moved with it (section 3)
  seam         strayed: 4 paths outside the seam
               - src/__tests__/adapters.test.ts
               - test/contract/invariance.contract.test.ts
               - test/contract/suites.contract.test.ts
               - test/integration/docs-currency.test.ts
  diff         +106 -192 across 11 files
               - CHANGELOG.md +18 -0
               - README.md +7 -8
               - docs/contract.md +24 -65
               - site/api.html +6 -6
               - src/__tests__/adapters.test.ts +12 -1
               - src/__tests__/index.test.ts +3 -12
               - src/index.ts +7 -27
               - and 4 more
  spent        15 min · 1 turn · 170s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (constraints bent)

  **Recommendation**: Approve the trim as listed: seven names stay, 12 values and 18 types go. These are exactly the names plumbbob imports plus the doc examples' `RunResult`, and nothing a consumer uses breaks. If you'd rather keep `suiteNamed` (and with it `Suite`) for programmatic suite runs, say so before it lands, because whatever stays is bound for 1.x. Once it lands, check the work monorepo's imports, then release 0.23.0 with `/version minor`.

  **1.** The survey: who imports what, and what stays

  Under `~/Projects`, only plumbbob and atis import checkride. volley and runciter run the CLI and import nothing.

  - **plumbbob** (`src/lib/check.ts`, `src/verbs/doctor.ts`, `src/lib/__tests__/check.test.ts`): `runChecks`, `runDoctor`; types `DoctorCheck`, `Summary`, `RunOptions`, `RunResult`, `SummaryCheck`. It derives `GateEnv` from `Parameters<typeof runDoctor>`, which still works.
  - **atis** (`apps/atis/src/sources/check.ts`): `parseFindings` from `checkride/findings`, which isn't touched. It defines its own `SummaryCheck` type and imports none from the root.
  - **Doc examples**: the README's snippet uses `runChecks` and `RunResult`. The contract and `docs/consumers.md` snippets use `Summary` and the findings subpath.

  **Stays (7):** `runChecks`, `runDoctor`, `RunOptions`, `RunResult`, `Summary`, `SummaryCheck`, `DoctorCheck`.

  **Removed values (12):** `runFix`, `selectChecks`, `runInit`, `loadConfig`, `resolveChecks`, `suiteNamed`, `ADAPTERS`, `SLOTS`, `PACKS`, `TOOLS`, `SCHEMA_VERSION`, `DEFAULT_TIMEOUT_SECONDS`.

  **Removed types (18):** `RunFlags`, `CheckrideConfig`, `CustomCheck`, `SlotConfig`, `UseConfig`, `ResolvedCheck`, `Adapter`, `CodeKey`, `Slot`, `Pack`, `Tool`, `DoctorReport`, `DoctorResult`, `InitOptions`, `InitResult`, `ProbeFailure`, `Shape`, `Suite`.

  The work monorepo's imports weren't surveyed, since it isn't under `~/Projects`. The plan's survey says the consumers import the root alone, but not which names. Check before 0.23.0 ships.

  **2.** Two removed names are still used by options a kept type takes

  `RunOptions.suite` takes a `Suite` and `RunOptions.config` takes a `CheckrideConfig`. Both names are gone, but the shapes can still be reached as `RunOptions['suite']` and `RunOptions['config']`. With `suiteNamed` gone, a programmatic suite run spells out its four fields. The contract now lists them (`name`, `configFile`, `baselineFile`, `out`), and following D43 (composed-or-as-written) it says a `config` handed in is the file as written after its `extends`. Keeping `suiteNamed` and `CheckrideConfig` would be the only reason to go beyond the D5 rule. Nothing outside checkride asks for them today.

  **3.** Four test files outside the seam moved with the trim

  - `test/contract/suites.contract.test.ts`: the contract test "suiteNamed is exported from the package root" now hands `runChecks` the suite's fields as a literal and checks they equal what `suiteNamed` builds internally. The CHANGELOG's Contract and Removed entries record it.
  - `test/contract/invariance.contract.test.ts`: imports `ADAPTERS` from `src/adapters.js` instead of the barrel.
  - `test/integration/docs-currency.test.ts`: dropped its check on the contract's "`PACKS` maps each pack's name" sentence, since that sentence went with the registry promises.
  - `src/__tests__/adapters.test.ts`: took over the plain-data round trip and the "PACKS keys each pack by its own name" checks from the exports contract, as internal invariants.

  The exports contract still locks the 600-second default timeout and `SCHEMA_VERSION` 1, importing them from internal modules, because the Timeouts section and the summary schema still promise both values.

  **4.** The contract lost its promises about the registries' data

  The paragraphs on the four registries, the optional fields of an adapter row and of a `TOOLS` row, and `suiteNamed` left the contract, because what they described is no longer public. The Timeouts section now says "the built-in default of 600 seconds", and the pin-source paragraph no longer names `TOOLS`. `docs/packs.md` still names `TOOLS` six times in prose, which is parked for the docs range.

- 2026-11-14 — step 4 checkpointed · f74492d89 — feat(config): read a local target's config (2 red, 1 drift, 44m)
- 2026-11-14 — step 5 checkpointed · e9bbb82fc — feat(examples): add a web and api example with local targets (1 drift, 8m)
- 2026-11-14 — step 6 checkpointed · cfc6495a7 — feat(config): read included config files with flat target names (1 drift, 11m)
- 2026-11-14 — step 7 checkpointed · 739405ccc — feat(cli): find the repo's config from inside a target (1 drift, 14m)
- 2026-11-14 — range 3 of 7's stop recorded — confirm the split of the baseline shards into steps 8 to 13 before any of them builds

  **Summary**: Config now lives with the code. A target entry that says `"local": true` keeps its `lang` and `checks` in `<root>/checkride.config.json`, a config can `include` the files that declare more targets under flat names, and a command typed inside a target finds the repo's config above it and runs from the root, a run narrowed to that target. `examples/local-targets` runs a web app and an API this way, and `pnpm test:e2e` was green twice, 253 tests, before steps 5 and 7 landed. Three things to see before you reply. Every step reached a few files outside its seam, each named in its commit body. Three judgment calls sit inside D42 and D33, in sections 2 and 3. And early in step 4 I ran `pkill -f "dist/cli.js"` to clear my own stopped check: the pattern was too broad, and volley's tournament was running `dist/cli.js` processes on this machine at the time, so check that it lost nothing.

  1. Every step strayed outside its seam, by a file or a few
  2. A preset a local file extends drops more than its top-level keys
  3. Inside a target, three calls D33 left open
  4. Composing sits in one function, and loadConfig still returns the file as written
  5. What went wrong on the way, and what it cost

  **Readout**:

  ```text
  steps        4 of 4 landed
               - 4 f74492d · 5 e9bbb82 · 6 cfc6495 · 7 739405c
  check        green: 1 of 1 checks, 4 landings
  done-when    met
  decisions    honored
               - D8 (local-targets), D9 (groups-are-files-not-names)
               - D29 (suite-local-file), D33 (walk-up-everywhere)
               - D34 (included-file-keys), D35 (local-entry-keys)
               - D36 (named-config-meets-local), D42 (preset-in-local-file)
               - D43 (composed-or-as-written), D44 (one-root-one-local)
               - D45 (walk-up-without-git)
  constraints  10 of 10 honored
  seam         strayed: 12 paths outside 4 steps' seams
               - step 4: README.md and 6 others
               - step 5: test/integration/dogfood-config.test.ts
               - step 6: src/__tests__/config-targets.test.ts and 1 other
               - step 7: src/__tests__/config-targets.test.ts and 1 other
  diff         +3677 -167 across 45 files
               - CHANGELOG.md +59 -0
               - README.md +2 -1
               - checkride.config.json +5 -0
               - docs/contract.md +129 -7
               - docs/targets.md +155 -1
               - docs/tools.md +5 -2
               - examples/README.md +1 -0
               - and 38 more
  spent        79 min · 2 red runs · 4 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: **2** of 4 parked ideas open

  | Park | Why it matters | Lean |
  | --- | --- | --- |
  | **P3**: [Commands that don't look up](#park-list) | `target add` typed in `web/` writes targets into the local file, which the next run refuses with exit 2 | tangent: it fails loudly and blocks none of the shard steps |
  | **P4**: [Front-page docs lag targets](#park-list) | the cheatsheet, the README and the site don't mention local targets, `include` or running from inside a target | tangent: the docs range, steps 14 to 17, rewrites these pages anyway |

  **Recommendation**: Confirm the split of steps 8 to 13 as planned, and take both parks as tangents. Nothing in this range argues for a different cut: a composed target still says `local: true` and the config remembers each target's declaring file, which is what step 8's shard map reads, a run from inside a target is already partial, so step 9's rule that a partial run writes no shard covers it, and the walk-up half of D41 (diff-reads-config) landed here for `baseline diff` and `recover`, leaving steps 11 and 12 the config load alone. Before you reply, check volley's tournament for a run my `pkill` may have killed.

  **1.** Every step strayed outside its seam, by a file or a few

  Step 4 touched `src/orchestrator/context.ts` (one line, so a config handed to `runChecks` composes), and the third bundled schema, `checkride:checkride-local`, moved the list in `src/schema/rules.ts`, three tests, `README.md` and `docs/tools.md`. Step 5 changed `test/integration/dogfood-config.test.ts`, which now holds each tracked config to one schema or the other. Step 6 put its file-backed tests in `src/__tests__/config-targets.test.ts` and updated a key list in `src/__tests__/config.test.ts`. Step 7 put the finder's tests in the same file and added one field to `src/targets/include.ts`. Step 7's seam also named `src/gate.ts` and `src/orchestrator/context.ts`, and neither needed a change: the CLI hands the gate the root as its `cwd`.

  **2.** A preset a local file extends drops more than its top-level keys

  D42 (preset-in-local-file) says a local file takes from a preset the keys it may hold, and each other key is dropped with a warning. Read to the letter that leaves a team preset's `"spell": false` inside the inherited `checks`, where a target's rules refuse a repo-scope slot, so extending a root preset would be exit 2. I extended D42 the way it reads: a `checks` entry for a repo-scope slot is dropped with the same warning, and a tool pick that only another pack's adapter answers, `"lint": "oxlint"` under a Go target, is left out silently, as `placedPicks` already moves such a pick at the root. A preset that declares `targets` is still exit 2. A key of the local file's own that no config reads is a warning, as at the root, and not a refusal: D8 (local-targets) refuses what belongs to the whole repo, and a typo doesn't.

  **3.** Inside a target, three calls D33 left open

  A config above that declares a local target or includes a file, and can't be loaded, is exit 2 naming it. Reading the directory alone there would give the second, wrong verdict Q4 (running-inside-a-target) rules out. Any other unreadable config above is passed over, as some other project's. A directory inside a target declared whole is not claimed, since D33 (walk-up-everywhere) names local targets and included files only, so `checkride` typed in such a directory still reads it as a repo of its own. And a run's own `--only` is read inside the directory's targets: `--only lint` in `web/` is `web:lint`, and a token that selects nothing there is exit 2 pointing at the root. The highest config that claims the directory wins, and a config file in between that isn't a local or an included file keeps its directories, which is how `examples/local-targets/web` inside this repo finds the example's root and not checkride's.

  **4.** Composing sits in one function, and loadConfig still returns the file as written

  `composedConfig` in `src/config.ts` joins the included files' targets, then folds each local file in, and holds the result to every rule a config keeps. `resolveChecks` and the run context both call it, so the repo's config, a `--config` file and a config handed to `runChecks` compose alike, as D43 (composed-or-as-written) decided. `loadConfig` reads the same files as it loads, so a broken local or included file is exit 2 at the load, and the answer is remembered per config so nothing is read or warned about twice. A composed target keeps `local: true`, and the composed config remembers which file declares each target and which file includes which. Step 8's shard map can read all three. Two additions past the plan's lists: `timeout` in a local file is validated as a number of seconds, and an included file that declares nothing and includes nothing is exit 2, as are files that declare no target between them. `doctor`'s targets carry `file` only once a config includes one, so a repo with no `include` reports byte for byte as before.

  **5.** What went wrong on the way, and what it cost

  My first full `pnpm check` hit the 120-second limit and slipped into a background task. I stopped it at once, before it could finish and notify, and ran every later check in the foreground. To clear its children I ran `pkill -f "dist/cli.js"`, which matches any project's built CLI, volley's among them. I can't tell what it hit, and I didn't touch those processes again. Step 4's checkpoint was then refused twice on 5-second test timeouts, with this machine at a load average of 44 to 55 on 8 cores from other sessions' work. The same tests pass alone in about a second. I waited about nineteen minutes for the load to ease, it didn't, and the third try landed. The two `pnpm test:e2e` runs were started detached to a log and waited on in the foreground, so neither became a background task.

- 2026-11-14 — step 8 checkpointed · 286d7544b — feat(baseline): map each check to its shard and read them all (14m)
- 2026-11-14 — step 9 checkpointed · f6297db8f — feat(baseline): ratchet each shard on its own (1 red, 1 drift, 19m)
- 2026-11-14 — step 10 checkpointed · a658f1681 — feat(baseline): capture and re-record every shard (1 drift, 12m)
- 2026-11-14 — step 11 checkpointed · 61cdbd2da — feat(baseline): walk every shard in baseline diff (1 drift, 13m)
- 2026-11-14 — step 12 checkpointed · 0bcb35c0d — feat(recover): rebuild every shard from history (1 drift, 9m)
- 2026-11-14 — step 13 checkpointed · 518b3558d — feat(protect): guard every shard from edits (1 drift, 11m)
- 2026-11-17 — range 4 of 7's stop recorded — run the merge-queue proof in runciter's sandbox repo from the hand-over, record the result in runciter's scheduler note, then release 0.24.0 with `/version minor`

  **Summary**: A local target now keeps its baseline keys in `<root>/checkride.baseline.json`, and every reader and writer covers it: the run's mask, the ratchet, `baseline`, `baseline --versions`, `baseline diff`, `recover`, the protect hook and `doctor`. A repo with one baseline file takes the same code paths and behaves as it did, which the untouched single-file tests hold. Two things to know before the release: `package.json` still says 0.22.0 and the changelog's Unreleased section holds the 0.23.0 entries too, so `/version minor` will cut 0.23.0 and not 0.24.0; and the full `pnpm test:e2e` and a mutation run were not run, since the machine sat at a load average above 100 from other projects, only four e2e files and the local-targets example.

  1. Steps 9 to 13 each staged a file or two outside their seam, all for one reason
  2. Five calls the decisions left open, each made the conservative way
  3. What changes for a repo already on 0.22, each under the changelog's Contract heading
  4. What was verified, and what was not
  5. The version the release will cut is 0.23.0

  **Readout**:

  ```text
  steps        6 of 6 landed
               - 8 286d754 · 9 f6297db · 10 a658f16 · 11 61cdbd2 · 12 0bcb35c
               - 13 518b355
  check        green: 19 of 19 checks, 6 landings
  done-when    met
  decisions    honored
               - D10 (baseline-shards), D12 (suites-unchanged)
               - D22 (shards-in-six), D28 (ratchet-moves-keys)
               - D37 (shards-move-both-ways), D41 (diff-reads-config)
               - D47 (mangled-shard), D2 (fail-on-added)
  constraints  10 of 10 honored
  seam         strayed: 11 paths outside 5 steps' seams
               - step 9: src/__tests__/baseline.test.ts and 2 others
               - step 10: src/baseline/index.ts
               - step 11: src/__tests__/baseline.test.ts and 2 others
               - step 12: src/baseline-command.ts, src/baseline/index.ts
               - step 13: src/baseline/index.ts, src/baseline/shards.ts
  diff         +2997 -292 across 32 files
               - CHANGELOG.md +101 -3
               - docs/consumers.md +6 -0
               - docs/contract.md +148 -4
               - docs/suites.md +7 -0
               - docs/targets.md +36 -0
               - examples/local-targets/README.md +7 -0
               - src/__tests__/baseline-history.test.ts +132 -1
               - and 25 more
  spent        79 min · 1 red run · 5 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: **2** of 6 parked ideas open

  | Park | Why it matters | Lean |
  | --- | --- | --- |
  | **P5**: [Padded durations flake two tests](#park-list) | two output comparisons fail when a duration gains a digit under load | tangent: a test-only flake that needs a loaded machine to show, and no shipped behaviour is wrong |
  | **P6**: [Recover hint test times out](#park-list) | the hint's budget expires before git answers on a loaded machine | tangent: the 750ms budget is the product's on purpose, and only the test's real git misses it under load |

  **Recommendation**: Run the full e2e suite on a quiet machine before the merge-queue proof, then run the proof against this commit and release once with `/version minor`, accepting 0.23.0 as the number. The shard code is green on everything `pnpm check` covers, but the binary, consumer and language-pack e2e files have not seen it, and a release is the one step here that can't be taken back. Cutting 0.23.0 now and 0.24.0 straight after, to match the plan's numbers, would publish a release nobody ran. Both parks are tangents: they are test flakes under load, and neither touches what ships.

  ```sh
  pnpm test:e2e
  ```

  **1.** Steps 9 to 13 each staged a file or two outside their seam, all for one reason

  Every step's checkpoint flagged strays. Each is the barrel `src/baseline/index.ts`, which re-exports what `src/baseline/shards.ts` gained, or a caller the step's seam left out:

  - step 9: `src/orchestrator/context.ts` carries the shard read on the run context in place of `baselineState`, and `src/__tests__/baseline.test.ts` follows the read's new `map` field;
  - step 11: `src/orchestrator/run.ts` hands the step summary the run's shard map, and `src/__tests__/baseline.test.ts` swaps the flag in the case that expected `baseline diff --config` to be refused;
  - step 12: `src/baseline-command.ts` changed because `targetsForBaseline` in `src/config.ts` became one function for `baseline diff` and `recover`, after fallow flagged the two copies as a clone;
  - step 13: `src/baseline/shards.ts` gained two small helpers `doctor` calls.

  Nothing reached past the baseline's own surface. Two seam files needed no change and got none: `src/target-files.ts` (step 10), since `target add` converts a repo with no target, and `test/e2e/hook-scripts.e2e.test.ts` (step 13), which has no protect case to extend.

  **2.** Five calls the decisions left open, each made the conservative way

  - **A capture refuses an unreadable file rather than skipping it.** D47 says no `checkride baseline` writes over a file it couldn't parse. With the baseline spread over more than one file, `baseline`, `baseline --only`, `baseline --skip` and `baseline --versions` are exit 2 naming the file before anything runs. The other reading, write the rest and warn, would exit 0 on a capture that recorded nothing for one target. A repo whose baseline is the root file alone keeps 0.23's behaviour, where a full capture replaces a mangled file.
  - **`recover` is one list of candidates for the whole baseline.** A commit to any file is a candidate, read as the merged baseline at that commit, and `--pick` spreads the restored keys by owner. Per-file candidate lists would have needed a new flag and broken `--pick <n>`.
  - **An entry in a target's file for another target's check is never read, moved or dropped.** It masks nothing, and a rewrite of the file keeps it. Dropping it would be a writer deleting what it doesn't understand.
  - **A baseline file at a non-local target's root that holds none of that target's checks is never removed.** D37 has the ratchet delete a shard left behind. A nested repo's own baseline at a target's root looks the same on disk, so the file goes only once it held that target's keys and they have moved to the root file.
  - **`doctor` exempts a nested repo's baseline from the unowned list.** A file of the baseline's name at no declared target's root is named, unless a config sits beside it with no top-level `lang`, which only a local target's file sets. This repo's three example baselines are the case, and the search runs only where targets are declared.

  Step 8's done-when says a repo with no local target reads exactly the one file it reads today. It does, with one exception D37 asks for: a declared target that isn't local and has a baseline file at its root now has that file read, for that target's checks alone.

  **3.** What changes for a repo already on 0.22, each under the changelog's Contract heading

  - Under Cursor, `checkride protect` and the generated hook script deny a write to a file named like the baseline at any depth inside the project. A write to `fixtures/checkride.baseline.json` was allowed and is now denied, as it always was under Claude Code's `Edit(**/checkride.baseline.json)`. A generated script needs `checkride agent-setup` to pick it up.
  - `baseline diff` and `recover` read a config, take `--config`, and read `CHECKRIDE_CONFIG`. `baseline diff --config` used to be an unknown option. A CI job that sets `CHECKRIDE_CONFIG` to a file that is missing now gets exit 2 from both.
  - stderr's `baseline: ratcheted …` and `baseline: wrote …` lines come once per file written. A repo with one file sees the same single line.

  **4.** What was verified, and what was not

  `pnpm check` was green at each of the six checkpoints. The new behaviour has 150 or so tests: unit tests for every function in `shards.ts`, orchestrator tests over real files, and contract tests in `test/contract/baseline.contract.test.ts`, `protect.contract.test.ts` and `step-summary.contract.test.ts`, the `baseline diff` and `recover` ones over real git repos.

  Not run: the full `pnpm test:e2e`, and any mutation run. Run instead, before step 13 landed: `existing`, `out` and `invariance` e2e files (green), `hook-scripts` (skips itself here), and the `local-targets` example (green). `examples/local-targets` gained a README paragraph and no baseline of its own.

  Three tests failed once each under the load and passed on a rerun, with and without the change: the two in P5 and the one in P6. One checkpoint (step 9) was refused on them and landed on the retry.

  **5.** The version the release will cut is 0.23.0

  Range 2's stop was to release 0.23.0, and it never ran: the last tag is `v0.22.0`, `package.json` says 0.22.0, and `[Unreleased]` in `CHANGELOG.md` holds the guard, `--summary github`, the barrel trim and the Cursor hook fix beside everything from steps 4 to 13. `/version minor` will bump to 0.23.0 and file all of it there. The plan's later numbers (0.25.0 for the docs, the soak on "the last release before step 19") then each read one lower, and D32 (soak-clock) names no number, so nothing in the plan breaks.

- 2026-11-18 — step 14 checkpointed · 66bfc581d — docs: move the README's reference sections out (2 red, 655m)

  **Summary**: The README's reference now lives under `docs/`: commands on the cheat sheet, slots, adapters and packs in the tools guide, `.check/` in the contract, and two new pages, `docs/configuration.md` and `docs/baseline.md`. Every link to a moved heading is repointed, and a test proves none is left dangling. `plumbbob check` was green (90s), but both checkpoint runs then went red on a different 5-second test timeout each time. The machine's load average was 42, with Proton Drive's file provider using over 200% CPU, so the step hasn't landed.

  1. The checkpoint's gate went red on timeouts the diff doesn't touch
  2. Each section went to the page D15 names
  3. The two new pages keep the README's text and add headings
  4. The anchor proof follows GitHub URLs too
  5. What the README still holds for step 15

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  bent: C1 (one-green-commit)
               → the gate's test slot timed out twice under load; see 1
  seam         held: 14 of 15 declared, no strays
  diff         +768 -682 across 17 files
               - README.md +26 -644
               - docs/README.md +13 -6
               - docs/baseline.md +165 -0
               - docs/cheatsheet.md +29 -0
               - docs/ci.md +3 -3
               - docs/configuration.md +184 -0
               - docs/contract.md +118 -1
               - and 10 more
  spent        10h 55m · 1 turn · 50s gate · 2 red runs
  ```

  **Verdict**: ○ Out of plumb (constraints bent)

  **Recommendation**: Let the load settle (pause Proton Drive's sync if you can), then say `looks good` and I'll run the checkpoint again with no change to the diff. The first full check passed, both failures were 5-second timeouts in files this step doesn't touch, and the machine was running at about four times its core count.

  **1.** The checkpoint's gate went red on timeouts the diff doesn't touch

  The first `plumbbob check` passed every slot, with the test slot at 75s. The two checkpoint runs after it took 115s and 121s for tests and failed in `src/orchestrator/__tests__/static-only.test.ts`, then in `test/contract/flags.contract.test.ts`, each with `Test timed out in 5000ms`. Neither file is in the seam, and neither reads the docs. `uptime` showed load averages of 42, 48 and 41, and `ps` put `ProtonDriveFileProviderMac` at 214% CPU. Once the load drops, a retry should land the step unchanged.

  **2.** Each section went to the page D15 names

  The cheat sheet gained sections for `agent-setup`, `baseline` (its flags and `diff --fail-on-added`), and `gate`, `protect`, `triage` and `qa`. That fills the gaps between its command list and the README's full block. `docs/tools.md` opens with "Slots and adapters": the slot table with scope, the opt-in sentence, `unclaimed` and `schema`, and the language packs table. Its "Package managers" section took the README's paragraph about the spelled-for-the-manager commands and the manager-specific slots. The README's `optIn` and publish-bundle paragraphs were already covered further down the page, so they became links. `docs/contract.md` gained "The `.check/` directory" ahead of the summary's field-by-field section, including the red-run excerpt rules. A line there says those lines are the human report, and a parser reads the summary instead, so the section promises nothing new. The README's duplicate of the vacuous-green paragraph became a link to the contract's own section.

  **3.** The two new pages keep the README's text and add headings

  `docs/configuration.md` is the Configuration section whole, with its subsections promoted to `##`. Its intro now points at targets, suites and the baseline, and a new paragraph points at local targets and included files in `docs/targets.md`. `docs/baseline.md` is the Baseline section split under six headings: the file, every run, version moves, re-baselining and `diff`, merges and `recover`, which checks it keys, and adopting. It gained one paragraph linking the shard rules in `docs/targets.md` and a link to `examples/existing-repo-baseline`.

  **4.** The anchor proof follows GitHub URLs too

  The examples link the README by its `github.com/.../blob/main/README.md#…` URL, not a relative path. So the new test in `test/integration/docs-currency.test.ts` matches both forms. It reads `docs/`, `examples/` (skipping `node_modules`) and `test/fixtures/`, builds the README's anchors the way GitHub does (skipping fenced blocks and numbering repeated headings), and fails naming each dead link. A test I broke on purpose (`#the-gone-one` in `docs/why.md`) failed as it should. The sweep also turned up `docs/ci.md`'s `#agent-integration` link, which was already dead before this step. It now points at the cheat sheet's `gate` section. A second new test checks that every `blob/main/` URL in the CLI help names a file that exists, since the `baseline` and `recover` help now link `docs/baseline.md`.

  **5.** What the README still holds for step 15

  The README is down from 997 lines to 379. The thesis, Install, the agent hooks, the Docs list, the plugin, Project shapes, Conventions, Tested envelope and the programmatic API are still there, for step 15's rewrite. Three example READMEs and a fixture still link `#conventions`, and `docs/why.md` links `#the-thesis`. When step 15 removes either heading, the new test will name those links.

- 2026-11-18 — step 15 checkpointed · cc96b35e3 — docs(readme): rewrite the README to the happy path (7m)
- 2026-11-18 — step 16 checkpointed · 5a1ab303e — docs(team): write the page for a team merging agent-written code (5m)
- 2026-11-18 — step 17 checkpointed · 614392beb — docs: list the docs by job and shrink getting-started (1 drift, 7m)

  **Summary**: `getting-started.md` goes from 865 lines to 182 and now covers only the ten minutes after the README: install, what `init` wrote, the first run, a red run, the daily loop, and a pointer to the stop gate. `docs/README.md` lists all 27 pages under Start, Adopt on a team, Run in CI and Reference, and a new test fails if any page under `docs/` is missing from those sections. The roughly 425 lines on agents and the stop gate had no page in the seam to go to, so they now sit in a new `docs/agents.md`. That page, and a one-line link fix in `docs/cursor.md`, are outside the seam, and that's why this step stopped here.

  1. The agents half moved to a new page outside the seam
  2. The other moves stayed inside the seam
  3. The index test checks every page, the design records included

  **Readout**:

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    bent: D17 (docs-by-job)
               → the agents half needed a page the seam lacks; see 1
  constraints  10 of 10 honored
  seam         strayed: 2 paths outside the seam
               - docs/cursor.md
               - docs/agents.md
  diff         +803 -852 across 7 files
               - docs/README.md +76 -88
               - docs/agents.md +426 -0
               - docs/configuration.md +45 -0
               - docs/cursor.md +1 -1
               - docs/distribution.md +145 -0
               - docs/getting-started.md +78 -761
               - test/integration/docs-currency.test.ts +32 -2
  spent        7 min · 1 turn · 52s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (decisions bent)

  **Recommendation**: Approve `docs/agents.md` as the agents page and land step 17 as it stands. The gate material is reference that a reader needs after the first ten minutes, and splitting it across `plugin.md` and `cursor.md` would scatter one topic over two pages that are each about something else. If you'd rather the seam had held, the other option is to keep a trimmed "Working with agents" in getting-started, and that breaks the ten-minute done-when.

  **1.** The agents half moved to a new page outside the seam

  D17 says the rest of getting-started "moves to the pages that own each topic", but no page in step 17's seam owns the agent hooks. The material is the AGENTS.md stanza, the three hooks, gate profiles, `gate.preflight`, turning the gate off, `checkride gate`'s harness split, seeing the gate run, and avoiding duplicate runs. I moved it whole, word for word, into `docs/agents.md` ("Working with agents"), with each heading raised one level so every anchor (`#make-it-a-hard-gate`, `#the-gate-command`, `#turning-the-gate-off`, `#when-the-gate-is-too-slow`) still resolves inside the page. `docs/cursor.md` linked `getting-started.md#make-it-a-hard-gate`, so it now points at `agents.md`. The `links` check ignores fragments, so it would not have caught that broken link. Neither `plugin.md` nor `cursor.md` fit: one covers the skills, the other covers Cursor's differences, and neither covers the Claude Code gate. The `CHANGELOG.md` entry that links `getting-started.md#when-the-gate-is-too-slow` is history, so I left it alone.

  **2.** The other moves stayed inside the seam

  The TypeScript new-project walk-through (shapes, the `src/` and `test/` trees) and the new Go or Rust project went to `distribution.md` under "Starting a new project". "Uninstalling" moved there too, and now also names a local target's config and baseline files. So did the details of adopting a repo without Node. The config `init` writes, with why the file rather than detection picks each tool and why `typecheck-tests` exists, went to `configuration.md` as "The config `init` writes". The test that checks the drawn `test/` tree against `test-dir-layout.yml` now reads `distribution.md`, because that tree lives there now. `site/docs.html` needed no change: its sections mirror the site's own pages, not getting-started's anchors.

  **3.** The index test checks every page, the design records included

  `docs-currency.test.ts` walks `docs/` recursively for markdown and requires each page to be linked from one of the four job sections. It also checks that the sections are exactly those four, in order, and that every page they link exists. The five `spec-*.md` design records go under Reference, in a short "Design records" list, because the done-when says every page under `docs/`.

- 2026-11-18 — step 18 checkpointed · c42a111b3 — docs: add SECURITY.md (1 drift, 3m)
- 2026-11-18 — range 5 of 7's stop recorded — review the docs and release 0.25.0 with `/version minor`; then move the five consumers to it, the work monorepo by Rob, and wait out the fourteen-day soak

  **Summary**: The docs are reshaped for 1.0: the README is the happy path in 167 lines, its reference sections live in the pages that own them, `docs/team.md` walks a team merging agent-written code, `docs/README.md` lists every page by job, and `SECURITY.md` says how to report a problem and that the latest release gets fixes. One thing to do before releasing: `SECURITY.md` sends reporters to GitHub's "Report a vulnerability" form, and private vulnerability reporting is off on the repo today, so the form's link fails until it's switched on in Settings, under Security.

  1. `SECURITY.md` names a reporting form the repo hasn't switched on yet.
  2. Step 18 touched `checkride.config.json`, outside its seam.
  3. The contract links `SECURITY.md` and promises nothing new.
  4. Step 17 moved the agents half of getting-started to a new page, approved at its pause.
  5. `docs-currency.test.ts` now holds the docs' shape.

  **Readout**:

  ```text
  steps        5 of 5 landed
               - 14 66bfc58 · 15 cc96b35 · 16 5a1ab30 · 17 614392b · 18 c42a111
  check        green: 1 of 1 checks, 5 landings
  proof        met
  decisions    honored:
               - D13 (readme-is-the-happy-path), D14 (the-pitch)
               - D15 (reference-moves-out), D16 (team-page)
               - D17 (docs-by-job), D19 (support-policy)
               - D26 (anchor-proof), D27 (workflow-cover)
               - D31 (guard-stays-strict), D38 (security-before-one)
               - D40 (guard-base)
  constraints  10 of 10 honored
  seam         strayed: 3 paths outside 2 steps' seams
               - step 17: docs/agents.md, docs/cursor.md
               - step 18: checkride.config.json
  diff         +2136 -1878 across 26 files
               - README.md +157 -987
               - SECURITY.md +34 -0
               - checkride.config.json +1 -1
               - docs/README.md +89 -94
               - docs/agents.md +426 -0
               - docs/baseline.md +165 -0
               - docs/cheatsheet.md +29 -0
               - and 19 more
  spent        11h 29m · 2 red runs · 2 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Read the README, `docs/team.md`, `docs/README.md` and `SECURITY.md`, switch on private vulnerability reporting, then release with `/version minor`. The full check is green on c42a111, and this range ran the end-to-end suite only for the local-targets example in step 16, so run the whole suite in the foreground before the release:

  ```sh
  mise exec -- pnpm test:e2e
  ```

  The consumers and the fourteen-day soak follow the release, and range 6 waits until both are clear.

  **1.** `SECURITY.md` names a reporting form the repo hasn't switched on yet.

  Step 18 had to choose where a report goes, since D19 (support-policy) says only that the file says how. It names GitHub's private "Report a vulnerability" form at `https://github.com/robmclarty/checkride/security/advisories/new`, which keeps a report private and publishes no email address. `gh api repos/robmclarty/checkride/private-vulnerability-reporting` answers `{"enabled":false}`, so the link doesn't work until the setting is on. Switching it on is a repo setting and was left to Rob. If an email address is the better channel, that is a one-line change to `SECURITY.md`, and step 20 already has the file in its seam.

  **2.** Step 18 touched `checkride.config.json`, outside its seam.

  `test/integration/dogfood-config.test.ts` fails on a tracked `.md` that vale's path list can't reach, so `SECURITY.md` joined the `prose` check's paths beside `CONTRIBUTING.md`. The other choice was to add it to the test's excluded set, which would have left the file unlinted. The checkpoint's verdict reads "a hair off (seam strayed)" for this one path.

  **3.** The contract links `SECURITY.md` and promises nothing new.

  The line under "Versioning and pin policy" says where to find how to report a problem and which versions get fixes. The promise itself lives in `SECURITY.md`, so no contract test or `### Contract` changelog entry moved, in keeping with C3 (contract-moves-loudly). `package.json`'s `files` ships `SECURITY.md` so the README's link to it resolves inside the tarball. It says "the latest release" as D38 (security-before-one) decided, and step 20 changes it to the latest 1.x.

  **4.** Step 17 moved the agents half of getting-started to a new page, approved at its pause.

  `docs/getting-started.md` shrank from 865 lines to 182. The agents-and-gate half moved whole into a new `docs/agents.md` with its anchors kept, and `docs/cursor.md`'s link followed it; both were outside the step's seam and were approved as seam drift at the pause. New-project setup and uninstalling moved to `docs/distribution.md`, and the config `init` writes moved to `docs/configuration.md`.

  **5.** `docs-currency.test.ts` now holds the docs' shape.

  It pins the README's line count, pitch and two-command install block (step 15), proves every README fragment linked from `docs/`, `examples/` and the fixtures names a heading the README has (step 14), holds the team page's yaml block byte for byte to `examples/local-targets/.github/workflows/check.yaml` and parses it (step 16), and fails on any page under `docs/` that isn't linked beneath a job in `docs/README.md` (step 17).

- 2026-11-18 — step 19 checkpointed · ebce3460d — feat(init): write a caret pin from 1.0.0 on (4m)
- 2026-11-18 — step 20 checkpointed · ec4d7277f — docs(contract): rewrite the pin policy and promise what a minor may do (1 drift, 580m)
- 2026-11-18 — range 6 of 7's stop recorded — review the pin policy and the minor-version promise as landed; the build ends here, untagged, and 1.0.0 waits for Rob's own call after it

  **Summary**: The pin policy for 1.0 is in place and inert until the tag: `init` writes `^<version>` in a `package.json` once the product version reaches 1.0.0 and an exact version in a `mise.toml`, and the contract, `docs/reliability.md`, the install commands and `SECURITY.md` say the same, with a new "What a minor may do" section in the contract and an `[Unreleased]` changelog section that opens with the upgrade note. Three things to know before 1.0.0. The full mutation run step 20's done-when names did not finish: it was stopped after nine hours on your word, and a focused run over the new pin code killed 6 of 6 mutants. The soak has not happened: the last tag is `v0.23.0`, so the docs range, the consumers' move and the fourteen days are all still ahead, and a `/version minor` cut from here would file the 1.0.0 upgrade note under a 0.x release. And `pnpm check` and the full `pnpm test:e2e` (253 tests) are green on `ec4d727`.

  1. The full mutation run was stopped, and a focused run stands in for it.
  2. Step 20 fixed a link in the local-targets example, outside its seam.
  3. The install commands dropped `-E`.
  4. The pin rule is one function keyed on the major.
  5. The minor-version promise is written as D19 and Q3 decided it.

  **Readout**:

  ```text
  steps        2 of 2 landed
               - 19 ebce346 · 20 ec4d727
  check        green: 1 of 1 checks, 2 landings
  proof        not met: step 20's full mutation run was stopped on Rob's word
  decisions    4 of 4 honored
  constraints  10 of 10 honored
  seam         strayed: 1 path outside step 20's seam
               → examples/local-targets/README.md
  diff         +205 -38 across 11 files
               - CHANGELOG.md +36 -0
               - README.md +1 -1
               - SECURITY.md +4 -4
               - docs/contract.md +31 -8
               - docs/distribution.md +6 -4
               - docs/getting-started.md +4 -4
               - docs/reliability.md +13 -6
               - and 4 more
  spent        9h 44m · green first run at every landing · 1 drift warning
  ```

  **Verdict**: ○ Out of plumb (proof not met)

  **Harvested**: **2** of 8 parked ideas open

  | Park | Why it matters | Lean |
  | --- | --- | --- |
  | **P7**: [Old pin wording remains](#park-list) | `docs/polyglot.md`, an example README and `docs/why.md` don't yet match the caret policy | tangent: three lines of wording outside the seam, and an exact pin is still a valid pin |
  | **P8**: [Full mutation run owed](#park-list) | the done-when's run was stopped at nine hours, so the tagged commit hasn't had one | tangent: it gates the tag, which is outside this build, and no range is left to hold it |

  **Recommendation**: Read "Versioning and pin policy" and "What a minor may do" in `docs/contract.md`, then confirm both parks as tangents. The policy is written as Q1, D19 and Q3 decided it and is inert until the version reaches 1.0.0, so nothing here changes what a 0.x release does. Before tagging, release the docs range as a 0.x minor, run the soak, and run the full mutation suite on a quiet machine; if that minor is cut from this commit, move the upgrade note out of its `[Unreleased]` entry first.

  **1.** The full mutation run was stopped, and a focused run stands in for it.

  Step 20's done-when asks for a full mutation run green on the commit. The run started with a stale `stryker.incremental.json`: 111 source files and 125 test files had changed since it was written, so 244 of 30,738 mutant results were reused and the rest ran fresh, on a machine at a load average of 15 to 25. After nine hours with no progress figure, Rob chose to stop it. A focused run over `packageSpec` and its call site in `src/init.ts`, against `src/__tests__/init.test.ts`, killed 6 of 6 mutants. Step 20 itself changed docs and one test file, so a full run says little about it; it remains a gate on the commit that gets tagged, as D30 (major-after-the-build) has those gates re-run there. It is parked as P8.

  **2.** Step 20 fixed a link in the local-targets example, outside its seam.

  The first full e2e run failed one case: `examples/local-targets/README.md` linked `../../docs/team.md`, added in step 16, and the links check went red when the suite copied the example out of the repo. The link now uses the repo URL, which is how the other examples link to `docs/`. The checkpoint flagged the path as outside the seam and its reach.

  **3.** The install commands dropped `-E`.

  The README, `docs/getting-started.md` and `docs/distribution.md` install with `pnpm add -D checkride`, which writes the caret the policy asks for from 1.0.0. `docs/distribution.md` says to add `-E` for a 0.x release. On a 0.x version a caret spans patches only, so the plain command is safe there too. `docs-currency.test.ts` holds the README's install block and the rest of the policy's wording. Three places outside the seam still carry the old wording, parked as P7.

  **4.** The pin rule is one function keyed on the major.

  `packageSpec` in `src/init.ts` returns `^<version>` when the version's major is 1 or more and the version itself below that; `checkridePin` for `mise.toml` is unchanged. The unit tests read `init` on both sides of 1.0.0 by standing in for the `package.json` that `resources.ts` serves. The old test that compared the pin with this package's own version was replaced, since it would have failed at the tag. `test/e2e/pins.e2e.test.ts` was in step 19's seam and needed no change.

  **5.** The minor-version promise is written as D19 and Q3 decided it.

  A 1.x minor adds a field, a flag, an adapter or a pack, and never turns a green repo red with the same tools and config. Raising the Node floor is a minor change, announced one minor ahead, never past a Node line that still gets security fixes, and only the npm channel is affected. The changelog carries it under a Contract heading, as C3 (contract-moves-loudly) asks, and no contract test moved, since no surface a consumer reads changed.
