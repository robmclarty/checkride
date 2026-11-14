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

**Current step:** 6 — feat(config): read included config files with flat target names
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
- ☐ 6. feat(config): read included config files with flat target names
- ☐ 7. feat(cli): find the repo's config from inside a target
- ☐ 8. feat(baseline): map each check to its shard and read them all
- ☐ 9. feat(baseline): ratchet each shard on its own
- ☐ 10. feat(baseline): capture and re-record every shard
- ☐ 11. feat(baseline): walk every shard in baseline diff
- ☐ 12. feat(recover): rebuild every shard from history
- ☐ 13. feat(protect): guard every shard from edits
- ☐ 14. docs: move the README's reference sections out
- ☐ 15. docs(readme): rewrite the README to the happy path
- ☐ 16. docs(team): write the page for a team merging agent-written code
- ☐ 17. docs: list the docs by job and shrink getting-started
- ☐ 18. docs: add SECURITY.md
- ☐ 19. feat(init): write a caret pin from 1.0.0 on
- ☐ 20. docs(contract): rewrite the pin policy and promise what a minor may do

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] Cursor protect hook never reads stdin when checkride is missing: the payload write races its exit (spawnSync EPIPE in binary.e2e 'no node' test, CI run 43534933010, ubuntu/node 24); drain stdin with a builtin read loop in protectHookCommand's fallback branch
- [x] docs/packs.md names the TOOLS table six times in prose; with TOOLS off the barrel, reword it as checkride's tool table (step 14's docs move is the natural home)

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
