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

# Build log: polyglot targets, language packs, and what a review agent needs

**Current step:** 18 — feat(init): write a config naming every scaffolded slot in new mode
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(config): let a custom check report a skip through its exit code
- ☑ 2. feat(cli): read the config from a path with --config
- ☑ 3. feat(baseline): add baseline diff against a git ref
- ☑ 4. fix(baseline): key only the oxlint and ast-grep findings that can fail
- ☑ 5. docs(contract): list every summary field and hold the list with a test
- ☑ 6. feat(report): record why each check runs as origin and detected_by
- ☑ 7. feat(changed): resolve one base ref for --changed and pass it as {base}
- ☑ 8. feat(summary): record the run's selection and git state
- ☑ 9. feat(summary): record the argv each check spawned
- ☑ 10. refactor(artifacts): route every artifact path through one output dir
- ☑ 11. feat(cli): write artifacts to another directory with --out
- ☑ 12. feat(init): ship the six layout and barrel rules in new-project mode
- ☑ 13. feat(init): make the starter files obey the rules they ship
- ☑ 14. feat(init): carve test/fixtures out of every scaffolded tool
- ☑ 15. test(init): verify the location rules by scanning a real tree
- ☑ 16. docs(init): describe the shipped layout and rules
- ☑ 17. chore(test): adopt the test layout in this repo
- ☐ 18. feat(init): write a config naming every scaffolded slot in new mode
- ☐ 19. feat(init): type-check scaffolded tests outside src
- ☑ 20. test(invariance): pin 0.13's resolved checks, argv and summaries
- ☐ 21. refactor(packs): split the adapter registry into ts and repo packs
- ☐ 22. refactor(launch): resolve tool argv through a pin-source launcher
- ☐ 23. refactor(resources): read bundled files through one module
- ☐ 24. chore(dev): pin every e2e toolchain in a dev mise.toml
- ☐ 25. feat(config): accept targets and packs blocks with their validation
- ☐ 26. feat(select): select checks with the target token grammar
- ☐ 27. feat(run): run target-scope slots once per target
- ☐ 28. feat(run): never overlap checks that share a lock key
- ☐ 29. feat(changed): skip unaffected targets under --changed
- ☐ 30. feat(launch): resolve tools through mise and PATH and record the pin
- ☐ 31. feat(packs): add the bash pack with file lists
- ☐ 32. feat(packs): give repo-scope slots Node-free alternates
- ☐ 33. feat(unclaimed): fail when a toolchain marker sits outside every target
- ☐ 34. feat(doctor): report the mode, targets, pin sources and unpinned tools
- ☐ 35. feat(entry): resolve the entry command for the stanza, hooks and skills
- ☐ 36. feat(cli): add target add to declare and convert targets
- ☐ 37. feat(init): discover targets in existing mode
- ☐ 38. feat(readers): teach digest, triage and qa target directories and jsonl
- ☐ 39. test(examples): add polyglot-ts-bash with plants
- ☐ 40. feat(capture): add jsonl capture and the failOnOutput verdict
- ☐ 41. feat(launch): pin Go tools by tool directive and harden the Go env
- ☐ 42. feat(packs): add the go pack
- ☐ 43. feat(changed): narrow Go packages to affected workspace modules
- ☐ 44. feat(launch): pin Rust by rust-toolchain and harden the cargo env
- ☐ 45. feat(packs): add the rust pack
- ☐ 46. feat(init): scaffold Go and Rust projects with init --lang
- ☐ 47. test(examples): add the Go, Rust and mixed-stack examples
- ☐ 48. refactor(baseline): derive fingerprints from one parser per format
- ☐ 49. feat(findings): export parseFindings with severity, gates and slot
- ☐ 50. feat(findings): parse Go, Rust and shell tool output with path rebasing
- ☐ 51. feat(findings): parse docs, spell and type-checker output
- ☐ 52. test(examples): adopt a Go repo with --baseline and ratchet it
- ☐ 53. feat(config): layer a defaults file below detection with --defaults
- ☐ 54. feat(run): discover targets at run time with --discover
- ☐ 55. feat(launch): let an outside mise.toml override pins with --pins
- ☐ 56. feat(select): keep only checks that need no install with --static-only
- ☐ 57. docs(consumers): document running checkride from outside a repo
- ☐ 58. feat(launch): resolve Python tools from uv.lock and the project venv
- ☐ 59. feat(packs): add the python pack
- ☐ 60. feat(findings): parse ruff, mypy and basedpyright output
- ☐ 61. test(examples): move examples/polyglot onto the python pack
- ☐ 62. feat(launch): pin terraform or tofu by version file and harden its env
- ☐ 63. feat(packs): add the terraform pack
- ☐ 64. feat(findings): parse tflint, terraform validate and trivy output
- ☐ 65. test(examples): add terraform-roots with plants
- ☐ 66. feat(schema): validate data files against JSON Schemas
- ☐ 67. feat(schema): bundle the agent-skill and checkride-config schemas
- ☐ 68. feat(findings): parse the schema slot's report
- ☐ 69. build(sea): build a standalone binary with Node SEA
- ☐ 70. test(e2e): run the e2e suite against the binary
- ☐ 71. ci(release): publish binaries with checksums and attestations
- ☐ 72. docs(distribution): document the binary, mise and Homebrew channels
- ☐ 73. docs: document packs and targets and fold in the contract
- ☐ 74. chore: retire the drafts and run the opt-in audit

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] summary schema's skipped description says 'did not execute', but a skipExitCode self-skip ran; reword when step 5 lists the summary fields
- [x] list `baseline diff` in docs/cheatsheet.md and the README command table (step 3 documented it in contract.md, tools.md and --help only)
- [x] Steps 11 and 53-56 must write their run.<flag> field in runRecord (src/orchestrator/run.ts) and drop its 'no such flag yet' note in docs/contract.md; step 56 also adds --static-only to isPartialRun and the partial row
- [x] step 11: {out} now expands in custom checks' args too (step 10); document it in docs/contract.md and CHANGELOG beside --out
- [x] step 11: report, digest, triage and qa text name the dir through CHECK_DIR; make those labels follow --out, or they keep saying .check/
- [x] step 21: the snippets adapters' scratch arg .check/doc-snippets/tsconfig.json lands in src/packs/, where no-check-dir-literal (A5) forbids it; give scratch its own constant
- [x] qa --out can't find mutation.json: stryker writes it where the repo's jsonReporter.fileName says (.check/), not through {out}; decide whether the mutation adapter or init's stryker template should route it
- [x] a fixture repo carrying its own .oxlintrc.json re-lints itself in a scaffold: oxlint's nested config voids the root ignorePatterns, and the scaffolded lint argv lacks --disable-nested-config (this repo's own config has it)
- [x] shipped rules contradict: src-never-imports-test lets src/**/__tests__/ import ../../test/helpers/, but no-deep-sibling-import (no __tests__ ignore) fires on that same import; decide which rule yields
- [x] orchestrator.test.ts 'summary array order is deterministic under randomized completion' flakes under full-suite coverage load: its 10ms-spaced timers finished b/c swapped once in step 16's gate; widen the spacing or assert only the summary order
- [x] rules/no-logic-in-barrel.yml is weaker than the shipped copy (it misses top-level and exported const); the shipped rule scans this repo with 0 findings, so the repo could run it as is
- [x] nothing holds rules/'s five test-layout copies byte-equal to templates/shared/rules/; a dogfood-config check like the vale one would keep this repo running the shipped rules

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

