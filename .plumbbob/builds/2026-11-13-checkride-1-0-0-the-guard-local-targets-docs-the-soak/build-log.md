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

**Current step:** 21 — fix(agent-setup): drain the payload in Cursor's protect hook when checkride is missing
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(baseline): fail baseline diff on added keys
- ☑ 2. feat(cli): add --summary github for the step summary
- ☐ 3. feat(api)!: trim the barrel to the names consumers use
- ☐ 21. fix(agent-setup): drain the payload in Cursor's protect hook when checkride is missing
- ☐ 4. feat(config): read a local target's config
- ☐ 5. feat(examples): add a web and api example with local targets
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