- After step 2: "summary schema's skipped description says 'did not execute'..." → **tangent**, deferred to step 5 (reword `schema/checkride.summary.schema.json:48` there; the schema file sits outside step 5's seam, so add it via `/plumbbob:step 5` or accept a one-file stray).
- After step 3: "list `baseline diff` in docs/cheatsheet.md and the README command table..." → **tangent**, deferred to step 73 (README is in its seam; `docs/cheatsheet.md` is not, so add it via `/plumbbob:step 73` or accept a one-file stray).
- After step 8: "Steps 11 and 53-56 must write their run.<flag> field..." → **blocker**, handled now: folded into `intent.md` as D55 (run-fields-ahead). Steps 11, 53, 54, 55 and 56 each name their `run` field and the doc note it drops in their done-whens, with the same wording; step 56 also names the `isPartialRun` change. `src/orchestrator/run.ts` joined all five seams, and `docs/contract.md` joined 54's and 55's.
- After step 10: "step 11: {out} now expands in custom checks' args too..." → **tangent**, deferred to step 11 (its seam already holds `docs/contract.md` and `CHANGELOG.md`, and C11 (docs-in-step) obliges the doc).
- After step 10: "step 11: report, digest, triage and qa text name the dir through CHECK_DIR..." → **blocker**, handled now: folded into `intent.md` as D56 (out-labels). Step 11's done-when names it, and `src/orchestrator/report.ts`, `src/digest/digest.ts`, `src/triage/render.ts` and `src/qa/render.ts` joined its seam.
- After step 10: "step 21: the snippets adapters' scratch arg..." → **tangent**, deferred to step 21 (the `struct` check turns red when the adapters move, so it can't slip; a scratch constant, or dropping the path from an availability-only signature, is that step's call).
- After step 11: "qa --out can't find mutation.json..." → **tangent**, deferred to step 38 (the file's path is the repo's own stryker `jsonReporter.fileName`, not checkride's argv, and mutation is opt-in; step 38 already revisits where `qa` finds artifacts, so it decides between documenting the limit and routing the file through the adapter).
- After step 14: "a fixture repo carrying its own .oxlintrc.json re-lints itself in a scaffold..." → **tangent**, deferred to step 18 (it writes a config entry for every scaffolded slot, so its `lint` entry can carry `--disable-nested-config` as this repo's does, and the step 14 probe can gain a nested `.oxlintrc.json` to prove it; the flag moves the init shapes' lint argv in the invariance golden, which D51 (golden-placement) expects Phase 4 to update on purpose, though `test/contract/invariance.contract.test.ts` sits outside step 18's seam, and it also stops a monorepo package's own `.oxlintrc.json` from applying, which step 18 weighs).
- After step 15: "shipped rules contradict: src-never-imports-test lets src/**/__tests__/ import ../../test/helpers/..." → **tangent**, deferred to step 17 (no planned step trips it, since neither a scaffold nor this repo's `src/` imports from `test/`, but Phase 4 shouldn't release the contradiction; step 17 copies `src-never-imports-test` into this repo's `rules/` beside the same gap, so it fixes both copies, leaning toward a `not: regex` that leaves imports into `test/` to `src-never-imports-test` over a blanket `__tests__` ignore; `templates/shared/rules/no-deep-sibling-import.yml` and `test/e2e/layout-rules.e2e.test.ts` sit outside step 17's seam, so add them via `/plumbbob:step 17` or accept a two-file stray; keyframes' copy has the same gap).
- After step 16: "orchestrator.test.ts 'summary array order is deterministic under randomized completion' flakes..." → **tangent**, deferred to step 28 (its seam already holds `src/orchestrator/__tests__/orchestrator.test.ts`, and its interval-recording fake-spawner tests face the same timer trap, so it widens this test's spacing or asserts only the summary order there; until then a red gate on this test alone clears on a re-run).
- After step 17: "rules/no-logic-in-barrel.yml is weaker than the shipped copy..." → **tangent**, deferred to step 21 (the repo passes the shipped rule with 0 findings today, but step 21 writes the build's first new barrel, and R17 plans `src/packs/index.ts` to hold `PACKS`, which the shipped rule flags; so step 21 adopts the shipped rule and defines `PACKS` in a named file that `index.ts` re-exports, as AGENTS.md's "`index.ts` only re-exports" already asks; `rules/no-logic-in-barrel.yml` and AGENTS.md's barrel bullet sit outside step 21's seam, so add them via `/plumbbob:step 21` or accept a two-file stray).
- After step 17: "nothing holds rules/'s five test-layout copies byte-equal to templates/shared/rules/..." → **tangent**, killed (the five rules rarely change).

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends an entry here
every time a step lands (via `/plumbbob:build` or `/plumbbob:verify`): the dated line,
and beneath it the pause as you approved it, so this fills in as you go, not at the
end, and an older step's detail is a scroll away. Add your own decision/event lines too: this is what
you point at to say "I did that: the LLM helped, but those were my calls."
`/plumbbob:finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*

- 2026-10-10 — plan committed · 87cffc7a3

  **Recommendation**: Approve it. The first read found three holes and `/plumbbob:refine` found seven more. All ten were settled on their leans as D45 to D54, and a second read over the amended plan found nothing left to sharpen. All 74 steps still parse with plumbbob's own parser (seam, title and done-when), and no seam uses a glob. Each amendment cites its Decision, every Decision carries a *because*, and no question is open. Step 20 builds first, and D22, D47 and R13.5 now agree. The unanchored `.check/` rule in both `.gitignore` and the init template already covers D48's per-target scratch directories. `links` and `spell` pass on the amended intent.md.

- 2026-10-10 — step 20 checkpointed · d98f99329 — test(invariance): pin 0.13's resolved checks, argv and summaries (18m)

  **Summary**: Two goldens now pin the baseline tree's behavior for all nine examples and the three `init` shapes. The contract half records each check's resolution, order, argv and output file on every `pnpm check` with nothing installed. The e2e half records each masked summary and exit code. Both pass on the baseline tree, and the e2e half was run twice in compare mode before this pause.

  1. A faked spawn records every check's argv without installing anything
  2. The contract half records `--all` and `--changed` as well as the canonical run
  3. The summary golden lets through only the R8 fields a legacy run can gain
  4. A missing or stale golden fails everywhere, and re-recording needs an explicit variable
  5. The next mutation run will be slower

  **Readout**: Step 20 - test(invariance): pin 0.13's resolved checks, argv and summaries

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         held: 3 of 3 declared, no strays
  diff         +1463 -0 across 4 files
  spent        18 min · 3 turns · 25s gate · green first run
  ```

  **Verdict**: ◐ A hair off (1 commit outside the ledger)

  **Recommendation**: Approve and land step 20 as built. Every later step in this build checks itself against this golden, and both halves pass on the baseline tree with only the R8 fields allowed through.

  **1.** A faked spawn records every check's argv without installing anything

  The contract test drives the real CLI in-process (`runCli`) and fakes only `spawn` from `node:child_process`. The fake child exits 0. It prints `{}` on stdout, so any check with a declared JSON output file writes it and the summary names it, and it prints the argv it got on a marked stderr line. checkride saves that line to `.check/<name>.stderr.txt`, and the test reads it back to tie each argv to its check. I chose this over wrapping `defaultRunner` or calling `translateExec` directly. Both would tie the golden to the internals that steps 10 and 22 rewrite, and step 22's done-when says the golden passes unchanged. Built-ins record no argv, matching step 9's rule for the summary. Copies leave out every gitignored artifact (lockfile, `tsconfig.tsbuildinfo`, `.fallow`), so the golden sees the same tree CI checks out. `shared-preset` gets its `link:./preset` symlinked into `node_modules`, which is all pnpm would do for it. As a probe, I added `--verbose` to `tsc`'s args, and ten subjects went red; I reverted it.

  **2.** The contract half records `--all` and `--changed` as well as the canonical run

  The done-when names only the resolved checks. I also recorded each subject with `--all`, which covers the argv of every opt-in adapter the repo detects (fallow dupes and health, `build`, the publishing slots). I also recorded it with `--changed` inside a throwaway git repo where `origin/main` resolves. That is the case where step 7 promises vitest's `--changed origin/main` stays byte-identical once `{base}` arrives. All three runs together take about 4.5 seconds in `pnpm check`. If you'd rather pin only the canonical run, deleting two entries from `PASSES` and re-recording undoes it.

  **3.** The summary golden lets through only the R8 fields a legacy run can gain

  Before comparing, the e2e half strips only `run` and `git` at the top level, and `origin`, `detected_by`, `pin_source`, `tool_version` and `argv` on each check. R8's other fields (`targets`, `target`, `slot`, `pack`, `cwd`, `narrowed`) only appear in multi-target mode, with a non-`ts` implicit pack, under a target root, or with Go narrowing. So if one shows up here, the test fails, which is the point. The test masks `timestamp`, `total_duration_ms` and a check's `duration_ms` only when the field is present, so a field that disappears still fails. A skipped check's `duration_ms` stays compared, because it's always 0.

  **4.** A missing or stale golden fails everywhere, and re-recording needs an explicit variable

  I skipped vitest's file snapshots because `vitest run` quietly writes a missing snapshot on a laptop. Here, re-recording takes `CHECKRIDE_UPDATE_INVARIANCE=1`, and each test file's docblock gives the exact command. The goldens print one check per line (601 and 266 lines), so the Phase 4 steps get one-line diffs per changed check. The subject list is fixed to the 0.13 set: a later example isn't a legacy repo. The contract half also checks that both goldens list the same subjects, so the two halves can't drift apart.

  **5.** The next mutation run will be slower

  Stryker uses the default vitest config, which includes `test/contract/`. With `perTest` coverage, every mutant this golden covers (most of `config.ts` and the orchestrator) now also runs one or more 300 ms subject tests. That should kill more mutants (C12 (quality-floors) only gains), but the first mutation run after this lands re-runs those mutants from scratch.

- 2026-10-10 — step 1 checkpointed · 94ce4e390 — feat(config): let a custom check report a skip through its exit code (8m)

  **Summary**: A custom check can now declare `skipExitCode`, and exiting with it records the contract's existing skipped entry instead of a red, with its last stderr line plus `(exit N)` as the reason. It stays out of `checks_run`, so `--strict` exits 2 when every check skips itself, and `checkride fix` reports the same match as skipped.

  1. The run decides the skip the moment the check exits, before anything is written
  2. `skipExitCode` rides on the resolved check, not on the adapter
  3. Bad values fail at load time and in the editor schema
  4. A check that prints nothing to stderr gets `skipped itself (exit N)`
  5. Parked: the summary schema still says a skipped check "did not execute"

  **Readout**: Step 1 - feat(config): let a custom check report a skip through its exit code

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  12 of 12 honored
  seam         held: 9 of 9 declared, no strays
  diff         +350 -33 across 9 files
  spent        8 min · 1 turn · 25s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and checkpoint step 1. Every clause of the done-when has its own unit test (F23, F24, the schema range, `fix`), plus one real-subprocess run through the default spawner, the full gate is green, and the one loose end is parked for step 5, which already rewrites that part of the contract.

  **1.** The run decides the skip the moment the check exits, before anything is written

  `runOneCheck` in `src/orchestrator/execute.ts` now returns the whole `CheckResult` (the status-line print and the ratchet fingerprint moved in from `runSelectedCheck`), so a self-skip can leave right after the runner returns. That early exit skips `persistOutput`, masking and the ratchet: no `.check/<name>.stdout.txt` is written, the check isn't in `runs` (so neither the digest nor `baseline` sees it), and `observed` stays null, which makes `ratchet` keep any baseline keys for that slot rather than prune them. The row is built by the existing `handleSkip`, so it is the same `skippedEntry` shape and the same `○ name skip reason` line every other skip prints. The match is `outcome.exit_code === r.skipExitCode`, which can't fire for a check that declares none (undefined never equals a number) or for the `-1` of a timeout or spawn failure. `--bail` carries on past a self-skip, because it stops only on a failed run.

  **2.** `skipExitCode` rides on the resolved check, not on the adapter

  `Adapter` lives in `src/adapters.ts`, outside the seam, and both consumers already hold the `ResolvedCheck`: the runner gets `r`, and `runFix` loops over resolved checks. So `ResolvedCheck` gains an optional, already validated `skipExitCode`, set only for `{ command }` entries (config-only custom checks and catalogue-filling ones alike), and `CustomCheck` gains the config field. In `fix`, a new `reportFix` helper classifies each outcome as ok, skipped or failed. A skipped fix prints `○ <name> skipped (exit N)`, doesn't fail the run, and is left out of `ran`, the way a skip stays out of `checks_run`. Extracting the helper keeps `runFix` at its old cyclomatic count under fallow's health gate.

  **3.** Bad values fail at load time and in the editor schema

  `readSkipExitCode` accepts only an integer from 1 to 255 and otherwise throws `invalid checkride.config.json: '<name>' skipExitCode must be an integer from 1 to 255 (got …)`. It runs before a custom check's `detect` gate, so a typo surfaces even where the check stands down. A `{ use }` entry that carries the key is its own error, because V12 puts it on `command` entries only and the schema's `useConfig` already rejects unknown keys. The JSON Schema adds `"type": "integer", "minimum": 1, "maximum": 255` to `customCheck`, and the ajv tests prove 1, 77 and 255 pass while 0, 256, -1, 1.5, `"77"` and a `{ use }` placement fail.

  **4.** A check that prints nothing to stderr gets `skipped itself (exit N)`

  R8.3 defines the reason as `<last stderr line> (exit N)` and says nothing about an empty stderr. Rather than a bare `(exit 77)`, the reason falls back to `skipped itself (exit 77)`. `docs/tools.md` tells authors to print why before exiting and to pick a code the check never uses for a real failure, naming 77, automake's "skipped" code, as the usual choice. With `skipExitCode: 1`, every ordinary failure would read as a skip, and the docs say so.

  **5.** Parked: the summary schema still says a skipped check "did not execute"

  `schema/checkride.summary.schema.json` describes `skipped` as "Present (true) when the check did not execute", and a self-skip did execute. The file is outside this step's seam and the summary shape itself didn't change, so the wording went to the park list. Step 5 rewrites that part of the contract and can reword it there. `docs/contract.md` already gains a "Vacuous green" bullet and a "A custom check can skip itself" paragraph for the new use of `reason`.

- 2026-10-10 — step 2 checkpointed · cd1821f15 — feat(cli): read the config from a path with --config (1 drift, 19m)

  **Summary**: Run, `doctor`, `fix` and `baseline` now read the file named by `--config` or `CHECKRIDE_CONFIG` in place of `./checkride.config.json`. A missing file exits 2, and a run whose config sits outside the repo leaves `checkride.baseline.json` alone. The gate strips the variable from the check it runs.

  1. The CLI resolves the path, loads it, and hands the loaded config to all four commands
  2. A run whose config sits outside the repo never ratchets, and says so once
  3. The gate strips CHECKRIDE_CONFIG from the check it spawns
  4. Three files outside the seam carry the change
  5. Two judgment calls: what "the repo" means, and quiet stderr under --json

  **Readout**: Step 2 - feat(cli): read the config from a path with --config

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    3 of 3 honored
  constraints  12 of 12 honored
  seam         strayed: 3 paths outside the seam
               - src/__tests__/gate.test.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/types.ts
  diff         +401 -32 across 12 files
  spent        19 min · 1 turn · 24s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve it. Every clause of the done-when has a test, the full gate is green, and the three strays are the obvious homes for the type and its tests.

  **1.** The CLI resolves the path, loads it, and hands the loaded config to all four commands

  `namedConfig` in `src/cli.ts` takes `--config`, or else `CHECKRIDE_CONFIG`, and resolves it against the working directory. An empty variable counts as unset, and `--config ''` is a usage error. A named file that doesn't exist throws `--config names a missing file: <abs>` (or `CHECKRIDE_CONFIG names ...`), which `runCli` turns into exit 2 before any `.check/` side effect. Otherwise `loadConfigFile` (new in `src/config.ts`) reads it through the same `resolveConfigFile` the repo's own config uses. Because `extends` already resolves through `createRequire(absPath)`, relative `extends` land against the named file with no extra code, and a test pins that. All four commands already accepted an injected `config`, so no command module changed: `baseline` gained a one-flag option set, and `doctor` and `fix` pick the flag up from the run option set. `CliDeps` gained an optional `env` (default `process.env`), so tests can't pick up a variable exported in the shell. The help text and the gate's help text both mention it.

  **2.** A run whose config sits outside the repo never ratchets, and says so once

  `runChecks` also receives `configPath` (an optional field on `RunOptions`) and `consumerCause` in `src/orchestrator/run.ts` tests whether the path sits inside `cwd`, comparing real paths so macOS's `/var` symlink can't flip the answer. When it's outside, `maybeRatchet` still computes the prune but writes nothing, printing `baseline: not ratcheted, because a run with --config outside the repo never writes checkride.baseline.json` only when there was something to prune. A config inside the repo ratchets exactly as before (D47 (consumer-trigger)), and `checkride baseline --config` writes the baseline at the repo root wherever its file sits. `consumerCause` returns a cause string so steps 11 and 53 to 56 can add their triggers in one place. `maybeRatchet` now takes the run context instead of six loose parameters.

  **3.** The gate strips CHECKRIDE_CONFIG from the check it spawns

  `src/gate.ts` gains a `CONSUMER_VARS` set, holding only `CHECKRIDE_CONFIG` for now, and filters it out of the environment before Node-pin alignment builds the child's `PATH`. The gate's own config read (`gateProfile`) already went through `loadConfig(cwd)`, which never looks at the variable. A gate test asserts that the child sees `{ PATH }` and nothing else.

  **4.** Three files outside the seam carry the change

  `src/orchestrator/types.ts` holds the new `configPath` field, so it had to move. The ratchet tests went into `src/orchestrator/__tests__/orchestrator.test.ts`, beside the existing partial-run and `--changed` ratchet tests, because only an injected runner can produce fingerprints without a real linter. The variable-stripping test went into `src/__tests__/gate.test.ts` beside the other child-environment tests. Each is the natural home, and none widens the step.

  **5.** Two judgment calls: what "the repo" means, and quiet stderr under --json

  "Inside the repo" is measured against the working directory, the directory every other checkride path (`.check/`, the baseline) is relative to, and the contract doc says so in those words. A config in the git toplevel but above `cwd` therefore counts as outside, which errs toward writing nothing. The "not ratcheted" note follows the existing ratchet note and stays silent under `--json`, where checkride keeps stderr quiet. R13.5 asks for the note without naming `--json`, so if you want it printed there too, that's a one-word change.

- 2026-10-10 — step 3 checkpointed · df795b68d — feat(baseline): add baseline diff against a git ref (1 drift, 33m)

  **Summary**: `checkride baseline diff [<ref>] [--json]` now reports which baseline keys the working tree adds and removes compared with the copy committed at a ref (default `HEAD`). It writes nothing, exits 0 whenever it ran, and exits 2 for a bad ref, a missing git, or a file it can't parse. The JSON shape is pinned by a real-git contract test.

  1. The diff reads the committed copy through git and reuses `diffBaselines` for the comparison.
  2. The JSON's `sha` is the full 40-character sha, where R7.3's example shows seven.
  3. `checkride baseline` now rejects a stray argument instead of silently ignoring it.
  4. Tests cover the edges with an injected git and the contract with a real one.
  5. One file sits outside the seam, and one doc tangent is parked.

  **Readout**: Step 3 - feat(baseline): add baseline diff against a git ref

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  12 of 12 honored
  seam         strayed: 1 path outside the seam
               → src/baseline/index.ts
  diff         +536 -18 across 9 files
  spent        33 min · 1 turn · 26s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land it. The done-when is met on a green full gate, and the one open call (a full sha over R7.3's short example) is the form a machine consumer can compare directly; say now if you'd rather match the spec literally, since the contract test pins it.

  **1.** The diff reads the committed copy through git and reuses `diffBaselines` for the comparison.

  `readBaselineAt` in `src/baseline/history.ts` resolves the ref with `rev-parse --verify --quiet <ref>^{commit}`, then lists the tree with `ls-tree --full-tree --name-only` to tell "this commit has no baseline file" (reads as empty, F30) apart from "this ref names no commit" (exit 2). It never parses `git show`'s error wording, which varies by git version and locale. Only when the file is listed does it `git show` and `parseBaseline` the blob. It reuses recover's `locate()`, so a checkride root in a monorepo subdirectory reads the right path. A blob that doesn't parse, or comes from a newer schema, exits 2 instead of being read as empty, because empty would report every key as added and make a mangled file look like a clean history. A ref starting with `-` is refused before git sees it. `gitFailureError` gained a `command` prefix argument, defaulting to `recover`, so recover's messages are byte-identical. `runBaselineDiff` in `src/baseline-command.ts` maps `diffBaselines(committed, current)` onto R7.3's fields: restored becomes added, absent becomes removed.

  **2.** The JSON's `sha` is the full 40-character sha, where R7.3's example shows seven.

  This is a judgment call against the spec's illustration. A review agent compares this field with `$BASE_SHA`, which is a full sha, and recover's JSON already uses `sha` for the full value (with a separate `short_sha`). Step 8's `git.base { ref, sha }` should then match. The human report still shows seven characters. If you want the spec's literal short form, it is a one-line change, plus the contract doc's example and one assertion in `baseline.contract.test.ts`.

  **3.** `checkride baseline` now rejects a stray argument instead of silently ignoring it.

  The capture's `parseArgs` used to allow positionals and drop them. With `diff` introduced, that meant `checkride baseline --config x diff` would have run the capture and rewritten `checkride.baseline.json`, when the user meant to read it. Now `diff` must come straight after `baseline`, any other positional on the capture is exit 2 ("Unexpected argument 'diff'"), and `baseline diff --config` is an unknown option. The CHANGELOG and contract doc both say so. `baseline --help` (and `baseline diff --help`) now prints its own page covering both forms, and the global help gains two lines under `baseline`.

  **4.** Tests cover the edges with an injected git and the contract with a real one.

  `src/__tests__/baseline.test.ts` adds a unit suite with a scripted git: per-check Markdown rendering, `--json` output, F30 on both sides, the unchanged case, monorepo paths in the exact argv, and seven error cases (no such commit, dash ref, not a repo, no git, unparseable blob, newer schema, a git show timeout). It also checks that an unparseable working-tree file fails before git is asked anything. A real-git CLI suite covers exit codes, F30 through a tag from before the baseline, two refs, `--config` on diff, the stray-argument refusal leaving the file untouched, and the help page. `test/contract/baseline.contract.test.ts` pins the six fields in order, the full sha, the empty-sides default, and exit 2 on a bad ref. It runs real git with no `skipIf`, since `docs/tools.md` lists git as a prerequisite and a contract that silently skips would be weaker.

  **5.** One file sits outside the seam, and one doc tangent is parked.

  `src/baseline/index.ts` gained the `readBaselineAt` export, because the barrel is the module's only public surface. `baseline-command.ts` now imports through it, replacing its direct `fingerprint.js` and `store.js` imports. Listing `baseline diff` in `docs/cheatsheet.md` and the README command table is parked. This step documents it in `docs/contract.md`, `docs/tools.md` (a shallow-clone note under the git prerequisite) and `--help`.

- 2026-10-10 — step 4 checkpointed · 8c364ea51 — fix(baseline): key only the oxlint and ast-grep findings that can fail (1 drift, 13m)

  **Summary**: The baseline now keys an oxlint or ast-grep finding only when it can fail the check under the argv that ran, so a new warning no longer keeps a slot red that is red only from grandfathered errors, while `--deny-warnings`, `--max-warnings` and `--error` still key warnings.

  1. Gating reads the argv the check actually ran with
  2. A wrapper hides the flags, so it keys everything
  3. Two real captures back the tests
  4. The ratchet test runs a full run, and the seam row will flag strays
  5. C1 is bent on purpose

  **Readout**: Step 4 - fix(baseline): key only the oxlint and ast-grep findings that can fail

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  bent: C1 (additive-contract)
               → the keyed set narrows, as D27 decides; doc, test, CHANGELOG move together
  seam         strayed: 6 paths outside the seam
               - README.md
               - docs/contract.md
               - src/digest/digest.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/execute.ts
               - test/contract/baseline.contract.test.ts
  diff         +569 -20 across 12 files
  spent        13 min · 1 turn · 26s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (constraints bent)

  **Recommendation**: Approve and checkpoint. The false-green direction is closed for every argv shape that hides flags, the narrowing is documented where the contract promised the old behavior, and the strays are the call sites and docs the step can't skip.

  **1.** Gating reads the argv the check actually ran with

  `fingerprint()` takes an optional third argument, the check's command then its args. oxlint skips `warning` and `advice` diagnostics unless argv carries `--deny-warnings`, `--max-warnings` or `--max-warnings=N`. ast-grep skips `warning`, `info` and `hint` matches unless argv carries a bare `--error` (or `--error=` with no id), or `--error=<id>[,<id>]` naming the match's rule. A missing or unrecognized severity is keyed. The masking call in `src/orchestrator/execute.ts` passes `[command, ...runtimeArgs(adapter, changed)]`, so a `changedArgs` override that adds `--deny-warnings` under `--changed` is seen. `checkride baseline` and the digest pass the declared args; a capture is never `--changed`, and the digest only renders.

  **2.** A wrapper hides the flags, so it keys everything

  This is the false-green guard, and it goes past the literal done-when. If no argv element is the tool's name (or a path ending in it), the flags can't be read, so every finding is keyed. Without that rule, a custom check named `oxlint` that runs `pnpm run lint` (where the script passes `--deny-warnings`) would key errors only, and a new warning that failed the run would be masked green. Leaving argv out entirely (tests, any future caller) keys everything too, which is 0.13's behavior. The cost is a false red for wrappers, which is the side D27 picks. `npx oxlint@1.2.3` also falls on that side, since `oxlint@1.2.3` isn't a bare tool name.

  **3.** Two real captures back the tests

  `baseline-oxlint-deny-warnings.json` is real oxlint 1.87.0 output from a run under `--deny-warnings` that exited 1, and its warnings still read `severity: "warning"`, the fact the whole design rests on. `baseline-ast-grep-severities.json` is real ast-grep 0.45.3 output over one error, one warning and one hint rule. Checking by hand showed ast-grep already reports a rule raised by `--error` as `severity: "error"`, so the argv rule for ast-grep is a guard, not load-bearing. The F31 tests mirror vale's: they append a warning to a real report and show `applyBaseline` stays `{ ok: true, baselined: 1, newKeys: [] }` on a raw-red run. The F32 test shows the same warning is keyed and keeps the slot red under `--deny-warnings`.

  **4.** The ratchet test runs a full run, and the seam row will flag strays

  The ratchet test lives in `src/orchestrator/__tests__/orchestrator.test.ts` because it drives `runChecks`. It loads a baseline holding 0.13's three oxlint keys, runs the real oxlint fixture red, and shows the slot masked with `baselined: 1` and the file pruned to the one error key. Files outside the declared seam: `execute.ts` and `digest.ts` (the seam missed them, but they hold two of the three `fingerprint` calls), and `docs/contract.md`, `README.md` and `test/contract/baseline.contract.test.ts`, because the contract said only vale was severity-filtered (C11 (docs-in-step)). `src/orchestrator/run.ts` needed no change. The invariance golden's e2e half and the baseline example's e2e both pass.

  **5.** C1 is bent on purpose

  C1 (additive-contract) asks every contract change to be additive. This one narrows which findings are keyed, though key strings, the file shape and `schema_version` don't change. It ships as D27 and the step-48 golden ("step 4's deliberate change") expect: older baselines keep masking because the same findings now give a subset of their keys, and the next full run prunes the warning keys. CHANGELOG lists it under Fixed, and under Contract as "Narrowed", with the one-time baseline diff called out.

- 2026-10-10 — step 5 checkpointed · 2a1110466 — docs(contract): list every summary field and hold the list with a test (7m)

  **Summary**: `docs/contract.md` now lists all six top-level and ten per-check fields of `summary.json`, each with its type and when it's present. The summary contract test fails if either list stops matching the schema's properties, or if the "always" rows stop matching the schema's required fields. `pnpm check` and the whole `pnpm test:e2e` (50 tests) are green.

  1. Two field tables replace the doc's one-line nod to optional fields
  2. The test reads the doc's tables and checks them against the schema both ways
  3. Both directions were proven red before going green
  4. No CHANGELOG line, as the seam planned

  **Readout**: Step 5 - docs(contract): list every summary field and hold the list with a test

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         held: 2 of 2 declared, no strays
  diff         +85 -3 across 2 files
  spent        7 min · 1 turn · 27s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and checkpoint as planned. The diff is a doc table plus a doc-vs-schema check that's been proven red in both directions, and it closes Phase 1 with `pnpm test:e2e` green per D52 (e2e-cadence).

  **1.** Two field tables replace the doc's one-line nod to optional fields

  The `.check/summary.json` section gains a **Top-level fields** and a **Per-check fields** table, laid out like R8.1 and R8.2 (Field, Type, Present when), so steps 6, 8 and 9 can add their rows in the same format. They sit as bold lead-ins, not `###` headings, so the bold paragraphs after them (self-skip, array order, raw output) stay in the flat section they were in. Every presence rule comes from the code, not the schema's descriptions: `reason` appears only with `skipped` (`skippedEntry` is the only writer; a could-not-verify reason goes to stderr, never the summary), `skipped` is only ever `true`, `adapter` is `null` only when nothing resolved (a skip under `--skip` or an unavailable PM still names its adapter), and a custom check with no `name` reports `custom:<key>`. `adapter`, the field #7's follow-up comment found missing, now has a row. The old "Optional per-check fields ... absence is part of the shape" line became the lead-in paragraph, which says a field that isn't "always" is left out, never written as `null` or `false`.

  **2.** The test reads the doc's tables and checks them against the schema both ways

  `fieldTable(lead)` finds the table after `**Top-level fields.**` or `**Per-check fields.**` and takes every backticked name in each row's first cell, plus that row's last cell. That way a multi-name row like R8.1's `run.only`, `run.skip`, `run.include` parses when step 8 adds it. Two assertions per table: the names equal `Object.keys(properties)` (duplicates fail too, since the sorted arrays won't match), and the rows starting with `always` equal `required`. The second assertion goes a little past the done-when's wording. I added it because "with its presence rule" is half the done-when, and a row claiming "always" for an optional field is exactly the kind of misreading D19 exists to stop. The schema is now parsed once and fed to both ajv and the tables.

  **3.** Both directions were proven red before going green

  I deleted the `baselined` row: the per-check names test failed with `- "baselined"`. I prefixed `skipped`'s rule with "always": the per-check presence test failed with `+ "skipped"`. Then I restored the doc from a copy. The diff contains only the intended edits.

  **4.** No CHANGELOG line, as the seam planned

  No field, flag or behavior changed, so C11 (docs-in-step) and C1 (additive-contract) ask for nothing under **Contract**. The doc and its test still moved together. #7's reporter might like a line under **Unreleased** saying the field list exists. That would go outside the seam, so I left it for you to decide.

- 2026-10-10 — step 6 checkpointed · eda7f176b — feat(report): record why each check runs as origin and detected_by (1 drift, 11m)

  **Summary**: Every check now says why it's in the run. Resolution records `origin` (`config`, `detected`, `built-in` or `custom`) and the detection signal, the summary carries them as `origin` and `detected_by`, and each status line and `doctor` slot row ends with the matching tag, such as `[config]` or `[detected: stryker.config.mjs]`.

  1. Resolution records provenance through one helper
  2. A check that sat out keeps its origin
  3. The doctor tag replaces the "Detected via" hint
  4. detectedVia stays beside the new detectedBy
  5. Two source files sit outside the seam

  **Readout**: Step 6 - feat(report): record why each check runs as origin and detected_by

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         strayed: 5 paths outside the seam
               - src/__tests__/config.test.ts
               - src/__tests__/doctor.test.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/execute.ts
               - src/orchestrator/index.ts
  diff         +373 -53 across 14 files
  spent        11 min · 1 turn · 26s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint. The gate is green, each of the done-when's four parts has its own test, and the one judgment call (origin on checks that sat out) is written into the contract doc, so you can veto it there.

  **1.** Resolution records provenance through one helper

  `active()` in `src/config.ts` now takes a provenance. The string, `{ use }` and `{ command }` arms pass `config`, the custom-check arm passes `custom`, and detection passes what `detectionSignal` found. That function now returns the signal in both forms: `detected_by` (`.oxlintrc.json`, `package.json: oxlint`, `package.json: scripts.build`) and the older `detectedVia`. An adapter that declares no signal returns the `null` signal, which reads as `built-in`. Today that covers `links`, `pnpm audit` and the publish built-ins, all of which are checkride built-ins. `standDownIfScriptless` strips the provenance when it turns a configured `build` into a skip, so a check with no adapter never claims an origin. The config tests cover every arm, plus the four kinds of skip that must carry nothing (S21).

  **2.** A check that sat out keeps its origin

  The presence rule is "`origin` is present exactly when `adapter` isn't `null`". Entries left out by `--only` or `--skip`, entries unavailable under this package manager, and custom checks that skipped themselves all keep the origin of the adapter that would have run. R8.2 says "the check is active", and I read that the way the done-when does: resolution gave the check an adapter. The contract test asserts the rule across a whole run, and the contract doc says it in words. Only executed checks print the tag, because a skip line already explains itself, as the provenance draft asked. If you'd rather keep `origin` off skipped entries, the change is one spread in `skippedEntry` plus the doc row.

  **3.** The doctor tag replaces the "Detected via" hint

  `DoctorCheck` gains `origin` and `detectedBy` on rows whose adapter can run, and `renderToolRow` appends the same tag through the shared `provenanceTag`, aligned after the note column. The hint's old "Detected via X." clause is gone because the tag now says the same thing. Two doctor tests read the signal from that hint, so they now assert `detectedBy`, and a new test checks the rendered rows for detected, built-in, custom and disabled slots.

  **4.** detectedVia stays beside the new detectedBy

  `ResolvedCheck` is exported, and its existing `detectedVia` values (`scripts.build`, `dependency 'oxlint'`) differ from the summary's form, so rewriting them would break any caller that reads them. I kept it unchanged, added `detectedBy` in the summary's form, and said so in the Contract changelog entry. Nothing inside checkride reads `detectedVia` any more. Retiring it would be a breaking change to name in some later release.

  **5.** Two source files sit outside the seam

  `src/orchestrator/execute.ts` builds the summary entry for an executed check, so it gains one `...provenanceFields(r)` spread. `src/orchestrator/index.ts` exports `provenanceTag`, so `doctor` reaches the shared rendering rule through the barrel rather than through a deep import. The S21 unit tests live in `config.test.ts`, `orchestrator.test.ts` and `doctor.test.ts`, and the F23 self-skip test's exact entry gained `origin: 'custom'`. The contract doc dates the new fields "(0.15.0)", which assumes your next `/version` is a minor.

- 2026-10-15 — step 7 checkpointed · 3376c858b — feat(changed): resolve one base ref for --changed and pass it as {base} (1 drift, 7019m)

  **Summary**: `--changed` now measures from one base ref, resolved in D18's order (`--base`, `CHECKRIDE_BASE`, config `changedBase`, `origin/main` when it resolves, then `HEAD`), and every check's `changedArgs` receive it as `{base}`. Every done-when clause has a passing test, the invariance golden confirms that a repo naming no base still spawns 0.13's argv, and the gate that landed the step ran green.

  1. One resolver in `src/git.ts` picks the base and every check gets it as `{base}`
  2. A named base that doesn't resolve exits 2; a missing `origin/main` falls back to `HEAD` with a warning
  3. The gate strips `CHECKRIDE_BASE`, which R7.1 asks for though the done-when doesn't name it
  4. The diff reaches past the declared seam in three places
  5. The earlier reds were machine stalls, and the gate that landed the step ran green

  **Readout**: Step 7 - feat(changed): resolve one base ref for --changed and pass it as {base}

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         strayed: 15 paths outside the seam
               - README.md
               - docs/cheatsheet.md
               - src/__tests__/baseline-history.test.ts
               - src/__tests__/baseline.test.ts
               - src/__tests__/gate.test.ts
               - src/__tests__/recover.test.ts
               - src/baseline-command.ts
               - src/baseline/index.ts
               - src/gate.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/execute.ts
               - src/orchestrator/run.ts
               - src/orchestrator/types.ts
               - src/recover.ts
               - src/__tests__/git.test.ts
  diff         +598 -115 across 26 files
  spent        116h 59m · 12 turns · 24s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Build step 8 next. It records the run's selection and git state, writing the base sha this step already resolves as `git.base`.

  **1.** One resolver in `src/git.ts` picks the base and every check gets it as `{base}`

  `resolveChangedBase` takes the named base (or `null`) and returns `{ ref, sha }` plus an optional warning. `runChecks` calls it right after `validateSelection`, so it runs before any side effect, and only under `--changed`. The config's `changedBase` is validated on every run, so a typo surfaces without `--changed`. `runtimeArgs(adapter, base)` now takes the ref (or `null` off `--changed`) and expands `{base}` anywhere inside a `changedArg`, so a custom check can write `--since={base}`. The vitest and jest rows say `{base}` where they said `origin/main`. The baseline fingerprint reads the same expanded argv, so oxlint's argv-dependent keying (step 4) sees what actually ran. The `CheckRunner` context gains an optional `base`, which is additive. The sha is resolved and held on the run context but not written anywhere yet; step 8 records it as `git.base`. Threading the base pushed `runOneCheck` to cyclomatic 10 (CRAP 31.6, a health finding), so the runner context moved into a small `runnerContext` helper, and `health` is green again.

  **2.** A named base that doesn't resolve exits 2; a missing `origin/main` falls back to `HEAD` with a warning

  A base named by `--base`, the variable or the config must name a commit, or the run throws `--base 'nope' doesn't name a commit` (or `CHECKRIDE_BASE …` / `config changedBase …`) and exits 2 before `.check/` exists. Outside a git repository a named base exits 2 with the git failure. With nothing named, `origin/main` is used when `git rev-parse --verify origin/main^{commit}` succeeds; otherwise the base is `HEAD` and stderr says `--changed: origin/main doesn't resolve, so changes are measured from HEAD; name a base with --base, CHECKRIDE_BASE or changedBase`. When `HEAD` names no commit either (no git, or an empty repo), the ref stays `HEAD` with a `null` sha and the warning says why. The warning prints under `--json` too, since stderr is never machine output. `--base ''` is a usage error, and a ref with a leading dash is refused before git sees it. `--base` without `--changed` is accepted and ignored, which I judged safe because it can only leave a run fuller, never narrower.

  **3.** The gate strips `CHECKRIDE_BASE`, which R7.1 asks for though the done-when doesn't name it

  R7.1 says the gate strips every variable in its table from the check it spawns, and step 2 started that list with `CHECKRIDE_CONFIG`. `CHECKRIDE_BASE` joins it, so a gate profile's `changed` measures from the repo's own base whatever a consumer exported. The gate's help and its unit test say so. It's one line in `src/gate.ts`, outside the seam.

  **4.** The diff reaches past the declared seam in three places

  `RunOptions`, the runner context and `maskOutcome` are where the flag meets the runner, so `src/orchestrator/types.ts`, `execute.ts` and `run.ts` had to change. Moving the git runner (`GitRunner`, `realGit`, `gitFailureError`) out of `baseline/history.ts` meant the baseline barrel stopped re-exporting it, so `src/recover.ts`, `src/baseline-command.ts` and three test files now import from `../git.js`. C11 (docs-in-step) brought in `docs/cheatsheet.md`, which lists every run flag, and the README config example, which showed `"changedArgs": ["--changed", "origin/main"]`. The new `src/__tests__/git.test.ts` holds eight resolver cases plus the moved `gitFailureError` test; `orchestrator.test.ts` gained `{base}` cases and a git-backed `--changed base` block; and the flags contract test gained seven cases on a real repo.

  **5.** The earlier reds were machine stalls, and the gate that landed the step ran green

  The first three `plumbbob check` runs went overnight, at load averages between 21 and 66 (`siriactionsd` near 95% CPU). Each passed every slot but `test`, which was killed at its 600s cap, and each logged one stall of about 1000s on something that normally takes seconds: publint, attw and pack in the first run, then a `baseline diff` contract case and a triage SIGTERM test, which looks like the laptop sleeping mid-run. The tests that failed before those kills were timing tests outside this diff (`src/triage` is untouched) or stalls. Run on their own, the suites this step touches passed: the full contract suite (all 58 flags cases), `invariance.contract.test.ts` (14 of 14 in 8s, `init:monorepo` included), and the git, gate, config, cli, orchestrator `--changed base`, baseline, baseline-history and recover tests. The first run also showed three lint errors (`consistent-function-scoping` on test helpers) and the health finding above, both fixed before the reruns. The step landed through `plumbbob checkpoint`'s own full gate, run with `caffeinate -i` holding off idle sleep, and that gate was green.

- 2026-10-15 — step 8 checkpointed · c0b39120c — feat(summary): record the run's selection and git state (1 drift, 12m)

  **Summary**: Every `summary.json` now says what the run selected and which commit it read. `run` lists the selection flags the run was given and marks it `partial` by the same test the baseline ratchet uses. `git` records `head`, `dirty`, and the `--changed` base inside a git work tree. The git queries start with the run and finish alongside the checks, so they add no time unless git is slower than every check. As you chose, the schema, contract doc and contract test define all twelve `run` fields R8.1 names. Five of them are for flags that don't exist yet, and the follow-up for the steps that add those flags is parked.

  1. `run` records each flag given, and `partial` is the ratchet's own test
  2. git is asked as the run starts, so it costs nothing in the common case
  3. A run that finishes before git waits for it inside the clock
  4. `git` needs a commit as well as a work tree
  5. Five files outside the seam changed

  **Readout**: Step 8 - feat(summary): record the run's selection and git state

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    3 of 3 honored
  constraints  12 of 12 honored
  seam         strayed: 5 paths outside the seam
               - README.md
               - src/__tests__/artifacts.test.ts
               - src/__tests__/git.test.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/report.ts
  diff         +463 -32 across 12 files
  spent        12 min · 6 turns · 43s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 8. Every clause of the done-when has a test, the full gate is green, and the invariance golden still matches 0.13 once R8's fields are set aside. Step 9 then adds `argv` and closes Phase 2 with the whole e2e suite.

  **1.** `run` records each flag given, and `partial` is the ratchet's own test

  `runRecord` in `src/orchestrator/run.ts` builds `run` from the run's options:
  - `only`, `skip` and `include` as given, `all` and `changed` as `true`, and `config` as an absolute path;
  - nothing for a flag that wasn't given, since absence is part of the shape.

  `partial` is `isPartialRun(...)`, computed once and passed to both `maybeRatchet` and the record, so the two can't disagree. An orchestrator test runs six cases, each holding a stale baseline key that a whole run prunes, and asserts `run.partial` is the opposite of "the baseline file was rewritten". The cases are a whole run, `--only`, `--skip`, `--changed`, `--bail` with nothing failing, and `--bail` stopped at a failure.

  The schema defines all twelve R8.1 `run` fields. The doc rows for `static_only`, `discover`, `defaults`, `pins` and `out` say checkride has no such flag yet, and the CHANGELOG's Contract entry says no run writes them. The park line asks steps 11 and 53 to 56 to start writing their field and drop that note, and asks step 56 to add `--static-only` to the partial test. The contract doc gains `run`, `git` and `git.base` tables, and `summary.contract.test.ts` holds each to its schema definition, the way it already held the top-level and per-check tables.

  **2.** git is asked as the run starts, so it costs nothing in the common case

  `readGitState` in `src/git.ts` runs two git queries concurrently, each with a 5-second timeout:
  - `rev-parse --verify --quiet HEAD^{commit}`;
  - `--no-optional-locks status --porcelain --untracked-files=normal`.

  `runChecks` starts it right after the base resolves, past every exit-2 gate, and awaits it only after `executeChecks`.

  `--no-optional-locks` keeps `status` from taking the index lock to refresh the index while checks, or a commit hook, run git. `--untracked-files=normal` overrides a `status.showUntrackedFiles=no` setting, under which a new file would read as clean. The function never rejects. A rejection left waiting until the checks finish would crash the process, so it catches and returns `null`.

  A spot run in this repo recorded the right head and `dirty: true` for this step's edits. Under `--changed` it also recorded the `origin/main` base with its sha.

  **3.** A run that finishes before git waits for it inside the clock

  `src/artifacts/freshness.ts` dates the run's start as `timestamp - total_duration_ms`, with no slack, and judges each artifact against it. If the run waited for git outside the clock, that start would move later by the wait, and artifacts written early in the run would read as stale to `triage` and `qa`. So the await sits before the clock stops, and a run that beats git counts the wait, at most 5 seconds from its start, in `total_duration_ms`.

  The schema's `total_duration_ms` description and the contract doc's "sequential equals the sum" sentence now say so. Both duration contract tests still pass, because git answers in milliseconds outside a repository. The alternative was to stamp `timestamp` when the checks finish, but that changes what an existing field means. Counting the wait only lengthens a rare run, and honestly.

  **4.** `git` needs a commit as well as a work tree

  R8.1 puts `git` in any git work tree, and `git.head` is a string whenever `git` is present. A repository with no commit yet has no head to record, so the presence rule reads "in a git work tree whose `HEAD` names a commit". A bare repository has no work tree: `rev-parse` answers but `status` fails, so it gets no `git` even when `--changed` resolved a base. A contract test pins that case, and removing the guard in `gitRecord` makes it fail. `git.base` is written only with a sha, which every path that leaves `git` present also has.

  **5.** Five files outside the seam changed

  - `src/orchestrator/report.ts`: `buildSummary` assembles the summary, so it takes `run` and `git` and places them before `checks`, putting what the run covered at the head of the file.
  - `src/orchestrator/__tests__/orchestrator.test.ts`: the partial-versus-ratchet table, and a test that records `all`. `--all` can't go through the CLI in a contract test, because it reaches the network-bound `security` slot.
  - `src/__tests__/git.test.ts`: five `readGitState` cases, including the exact status argv.
  - `src/__tests__/artifacts.test.ts`: one `run` line in a `Summary` literal, because `run` is now required.
  - `README.md`: the summary example shows `run` and `git`, since every summary now has `run`, as C11 (docs-in-step) asks.
- 2026-10-15 — step 9 checkpointed · b0b7ad01b — feat(summary): record the argv each check spawned (1 drift, 26m)

  **Summary**: Each check that spawned its own tool now records `argv` in `summary.json`, exactly as checkride handed it to `spawn`: after package-manager translation, and with `{base}` already expanded under `--changed`. Built-ins, checks refused before their tool started, and every skipped entry carry none. The schema, the contract doc and the contract tests move together, and both the gate and the whole `pnpm test:e2e` are green, which closes Phase 2.

  1. The default runner records argv on the one path that spawns a check's own tool
  2. A tool that failed to start keeps its argv, and a check the interrupt held back has none
  3. The invariance contract test now holds every summary argv to what spawn was handed
  4. The whole e2e suite is green, so Phase 2 ends at a release point
  5. Three files outside the seam changed

  **Readout**: Step 9 - feat(summary): record the argv each check spawned

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored:
               - D17 (run-record)
               - D19 (contract-fields)
               - D34 (skip-exit-code)
               - D52 (e2e-cadence)
  constraints  12 of 12 honored
  seam         strayed: 3 paths outside the seam
               - CHANGELOG.md
               - src/orchestrator/__tests__/orchestrator.test.ts
               - test/contract/invariance.contract.test.ts
  diff         +174 -22 across 9 files
  spent        26 min · 3 turns · 26s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 9. Each clause of the done-when has a test that fails when the behavior breaks, the gate and the whole e2e suite are green, and Phase 2 closes at a release point.

  **1.** The default runner records argv on the one path that spawns a check's own tool

  `spawnTool` in `src/orchestrator/spawn.ts` wraps `spawnCheck` and adds `argv: [command, ...args]`, the translated command and arguments that `spawn` receives. The default runner calls it only after the built-in dispatch and both pre-flights. So `links` (which runs in-process), the built-ins that start processes of their own (`pnpm-audit`, `pack`, `smoke`, `snippets`) and a refused check never record one. The argv isn't attached inside `spawnCheck`, because built-ins return that function's outcome as-is (`snippets` and `pack` do), so it would leak into their entries.

  `CheckRunner` now resolves a `RunnerOutcome`, which is `CheckOutcome` plus an optional `argv`, so an injected runner that returns none still type-checks. `runOneCheck` copies the argv into the entry through a small `argvField` helper, the way `provenanceFields` works, which keeps the function's complexity where step 7 left it. Every skipped entry is built by `skippedEntry`, which has no `argv`. That includes a custom check that skipped itself: it did spawn, but D34 (skip-exit-code) and the done-when give it the skipped shape. A spot run in this repo records `["pnpm","--config.verify-deps-before-run=false","exec","oxlint",…]` for `lint` and nothing for `links` or `smoke`.

  **2.** A tool that failed to start keeps its argv, and a check the interrupt held back has none

  I read "spawned" as "handed to `spawn`". A missing binary still reaches `spawn` before the OS refuses it, so its entry keeps the argv beside `exit_code: -1`. That records the whole command line that failed, where the `Failed to spawn` message names only the binary. A timed-out tool did spawn before it was killed, so it keeps its argv too.

  After `killLiveChecks`, the interrupt latch makes `spawnCheck` start nothing, so `spawnTool` reads the latch first and records nothing. Only `runChecks` called in-process can see that case, because the CLI exits right after an interrupt and `killLiveChecks` isn't a package export. So the contract doc leaves it out, and the "latches" unit test holds it. If you'd rather a failed spawn carried no argv, the change is a check on the child's `spawn` event inside `spawnCheck`, plus a sentence each in the doc and the schema.

  **3.** The invariance contract test now holds every summary argv to what spawn was handed

  The contract half of the invariance golden already fakes `spawn` and reads back each argv it was handed. It now also asserts that each summary entry's `argv` equals that raw argv, and that a check that spawned nothing (a built-in, or any skipped entry) records none. That runs on every `pnpm check`, across 12 subjects in three passes each, under pnpm's translation and `--changed`. The golden file itself is unchanged.

  I checked that these tests can fail. Recording the untranslated argv failed all 12 invariance subjects and both translation tests: the contract test's `npm run build` and the unit test's. Dropping the latch read failed the interrupt test. `summary.contract.test.ts` covers the presence rule through the CLI: a custom check's exact argv, none on `links`, on a self-skip or on any skipped entry, and the npm-translated `build`.

  **4.** The whole e2e suite is green, so Phase 2 ends at a release point

  `pnpm test:e2e` ran all 10 files and 50 tests green in 76 seconds, with nothing skipped, the mutation canary included. `invariance.e2e.test.ts` already strips `argv` before it compares summaries, as step 20 planned, so its golden still matches 0.13 with no re-record. D52 (e2e-cadence) asks for this run at the end of every phase.

  **5.** Three files outside the seam changed

  - `CHANGELOG.md`: C1 (additive-contract) and C11 (docs-in-step) require the Added and Contract entries. This step's seam left the file out, though every earlier step listed it.
  - `src/orchestrator/__tests__/orchestrator.test.ts`: the unit tests for `spawn.ts` and `execute.ts` live here. It gains argv cases for the npm-translated `build`, a spawn failure, a timeout, the npx pre-flight refusal, the interrupt latch, the exemplars refusal, the `security` built-in, an injected runner's argv and a self-skip.
  - `test/contract/invariance.contract.test.ts`: the cross-check in highlight 3.

  The README's summary example is unchanged: its check entry doesn't show `origin` either, and `argv` is optional.

- 2026-10-15 — step 10 checkpointed · 27013d390 — refactor(artifacts): route every artifact path through one output dir (1 drift, 13m)

  **Summary**: Every place that wrote or read `.check/` now gets the directory from one new module, `src/artifacts/out.ts`, and a new ast-grep rule stops anyone spelling `.check` in the engine again. The argv, summaries and exit codes are byte-identical to 0.13: the full gate is green, and the examples, invariance, plugin-readers and shapes e2e suites pass (33 tests).

  1. One module now owns the output directory
  2. Adapters write through `{out}`, and it still spawns 0.13's argv
  3. Rule A5 is `rules/no-check-dir-literal.yml`
  4. Three follow-ups parked for steps 11 and 21

  **Readout**: Step 10 - refactor(artifacts): route every artifact path through one output dir

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         strayed: 8 paths outside the seam
               - AGENTS.md
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/context.ts
               - src/orchestrator/report.ts
               - src/qa/qa.ts
               - src/qa/render.ts
               - src/triage/render.ts
               - src/triage/triage.ts
  diff         +174 -97 across 18 files
  spent        13 min · 2 turns · 47s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 10. The refactor changes no behavior, the suites that pin 0.13 pass unchanged, and the three parks carry the remaining `--out` work to the steps that own it.

  **1.** One module now owns the output directory

  `src/artifacts/out.ts` exports `CHECK_DIR`, `SUMMARY_FILE` and `outDir(cwd)`, and the artifacts barrel re-exports them; `CHECK_DIR` moved there from `summary.ts`. The run context resolves `out` once with `outDir(cwd)`, and `run.ts` (mkdir, summary write) and `execute.ts` (clear and persist each slot's artifacts) take `ctx.out` instead of joining `.check` themselves. The digest's `writeDigest`, the `triage` and `qa` readers, `readSummary` and doctor's writable probe all call `outDir(cwd)`. Exported functions that tests call with a `cwd` (`writeDigest`, `readSummary`) kept that signature, so no test changed; step 11 can switch them to take the directory when `--out` needs it.

  **2.** Adapters write through `{out}`, and it still spawns 0.13's argv

  vitest and jest now declare `--outputFile={out}/test.json`. `runtimeArgs` in `spawn.ts` expands `{out}` to the relative `CHECK_DIR` in every arg (args and changedArgs alike), beside the existing `{base}` expansion, so the spawned argv is still `--outputFile=.check/test.json`. A direct `--only test` run's summary confirms it, and so does the invariance golden. Two new unit tests cover the expansion, and the existing `runtimeArgs` tests are untouched. The snippets adapters' `.check/doc-snippets/tsconfig.json` stays as it was: per D21 (out-dir) that path is scratch, not output, so it doesn't follow `--out`.

  **3.** Rule A5 is `rules/no-check-dir-literal.yml`

  It matches any string fragment that holds `.check` as a path segment (template-literal fragments included) under `src/orchestrator/`, `src/packs/`, `src/launch/`, `src/digest/`, `src/triage/` and `src/qa/`, and it skips `__tests__`. Its first scan found 37 hits. The 6 filesystem paths now go through `ctx.out` or `outDir`. The 31 display strings (the report lines, digest pointers, and triage and qa prose) now spell the name through `CHECK_DIR`, so their text is byte-identical.

  **4.** Three follow-ups parked for steps 11 and 21

  The display text still says `.check/` even after `--out` moves the files, so step 11 has to make those labels follow the flag. `{out}` already expands in custom checks' args, and that surface goes undocumented until step 11 writes up `--out`; that's a small bend of C11 (docs-in-step), deferred on purpose rather than documenting a token that can only mean `.check` today. Step 21 moves the snippets scratch arg into `src/packs/`, where A5 will reject it. All three are in the build log as park lines. Outside the seam, I also touched `AGENTS.md`'s layout line for `artifacts/` and `src/orchestrator/context.ts`.

- 2026-10-15 — step 11 checkpointed · 335d07732 — feat(cli): write artifacts to another directory with --out (1 drift, 23m)

  **Summary**: `--out <dir>` and `CHECKRIDE_OUT` now move the summary, the raw files and the digest out of `.check/`, and every line that points at an artifact names the directory the run actually used. `baseline`, `triage`, `qa` and `doctor` take it, scratch stays in the repo, and an outside directory never ratchets the baseline. The full gate and the whole `pnpm test:e2e` are green, including a new e2e file where two runs at once with different `--out` values keep separate, complete artifact sets.

  1. The run writes to `--out`, records it, and labels it
  2. The readers and doctor follow the directory
  3. Scratch stays in the repo, and a read-only `.check/` is a skip, not a crash
  4. Consumer runs, the gate, and the baseline
  5. The seam undercounted where the plumbing runs, and one gap is parked

  **Readout**: Step 11 - feat(cli): write artifacts to another directory with --out

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    7 of 7 honored
               - D21 (out-dir), D22 (consumer-runs-write-nothing)
               - D47 (consumer-trigger), D48 (out-per-target), D52 (e2e-cadence)
               - D55 (run-fields-ahead), D56 (out-labels)
  constraints  12 of 12 honored
  seam         strayed: 22 paths outside the seam
               - docs/cheatsheet.md
               - docs/plugin.md
               - schema/checkride.summary.schema.json
               - src/__tests__/artifacts.test.ts
               - src/__tests__/digest.test.ts
               - src/__tests__/doctor.test.ts
               - src/__tests__/gate.test.ts
               - src/__tests__/qa.test.ts
               - src/__tests__/smoke.test.ts
               - src/__tests__/snippets.test.ts
               - src/__tests__/triage.test.ts
               - src/links.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/context.ts
               - src/orchestrator/execute.ts
               - src/orchestrator/spawn.ts
               - src/orchestrator/types.ts
               - src/qa/qa.ts
               - src/triage/doctor-fold.ts
               - src/triage/env.ts
               - src/triage/gate.ts
               - src/triage/triage.ts
  diff         +1239 -264 across 43 files
  spent        23 min · 2 turns · 27s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 11. Every done-when clause has a test behind it, the full gate and the whole e2e suite are green at a phase end, and every stray is a module the directory has to travel through, its test, or a doc the contract obliges.

  **1.** The run writes to `--out`, records it, and labels it

  `src/artifacts/out.ts` gained the output-directory logic: `namedOut` resolves `--out`, then `CHECKRIDE_OUT` (an empty variable counts as unset, an empty flag is exit 2), against the working directory. `outLabel` names a directory relative to the working directory when it sits inside it (`.check` by default) and absolute when it sits outside, comparing real paths so macOS's `/var` and `/private/var` agree. `isInside` moved there from `run.ts`, and now also handles a directory that doesn't exist yet. The run context carries the directory, its label and what `{out}` expands to (`.check` by default, so the invariance golden holds, and the absolute path under `--out`, per R9). `run.out` is recorded, the `report:` and `digest:` lines use the label, and the digest's raw pointers and header do too (`writeDigest` now takes `{ dir, label }`).

  **2.** The readers and doctor follow the directory

  `triage` and `qa` take `--out` in both forms: the `checkride` subcommand and the bare `dist/*/cli.js` the plugin skills run. Every `.check/` in their reports became the label (D56 (out-labels)). `triage` passes `CHECKRIDE_OUT` to the gate run it starts and to its doctor fold through the spawn environment rather than as an argument. A variable reaches checkride whatever the package manager does with trailing arguments, and an older checkride ignores it instead of failing on an unknown flag. `readSummary` now takes the directory rather than a cwd. `doctor` probes the named directory and names the row with the same label.

  **3.** Scratch stays in the repo, and a read-only `.check/` is a skip, not a crash

  `snippets` and `smoke` call a new `prepareScratch(cwd)` before writing. When `<repo>/.check/` can't be written they return an outcome carrying `skip: "needs a writable ./.check for scratch files"`, and `runOneCheck` routes it through the existing self-skip path, so it records the contract's skipped shape and writes nothing (F29). Without this, the first failed scratch write threw out of the run and exited 2. The `skip` field went on `CheckOutcome` in `src/links.ts`, which is outside the seam: a one-field type addition, so the built-ins needed no new return type.

  **4.** Consumer runs, the gate, and the baseline

  An `--out` outside the repo is a consumer run: it masks with the baseline but never prunes it, and stderr says so (F27, unit and e2e). One inside the repo ratchets as if no flag were given. `baseline --out` writes its artifacts outside and `checkride.baseline.json` at the root (D47 (consumer-trigger)). The gate adds `CHECKRIDE_OUT` to the variables it strips and reads `<repo>/.check/` explicitly (F47).

  **5.** The seam undercounted where the plumbing runs, and one gap is parked

  The 22 strays are the files the directory has to pass through, not new scope. Ten are tests: the unit suite beside each module that changed. Nine are source files the seam's entry points call into: `context.ts`, `execute.ts`, `spawn.ts` and `types.ts` under the orchestrator, where the directory and `{out}` reach each check, plus `triage.ts`, `triage/gate.ts`, `env.ts`, `doctor-fold.ts` and `qa.ts`, where the readers actually read and spawn. Then `src/links.ts`, for the one optional `skip` field. Three are contract surfaces: the summary schema's `run.out` description lost its "no such flag yet" note to match the doc, per C1 (additive-contract), and `docs/cheatsheet.md` and `docs/plugin.md` list the flag beside `--config` and the reader arguments. `docs/contract.md` gained the `--out` paragraph, the flag in the promised list, the scratch skip, and the `{out}`-in-custom-checks note from step 10's park. I parked one gap rather than widening the step: stryker writes `mutation.json` wherever the repo's stryker config says, so `qa --out` reports it missing.

- 2026-10-15 — step 12 checkpointed · 64aafcd6f — feat(init): ship the six layout and barrel rules in new-project mode (6m)

  **Summary**: New-project `init` now writes ten ast-grep rules instead of four, adding `colocate-unit-tests`, `tests-dir-is-src-only`, `test-dir-layout`, `no-spec-suffix`, `src-never-imports-test` and `no-logic-in-barrel`, ported from keyframes with the layout spec's shape-agnostic globs, and existing mode writes exactly what it did.

  1. The six rules are ported from keyframes with `**/src/**` and `**/test/**` globs
  2. All six rules ignore test/fixtures, including src-never-imports-test
  3. init.test.ts checks all three shapes against the templates, file for file
  4. Fresh scaffolds now fail their own struct check until step 13 lands
  5. The docs and CHANGELOG wait for step 16, as the plan sequences them

  **Readout**: Step 12 - feat(init): ship the six layout and barrel rules in new-project mode

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  bent: C11 (docs-in-step), the docs wait for step 16 as planned
  seam         held: 3 of 3 declared, no strays
  diff         +165 -2 across 8 files
  spent        6 min · 1 turn · 27s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (constraints bent)

  **Recommendation**: Approve and build step 13 straight after, with no release in between. Steps 12 and 13 together turn the scaffold from red to green, and Phase 4 doesn't reach its release point until step 19 anyway.

  **1.** The six rules are ported from keyframes with `**/src/**` and `**/test/**` globs

  Each rule body comes from `~/Projects/keyframes/code/keyframes/rules/`, with keyframes' root-anchored `src/**` and `test/**` globs rewritten as `**/src/**` and `**/test/**`, so the monorepo and hybrid packages are covered too (the layout spec's D5 (shape-agnostic-globs)). The field order (`id`, `message`, `severity`, `language`, `files`, `ignores`, `rule`) matches the four rules already in `templates/shared/rules/`. The location rules keep a short `note:` saying they're decided by `files` and `ignores` alone, which matters because `ast-grep test` can't see paths. The note no longer points at keyframes' `layout-rules.test.ts`, since a scaffolded repo has no such file. `no-logic-in-barrel` takes keyframes' fuller body, which also catches a top-level or exported `const`, not this repo's own narrower version. `src-never-imports-test` matches the string node directly with `has:` and `regex:`, and its `note:` records the porting trap from the spec.

  **2.** All six rules ignore test/fixtures, including src-never-imports-test

  The spec's reference table says every rule except `src-never-imports-test` ignores `**/test/fixtures/**`. That exception made sense in keyframes, where the rule's `src/**` glob never reached a fixture. With the `**/src/**` glob it does reach a fixture repo's own `src/`, and the layout spec's D5 and D6 (fixtures-are-data) both say fixtures are skipped by every rule. So I followed the decisions over the table and gave it the ignore too. If you'd rather keep the table literally, it's one line to drop.

  **3.** init.test.ts checks all three shapes against the templates, file for file

  A `test.each` over flat, monorepo and hybrid asserts that `rules/` holds exactly the ten files, and that each one matches its template byte for byte, so a wrong template mapping fails as well as a missing file. The existing-mode assertions are untouched, including the `--add struct` case that writes only `no-deep-sibling-import.yml`. In `src/init.ts` the change is only a longer list in `writeSharedStatic`, which existing mode never calls.

  **4.** Fresh scaffolds now fail their own struct check until step 13 lands

  I scaffolded each shape from the built CLI and scanned it with ast-grep. Every shape trips `colocate-unit-tests` on its `src/index.test.ts` and `no-logic-in-barrel` on the `export const` in its `src/index.ts`. Step 13 exists to fix exactly this: its done-when is `shapes.e2e.test.ts` green for all three shapes. `pnpm check` stays green because it leaves `test/e2e/` out, but `pnpm test:e2e` would fail on the shapes between these two steps. A scratch scan of a planted tree also confirmed that each new rule fires on a misplaced file and stays quiet on `__tests__/`, `test/integration/`, `test/helpers/` and fixture paths (step 15 turns that into a real test).

  **5.** The docs and CHANGELOG wait for step 16, as the plan sequences them

  `docs/deep-modules.md` still lists the old rule set, and `CHANGELOG.md` has no entry. C11 (docs-in-step) would have them move with this step, but the plan puts both in step 16's seam (docs(init): describe the shipped layout and rules), together with the currency test that keeps them aligned with `templates/shared/rules/`.

- 2026-10-15 — step 13 checkpointed · 8a10a26b5 — feat(init): make the starter files obey the rules they ship (1 drift, 90m)

  **Summary**: New-project `init` now puts the value in `src/<name>.ts`, writes an `index.ts` that only re-exports it, and moves the smoke test to `src/__tests__/<name>.test.ts`. All three shapes pass their own check again. Getting hybrid green also took a one-line `dist/` ignore in a step 12 rule.

  1. Every shape's starter now follows the layout and barrel rules
  2. The module's file name is a kebab-case stem, never `index`
  3. Hybrid failed struct because ast-grep scanned tsc's dist output
  4. The fix is a dist ignore in a step 12 template, outside this step's seam
  5. Both e2e files that run the shapes are green again

  **Readout**: Step 13 - feat(init): make the starter files obey the rules they ship

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    3 of 3 honored
  constraints  bent: C11 (docs-in-step), the docs wait for step 16 as planned
  seam         strayed: 1 path outside the seam
               → templates/shared/rules/tests-dir-is-src-only.yml
  diff         +51 -16 across 3 files
  spent        90 min · 1 turn · 27s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (constraints bent)

  **Recommendation**: Approve, keeping the `dist/` ignore. It's the smallest change that keeps a scaffold green on every run, git repo or not, and it's one line to revisit if you'd rather solve the gitignore gap with an `.ignore` file instead.

  **1.** Every shape's starter now follows the layout and barrel rules

  One `writeStarter` helper in `src/init.ts` writes the three starter files for the flat root, the hybrid root, and each monorepo or hybrid package, so all three shapes share one code path. The barrel is `export { NAME } from './<stem>.js';`, which `no-logic-in-barrel` accepts. The smoke test imports `'../index.js'`, so it goes through the public barrel as the layout spec's D7 (starter-conforms) says, and `no-deep-sibling-import` doesn't match that path. Existing mode never calls the helper, so the layout spec's D1 (new-mode-only) and C1 (existing-mode-untouched) hold.

  **2.** The module's file name is a kebab-case stem, never `index`

  The layout spec writes `src/<name>.ts`, but the project name isn't validated: it defaults to the directory's basename, which can hold spaces or be `index`. A literal `index` would make the barrel import itself, with no value behind it. `moduleStem` lowercases the name, collapses everything outside `[a-z0-9]` to `-`, and falls back to `app` when the result is empty or `index`, the same fallback `constName` already uses. So `my-app` stays `my-app.ts`, and `My Cool App` becomes `my-cool-app.ts`. A `test.each` in `init.test.ts` covers those three cases.

  **3.** Hybrid failed struct because ast-grep scanned tsc's dist output

  With the starter fixed, flat and monorepo passed but hybrid failed `tests-dir-is-src-only` on `dist/__tests__/t.test.d.ts` and `packages/core/dist/__tests__/core.test.d.ts`. `types` emits declarations for the tests into `dist/`, and ast-grep only reads `.gitignore` inside a git repo, which a fresh scaffold isn't. This is the same gap the 0.13.0 npm smoke test hit with `node_modules/`. On the first run whether it shows up is a race with `types`, but from the second run on `dist/` already exists, so every shape would fail every time. Three fresh hybrid runs reproduced it; after `git init` the same tree scanned clean.

  **4.** The fix is a dist ignore in a step 12 template, outside this step's seam

  `templates/shared/rules/tests-dir-is-src-only.yml` now also ignores `**/dist/**`, the scaffold's own `outDir`, which the vitest template already excludes. Its `note:` says why. That rule is the only one of the ten whose `files` glob reaches `dist/`: the others key on `src/`, `test/` or `.spec.ts`. A planted `lib/__tests__/x.ts` still fires. A fresh no-git hybrid scaffold now exits 0 on both its first and second run. I chose not to `git init` inside the e2e tests, because that would hide a failure real users hit. The other option was shipping a `.ignore` file, which would also cover npm's `node_modules/`, but it adds a scaffold file and goes beyond this step. Step 15 (the scan test) and step 16 (the docs) should list the new ignore beside the spec's reference table.

  **5.** Both e2e files that run the shapes are green again

  `shapes.e2e.test.ts` passes for flat, monorepo and hybrid without any edit, and `invariance.e2e.test.ts` keeps all thirteen 0.13 summaries, including the three `init:` ones step 12 had turned red. The docs and the CHANGELOG still describe the old starter files, and step 16 updates them as the plan sequences it, the same way step 12 handled them.

- 2026-10-15 — step 14 checkpointed · c94445aa8 — feat(init): carve test/fixtures out of every scaffolded tool (1 drift, 15m)

  **Summary**: Scaffolded repos now treat `test/fixtures/` as data. oxlint, markdownlint, cspell, fallow, vitest and every shipped ast-grep rule skip it, the `links` check skips any directory named `fixtures` in every repo, and a broken probe planted there leaves all three shapes green.

  1. Every tool a scaffold runs now leaves test/fixtures/ alone
  2. The e2e probe proves itself broken before it proves the carve-out
  3. Removing any one of the ten ignores turned its own check red
  4. init --add in an existing repo writes these ignores too
  5. Two files sit outside the seam, and one tangent is parked

  **Readout**: Step 14 - feat(init): carve test/fixtures out of every scaffolded tool

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  bent: C2 (legacy-invariance), by D44's design
               → a broken link under a fixtures/ dir no longer fails links
  seam         strayed: 2 paths outside the seam
               - CHANGELOG.md
               - src/__tests__/links.test.ts
  diff         +175 -23 across 16 files
  spent        15 min · 1 turn · 29s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (constraints bent)

  **Recommendation**: Approve and land step 14. The done-when is met with evidence beyond it, and both bends are ones the plan chose: D44 picked the `links` default, and the layout spec's seam put the shared templates in play.

  **1.** Every tool a scaffold runs now leaves test/fixtures/ alone

  Seven tools, each in its own syntax, all with the shape-agnostic `**/test/fixtures/**` glob so a package's own `test/fixtures/` is covered in the monorepo and hybrid shapes:

  - oxlint: `ignorePatterns` in `templates/shared/oxlintrc.json`.
  - markdownlint-cli2: `ignores` in `templates/shared/markdownlint-cli2.jsonc`.
  - cspell: `ignorePaths` in `templates/shared/cspell.json`.
  - fallow: a top-level `ignorePatterns` in all three shapes' `fallow.toml`.
  - vitest: both `exclude` and `coverage.exclude`. The coverage one matters too, because vitest 5 counts every file matching `coverage.include` (`**/src/**/*.ts`), so a fixture repo's `src/` would drag coverage under 70%. `include` itself is untouched, per the layout spec's D9 (include-unchanged).
  - ast-grep: `ignores` added to `no-class`, `no-default-export`, `no-deep-sibling-import` and `require-js-extension`. The six layout rules from step 12 already had it.
  - links: `fixtures` joins `DEFAULT_EXCLUDE_DIRS` in `src/links.ts`, the lean of the layout spec's Q1 that D44 (test-layout-in) adopted. It matches a directory *name*, so it applies to every repo, not only scaffolds, and `exclude` can only add to the set. `docs/tools.md` now says a repo can't opt a `fixtures/` directory back in.

  One finding along the way: fallow's vitest plugin already treats `**/fixtures/**` files as entry points, so an unused fixture file never tripped `dead`. An import of a package no `package.json` lists still does (unlisted dependency), so the probe uses one, and the fallow ignore is load-bearing.

  **2.** The e2e probe proves itself broken before it proves the carve-out

  `test/e2e/shapes.e2e.test.ts` now installs each shape once (`beforeAll`) and runs two tests against it. The first is the old "init, install, checkride exits 0". The second plants the probe twice:

  - First at `test/probe/` (and `<package>/test/probe/` in monorepo and hybrid). The run must exit 1 with exactly `dead, docs, links, lint, spell, struct, test` failing, and `struct.json` must name `no-class`, `no-deep-sibling-import`, `no-default-export`, `require-js-extension` and `test-dir-layout`.
  - Then, with that copy removed, at `test/fixtures/probe/` in the same places. The run must exit 0 with nothing failing.

  The control run is beyond the done-when, but without it the green half could go vacuous on a tool upgrade (a cspell dictionary that stops calling `recieve` a common typo, say) and nobody would notice. The probe holds every ingredient the done-when names: malformed markdown, a dead link, a typo, a default export, an `it.only` (in a test that fails, so it breaks with or without `CI` set) and a loose test file, plus a `debugger` for oxlint, an unlisted import for fallow, and a class, an extensionless import and a deep sibling import for the other style rules. All six tests passed in 72s.

  **3.** Removing any one of the ten ignores turned its own check red

  In a scratch flat scaffold with the probe under `test/fixtures/`, I took out each ignore in turn and reran: oxlint turned `lint` red, markdownlint `docs`, cspell `spell`, fallow `dead`, either vitest exclude `test`, and each of the four rule ignores turned `struct` red with only that rule's id. So none of the ten is decorative. The `links` exclusion has its own unit test, and the pre-change run had `links` red on the same probe.

  **4.** init --add in an existing repo writes these ignores too

  `--add lint`, `docs`, `spell`, `test`, `dead` and `struct` copy the same shared templates, so an existing repo adopting one of those slots now gets the fixture ignore in its new config file. That bends the layout spec's C1 (existing-mode-untouched), which says existing mode writes exactly what it wrote before. I left it, because that spec's own step 3 put `templates/shared/` in the seam, and the ignore can only narrow what a tool checks, so it can't turn an adopting repo red. Splitting the templates per mode to avoid it would need `src/init.ts` changes outside the seam.

  **5.** Two files sit outside the seam, and one tangent is parked

  `src/__tests__/links.test.ts` gains a test that a `fixtures/` directory at any depth is never walked. Only the e2e covered it otherwise, and stryker runs unit tests only, so the new array entry would have been a surviving mutant. `CHANGELOG.md` gains a Changed entry, per C11 (docs-in-step), because the `links` default changes behavior for every repo, not only new scaffolds. Step 16 can fold the scaffold half into its init entry.

  Parked: a fixture repo carrying its own `.oxlintrc.json` re-lints itself, because oxlint's nested config voids the root `ignorePatterns` for that subtree, and the scaffolded lint argv lacks the `--disable-nested-config` this repo's own config uses. I confirmed it in the scratch scaffold.

- 2026-10-15 — step 15 checkpointed · 515dd7261 — test(init): verify the location rules by scanning a real tree (9m)

  **Summary**: A new e2e file builds a temp tree from `templates/shared/`'s sgconfig and rules, plants 22 paths at the root (flat) and again under `libs/core/` (monorepo), scans once with ast-grep, and holds every file to exactly the rules that must fire on it. It's green, and it goes red when a rule's ignore is removed.

  1. Each location rule fires on a misplaced path and stays quiet on every sanctioned and fixture path, in both shapes.
  2. The set of location rules comes from the templates, not a list typed into the test.
  3. I also ported keyframes' `src-never-imports-test` case and expanded it to cover all three branches.
  4. To make sure the test can fail, I removed three ignores from the templates and ran it again.
  5. I parked a conflict between two shipped rules that the scan turned up.

  **Readout**: Step 15 - test(init): verify the location rules by scanning a real tree

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         held: 1 of 1 declared, no strays
  diff         +125 -0 across 1 file
  spent        9 min · 1 turn · 27s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and checkpoint as planned. The done-when is met in both shapes, the test fails when a rule loses an ignore, and the one real problem it found is parked for its own decision, not folded into this step.

  **1.** Each location rule fires on a misplaced path and stays quiet on every sanctioned and fixture path, in both shapes.

  The test is a port of keyframes' `test/integration/layout-rules.test.ts`, rebased onto `templates/shared/` and planted under two homes taken from `shapes.e2e.test.ts`: `''` for flat and `libs/core/` for monorepo. Misplaced paths: a loose `src/**/*.test.ts`, `*.spec.ts` in `src/` and in `test/e2e/`, loose files in `test/` and `test/unit/`, `__tests__/` at the home root and inside `test/`. Sanctioned paths: `src/**/__tests__/`, the five `test/` subfolders, and `dist/__tests__/*.d.ts`, the tsc output that `tests-dir-is-src-only` ignores on purpose. Each misplaced file from that list is also planted under `test/fixtures/` and must stay silent there. Every file asserts its exact rule set, so a rule that fires where it shouldn't fails too, not only one that misses.

  **2.** The set of location rules comes from the templates, not a list typed into the test.

  `LOCATION_RULES` is every file in `templates/shared/rules/` whose rule is `kind: program`. A guard test pins it to the four rules covered today, and each shape asserts that every one of them fires at least once and never fires under `test/fixtures/`. So a fifth location rule can't ship without a case here.

  **3.** I also ported keyframes' `src-never-imports-test` case and expanded it to cover all three branches.

  That rule isn't a location rule, so the done-when doesn't require it. But the porting trap in the spec is about its `any:` branches, and `ast-grep test` can't put a file under `src/`. So a static import, a re-export and a dynamic `import()` from `src/` into `test/helpers/` each assert it fires, and a static import also fires `no-deep-sibling-import`, the same as in keyframes. A copy under `test/fixtures/` stays silent. These cases stay inside the seam. If you want the file held to the done-when alone, I can drop them.

  **4.** To make sure the test can fail, I removed three ignores from the templates and ran it again.

  I removed `colocate-unit-tests`' fixtures ignore, `test-dir-layout`'s helpers ignore and `tests-dir-is-src-only`'s dist ignore from the templates, then reran the file: 8 of 47 failed, each named by path in both shapes. Then `git checkout` restored the templates, so they're unchanged in the diff.

  **5.** I parked a conflict between two shipped rules that the scan turned up.

  `src-never-imports-test` says unit tests in `__tests__/` may import from `test/`. But `no-deep-sibling-import` has no `__tests__` ignore, so `src/plan/__tests__/parse.test.ts` importing `../../../test/helpers/make.js` fails `struct` in any scaffolded repo. I confirmed that with a scratch scan. Fixing it means editing a template rule, which is outside this seam, so it's parked. Step 17 will run into it when this repo adopts the layout.

- 2026-10-15 — step 16 checkpointed · 81b60a2fd — docs(init): describe the shipped layout and rules (9m)

  **Summary**: The two guides now describe the layout new-project `init` ships. `docs/deep-modules.md` names all ten rules and explains where tests live, `getting-started.md` draws the scaffold and the `test/` tree, and a currency test fails if either drifts from `templates/shared/rules/`.

  1. deep-modules.md explains where tests live and names all ten rules
  2. getting-started.md draws the flat scaffold and the five test folders
  3. A currency test holds both docs to the templates, and fails on a planted gap
  4. The CHANGELOG gets the init entry that steps 12 and 13 deferred
  5. A timer flake failed the first gate run, and I parked it rather than fixing it

  **Readout**: Step 16 - docs(init): describe the shipped layout and rules

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  12 of 12 honored
  seam         held: 4 of 4 declared, no strays
  diff         +170 -13 across 4 files
  spent        9 min · 1 turn · 35s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and land step 16. Both guides now match what `init` ships, a test fails the moment they drift, and the one red run was a parked timer flake outside the seam.

  **1.** deep-modules.md explains where tests live and names all ten rules

  A new "Where tests live" section sits between the import examples and "How it's enforced". It draws `src/` with `__tests__/` folders and the five `test/` folders, then gives the four rules in plain words: unit tests in `__tests__/` under `src/` only, `test/` holds five folders and nothing else, one `.test.ts` suffix, and shipped code never imports `test/`. It adds that monorepo and hybrid packages each repeat the layout. The enforcement table gains Barrel and Tests rows. The rule list now names all ten files by their `rules/` path, grouped as module boundaries (3), style (2) and test layout (5). Below it the doc covers the shape-agnostic globs, the `test/fixtures/` skip in every tool, and why `ast-grep test` can't check the four location rules (the layout spec's D8 (location-rules-by-scan)). It also lists the `dist/` ignore on `tests-dir-is-src-only`, which step 13 asked this step to record. A closing paragraph says `init --add struct` still writes the one boundary rule and points at `node_modules/checkride/templates/shared/rules/` for the other nine, which ship in the package's `files`. I dropped one claim from the draft: that unit tests can reach `test/helpers/`. `no-deep-sibling-import` still flags those imports until step 17 adds the exemption, so the doc says only that `src-never-imports-test` exempts `__tests__/`.

  **2.** getting-started.md draws the flat scaffold and the five test folders

  Under "A new project", a tree shows what `init --shape flat --name my-app` writes in `src/` (the barrel, `my-app.ts`, `__tests__/my-app.test.ts`) and `rules/`. I checked it against a real scaffold from the built CLI. A second tree draws `test/`, which `init` leaves you to create. A short paragraph covers per-package layout in the monorepo and hybrid shapes, `struct` failing a misplaced test, and fixtures being skipped. The `--add struct` paragraph in the existing-repo section no longer says the house rules number three: it lists the barrel and test layout too, says "nine", and links to `deep-modules.md#how-its-enforced`.

  **3.** A currency test holds both docs to the templates, and fails on a planted gap

  `test/docs-currency.test.ts` gets a new `describe` with two assertions. The first compares the set of `rules/<name>.yml` paths named in `deep-modules.md` with the files in `templates/shared/rules/`, exactly and in both directions, the same exact-set rule the file already applies to enumerations. The second reads the five sanctioned folders out of `test-dir-layout.yml`'s `ignores` and checks that the `test/` tree in each guide lists exactly those. A length-5 guard stops an empty parse from passing vacuously. That holds the layout spec's C4 (docs-name-what-ships) for both guides, not only the one the done-when names. I proved each guard by breaking it: a planted `zz-probe.yml` failed the rule test, and deleting `contract/` from the getting-started tree failed the tree test. Both files were restored. The file's header comment now describes the new guards.

  **4.** The CHANGELOG gets the init entry that steps 12 and 13 deferred

  A new first entry under Unreleased → Changed covers the six new rules, the starter files that now obey them, and fixtures as data. Existing mode is unchanged. Step 14's `links` entry used to carry the scaffold half ("The configs `init` writes skip `test/fixtures/`…"). I moved that half into this entry, with `--add` included, as step 14's log suggested. The `links` entry now covers only the `links` default.

  **5.** A timer flake failed the first gate run, and I parked it rather than fixing it

  The first full gate failed in `src/orchestrator/__tests__/orchestrator.test.ts`, in the "randomized completion" test. Its timers are 10ms apart, and under full-suite coverage load `b` and `c` finished in swapped order. It passed 5 of 5 in isolation and touches nothing in this step's seam, so I parked it with two candidate fixes. The second full gate was green. One more fix along the way: three `m[1]` captures needed the repo's `?? ''` idiom to pass `typecheck-tests` under `noUncheckedIndexedAccess`.

- 2026-10-15 — step 17 checkpointed · bb5f61066 — chore(test): adopt the test layout in this repo (15m)

  **Summary**: This repo now keeps the test layout it scaffolds. Its `rules/` runs the five test-layout rules, the six loose test files live in `test/integration/`, and both copies of `no-deep-sibling-import` leave imports into `test/` to `src-never-imports-test`, so a unit test can share code from `test/helpers/`.

  1. The five test-layout rules joined `rules/`, copied byte for byte from the templates
  2. The six loose tests moved to `test/integration/` with their paths fixed
  3. `no-deep-sibling-import` now leaves imports into `test/` to `src-never-imports-test`
  4. Every citation of the old paths now points at `test/integration/`
  5. I parked two dogfood follow-ups instead of widening the step

  **Readout**: Step 17 - chore(test): adopt the test layout in this repo

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         held: 9 of 9 declared, no strays
  diff         +707 -564 across 27 files
  spent        15 min · 2 turns · 27s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and land step 17. Every done-when clause is met, the gate was green on its first run, and both e2e files that exercise the changed rule pass.

  **1.** The five test-layout rules joined `rules/`, copied byte for byte from the templates

  `colocate-unit-tests`, `tests-dir-is-src-only`, `test-dir-layout`, `no-spec-suffix` and `src-never-imports-test` are verbatim copies of `templates/shared/rules/`, so they keep the shape-agnostic `**/src/**` and `**/test/**` globs instead of the root-anchored `src/**` the repo's older rules use. Before the move, a scan found exactly six findings: `test-dir-layout` on each loose file. Nothing fired under `examples/`, which the `**/` globs also reach. The alternative was root-anchored copies, which would keep the examples out of reach for good. But nothing in them trips these rules today, and copies that differ from what ships prove less about the shipped rules. `no-logic-in-barrel` was already here in an older, weaker form. I left it alone and parked it.

  **2.** The six loose tests moved to `test/integration/` with their paths fixed

  `git mv` keeps all six as renames. Each repo root went from `'..'` to `'..', '..'`, each import from `../src/` to `../../src/`, and `resolution.fixture.test.ts` now looks one level up for `test/fixtures/`. All 33 of their tests pass from the new folder. None of them went to `test/contract/`, because `docs/contract.md` names none of what they guard (AGENTS.md, the docs, this repo's config, the plugin manifest, the site, and a fixture resolution). The sibling-guard comments inside them (`./dogfood-config.test.ts` and so on) stay correct, since all six moved together.

  **3.** `no-deep-sibling-import` now leaves imports into `test/` to `src-never-imports-test`

  Both copies gain one commented `not: regex` clause, `from\s+['"](\.\./)+test/`. That follows the step 15 harvest's lean, rather than a blanket `__tests__` ignore. `layout-rules.e2e.test.ts` now expects `src/report/leak.ts` to fire `src-never-imports-test` alone. It adds `src/plan/__tests__/helped.test.ts`, which imports `test/helpers/` and gets no findings, and `src/plan/__tests__/deep.test.ts`, which proves a unit test still can't reach past a sibling's index. With the template clause removed, exactly the four `test/` cases fail (two per home); restored, all 51 tests pass. A scratch probe showed the repo copy behaves the same, and I deleted it. `shapes.e2e.test.ts` passes for all three shapes as well, because its probe's deep import is `../sibling/internal.js`.

  **4.** Every citation of the old paths now points at `test/integration/`

  The citations sat in AGENTS.md, two notes in `checkride.config.json`, `examples/README.md`, the version skill and a comment in `examples.e2e.test.ts`. A sweep now finds the old paths only in `.plumbbob/`, CHANGELOG.md and the two spec drafts. AGENTS.md also gains a convention for tests outside `src/` that names the new rules, and its layout block draws the four `test/` folders that exist. `docs/deep-modules.md` restores the claim step 16 had to drop: unit tests can share code from `test/helpers/`. CHANGELOG.md gets a Changed entry for the rule, because it changes what `--add struct` writes: a repo that takes that rule alone no longer gets a flag when `src/` imports `test/`, so the entry points it at `src-never-imports-test`. It also gets an Internal entry for the move.

  **5.** I parked two dogfood follow-ups instead of widening the step

  The first aligns `rules/no-logic-in-barrel.yml` with the shipped rule, which also catches a top-level or exported `const` and finds nothing in this repo today. The second is a guard that holds the five copies byte-equal to the templates, like `dogfood-config`'s vale check. Without that guard, the CHANGELOG's "copied unchanged" stays true only until someone edits one copy.
