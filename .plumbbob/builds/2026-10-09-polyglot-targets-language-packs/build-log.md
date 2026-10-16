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

**Current step:** 26 — feat(select): select checks with the target token grammar
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
- ☑ 18. feat(init): write a config naming every scaffolded slot in new mode
- ☑ 19. feat(init): type-check scaffolded tests outside src
- ☑ 20. test(invariance): pin 0.13's resolved checks, argv and summaries
- ☑ 21. refactor(packs): split the adapter registry into ts and repo packs
- ☑ 22. refactor(launch): resolve tool argv through a pin-source launcher
- ☑ 23. refactor(resources): read bundled files through one module
- ☑ 24. chore(dev): pin every e2e toolchain in a dev mise.toml
- ☑ 25. feat(config): accept targets and packs blocks with their validation
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
- [x] src/init.ts ADD_CONFIGS struct comment says new-mode init writes 'all four' rules (writeSharedStatic); it has written ten since step 12
- [x] step 23: Pack gains R4's templates field once templates/ts/ and templates/repo/ exist; step 21 left it off rather than point PACKS at directories that don't exist yet
- [x] missing-tool hint installs the binary, not the package: spawn.ts and doctor.ts pass execTool's bin to installCommand, so tsc, biome, ast-grep, vale, stryker and attw get 'npm install -D tsc' and kin; TOOLS.npm now names the right package
- [x] src/pm/index.ts is now a re-export of launch/ kept so pm.test.ts passes unchanged; point gate, init, doctor, agent-setup, snippets, pack, baseline-command and triage/gate at launch/, move pm.test.ts under src/launch/__tests__/, and delete src/pm/
- [x] built-ins pack (packInvocation in src/pack.ts) and snippets (tsc via translateExec) still build their own package-manager argv instead of asking launchCheck; route them through the launcher once step 30 records pin_source
- [x] checkride fix never pre-flights: under npm or bun, npx/bunx --no-install can run a cached copy of a fixer the repo never installed, the defect the run path refuses; decide whether launchFix should refuse too
- [x] publish.yaml runs pnpm test:e2e with no mise toolchains and no CHECKRIDE_REQUIRE_TOOLCHAINS, so once pack e2e cases land, a release would publish with them skipped; give it the same jdx/mise-action step as ci.yml
- [x] R2.3: a config error from a --config file (and later --defaults/--pins) should name that path in place of checkride.config.json; invalidConfig in src/config.ts hardcodes the repo file name today, even for resolve-time errors that never see the path
- [ ] V2 doesn't stop a target's or a packs block's custom check from sharing a target's name, so a bare token like --only web would select both target web and api:web; extend V2 in src/targets/resolve.ts
- [ ] only-wins-over-skip: as in 0.13, --only ignores --skip, so '--only api --skip api:test' runs all of api; decide whether --skip should narrow within --only once target tokens select many checks

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
- After step 19: "src/init.ts ADD_CONFIGS struct comment says new-mode init writes 'all four' rules..." → **tangent**, deferred to step 23 (a stale comment blocks nothing; step 23's seam holds `src/init.ts`, and moving the templates under `templates/ts/` and `templates/repo/` rewrites the `ADD_CONFIGS` paths the comment sits on, so the fix rides that edit).
- After step 21: "step 23: Pack gains R4's templates field once templates/ts/ and templates/repo/ exist..." → **tangent**, deferred to step 23 (it creates both directories and makes `src/resources.ts` the only reader of `templates/`, so it decides whether that path comes from `Pack` or from the pack's name, which also settles whether the field is needed at all; `src/packs/` sits outside step 23's seam, so add it via `/plumbbob:step 23` or accept a two-file stray, `types.ts` and the pack rows).
- After step 21: "missing-tool hint installs the binary, not the package..." → **tangent**, deferred to step 22 (it moves `installCommand` and the spawn pre-flight into the `js-lockfile` source, which can name `TOOLS.npm` for the binary it resolves; `pm.test.ts` still passes unchanged, since oxlint's binary is its package; the fix earns a CHANGELOG Fixed line, and `src/doctor.ts` is a one-file stray; step 30, where R6.2 rewrites the message around `Tool.install`, was the alternative, but it would ship the wrong hint in the Phase 5 release).
- After step 22: "src/pm/index.ts is now a re-export of launch/..." → **tangent**, deferred to step 35 (the re-export blocks nothing, since both paths reach the same code; step 35's `entry.ts` already edits `src/init.ts`, `src/agent-setup/` and `src/doctor.ts`, most of the importers, and the gate's `runScript` and `launchRefusal` are its entry-command concern; `src/gate.ts`, `src/triage/gate.ts`, `src/snippets.ts`, `src/pack.ts` and `src/baseline-command.ts` sit outside its seam, so add them via `/plumbbob:step 35` or accept a five-file stray; moving `pm.test.ts` under `src/launch/__tests__/` rides the same edit).
- After step 22: "built-ins pack (packInvocation in src/pack.ts) and snippets..." → **tangent**, deferred to step 30 (their argv can't differ yet, because the ts pack's chain is `[js-lockfile]` in every mode per R5.3; step 30 makes every spawned check record `pin_source`, so it decides whether a built-in's helper process counts as one, and the park dies there if not; `src/pack.ts` and `src/snippets.ts` sit outside its seam, so add them via `/plumbbob:step 30` or accept a two-file stray).
- After step 22: "checkride fix never pre-flights..." → **tangent**, deferred to step 30 (the run path still refuses the undeclared tool, so the gate can't go green on it, and the gap is only a fix writing with a cached copy; step 30 rewrites resolution around R6.2's no-fall-through rule in `src/launch/`, where `launchFix` lives, so it decides whether the fix path walks the same chain and refuses the same way).
- After step 24: "publish.yaml runs pnpm test:e2e with no mise toolchains..." → **tangent**, deferred to step 39 (nothing can skip until a pack has e2e cases, and CI on `main` already requires every toolchain on the same commit before the tag, so the publish run is a second proof, not the only one; step 39 adds the first pack e2e cases and closes Phase 6, the first release that would publish with them skipped, so it gives `publish.yaml` the same `jdx/mise-action` step and `CHECKRIDE_REQUIRE_TOOLCHAINS: '1'` as `ci.yml`; `.github/workflows/publish.yaml` sits outside step 39's seam, so add it via `/plumbbob:step 39` or accept a one-file stray).
- After step 25: "R2.3: a config error from a --config file..." → **tangent**, deferred to step 53 (nothing is blocked, since a broken `--config` file still exits 2 and the message names the offending key, only the file-name prefix is wrong; step 53's `--defaults` is where it matters, because F36's "a defaults file with `targets` exits 2" is only useful if the error names the defaults file, and its seam already holds `src/config.ts` and `src/cli.ts`; step 53 decides whether resolve-time errors, which never see the path, get the label threaded through or only load-time errors name the file, and `--pins` at step 55 reuses whatever it builds).

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

- 2026-10-15 — step 18 checkpointed · 71eef9f99 — feat(init): write a config naming every scaffolded slot in new mode (24m)

  **Summary**: New-mode `init` now writes a `checkride.config.json` that names the scaffold's eight checks and their tools, so a fresh project's first run ends every check line in `[config]`. Existing mode writes its config through the same helper and is otherwise unchanged.

  1. New mode writes the config, and refuses to overwrite one that is already there
  2. One list now feeds the devDependencies, the config and the AGENTS.md stanza
  3. The shapes e2e checks that every status line of every run ends in `[config]`
  4. Both halves of the invariance golden held, so no golden update was needed
  5. The docs name two consequences, and I checked both against a real scaffold first

  **Readout**: Step 18 - feat(init): write a config naming every scaffolded slot in new mode

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored:
               - D16 (provenance)
               - D51 (golden-placement)
               - D52 (e2e-cadence)
  constraints  12 of 12 honored
  seam         held: 5 of 5 declared, no strays
  diff         +149 -25 across 5 files
  spent        24 min · 1 turn · 30s gate · green first run
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Approve and checkpoint step 18. Every done-when clause has a test that fails when it breaks, the gate is green, and both the shapes e2e and the init half of the invariance e2e pass.

  **1.** New mode writes the config, and refuses to overwrite one that is already there

  `writeNewScaffold` now writes `checkride.config.json` right after `package.json`. The file opens with the `$schema` pointer pinned to the running version, the same one existing mode writes, then names `types: tsc`, `lint: oxlint`, `struct: ast-grep`, `dead: fallow`, `test: vitest`, `docs: markdownlint-cli2`, `links: links` and `spell: cspell`. The write sits inside `writeNewScaffold`, so the dry-run collision plan sees it too: a directory that already holds a `checkride.config.json` and no `package.json` now refuses with exit 2 unless `--force`, like every other scaffolded file. A new unit test holds that refusal, because moving the write out of the plan would still pass the config test while clobbering the user's file. The config test runs over all three shapes and pins the exact file. Then it checks the entries against detection: with no config, the scaffold resolves to exactly those eight slot and tool pairs, and with the written config every check resolves with origin `config`. The opt-in slots stay out on purpose. Naming `dupes` or `health`, which `fallow.toml` also detects, would opt them into the default run.

  **2.** One list now feeds the devDependencies, the config and the AGENTS.md stanza

  `scaffoldedAdapters` picks the first adapter the registry lists for each non-opt-in slot. That is the rule `collectDevDeps` already used for the devDependencies. `collectDevDeps` now takes that list, `newConfig` names it, and the AGENTS.md stanza takes its slots in place of the hardcoded `DEFAULT_ACTIVE_SLOTS`, which I deleted. The stanza text is unchanged (the existing flat test still asserts its exact "Active checks" line), but the three can no longer drift apart. Existing mode's config write now goes through the same `configFile` helper and writes the same bytes as before, and every existing-mode test passes unchanged. The stanza rewiring and the shared helper go a little past the done-when. Both stay inside `src/init.ts` and change no behavior, and I can back them out if you'd rather keep the diff to the config alone.

  **3.** The shapes e2e checks that every status line of every run ends in `[config]`

  `check()` in `shapes.e2e.test.ts` now captures stderr and reads the closing tag of each status line, keyed by check name. Every comparison in the file now includes `tags: ALL_CONFIG`: the green run after `pnpm install`, the red probe run and the fixtures run, so a red line has to say `[config]` too. All six cases pass. To prove the assertion can fail, I scaffolded a flat project from the built CLI and ran it with the config deleted: all eight lines came back `[detected: …]` or `[built-in]`. The parser matches only lines that open with two spaces and `✔` or `✘`. That skips the `▸` progress lines and the closing `✔ all checks passed` line, which has no indent.

  **4.** Both halves of the invariance golden held, so no golden update was needed

  D51 (golden-placement) lets Phase 4 steps update the init-shape entries, so I checked whether this step had to. The resolution half (`invariance.contract.test.ts`, which `pnpm check` runs) passes unchanged for `init:flat`, `init:monorepo` and `init:hybrid`. The config names the same adapters detection picked, so names, order, argv and output files don't move. The summary half (`invariance.e2e.test.ts`, run with `-t init:`) passes too, because it strips `origin` and `detected_by` before comparing. Neither fixture under `test/fixtures/invariance/` changed.

  **5.** The docs name two consequences, and I checked both against a real scaffold first

  `docs/getting-started.md` shows the written file under "A new project", with `v<version>` in the `$schema` URL, and says what follows from it, as the slot provenance draft asked. With the config in place and `sgconfig.yml` deleted, `struct` goes red and the run exits 1. Without the config, detection skips `struct` and the run passes as "only 7 of 8 checks ran". With `.oxlintrc.json` deleted, `lint` keeps running on oxlint's defaults. I kept "no longer" out of the knip example: by registry order, fallow already beat knip in a scaffold, so the new part is the pin, not the behavior. The CHANGELOG's Changed entry says it the same way, and adds the refusal and that existing mode is unchanged.

- 2026-10-15 — step 19 checkpointed · cee9f51ce — feat(init): type-check scaffolded tests outside src (1 drift, 34m)

  **Summary**: New projects now type-check their tests outside `src/`. `init` writes a `tsconfig.test.json` and a `typecheck-tests` custom check, and in every shape a type error planted in each package's `test/integration/` fails that check and no other. The gate and the whole `pnpm test:e2e` are green, after a one-line fix to an existing-mode e2e case that step 18 had broken.

  1. New projects get `tsconfig.test.json` and a `typecheck-tests` check, and the stanza lists it after the slots
  2. The test config globs `**/src/**` and `**/test/**`, because root-relative globs leave a monorepo with nothing to check
  3. In every shape, a type error in each package's `test/integration/` fails `typecheck-tests` and nothing else
  4. The template ships as `tsconfig-test.json`, because `pack` refuses a `.test.` name in the tarball
  5. Step 18 had broken `existing.e2e.test.ts`, and one setup line restores what it tests

  **Readout**: Step 19 - feat(init): type-check scaffolded tests outside src

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored:
               - D44 (test-layout-in)
               - D51 (golden-placement)
               - D52 (e2e-cadence)
  constraints  12 of 12 honored
  seam         strayed: 5 paths outside the seam
               - CHANGELOG.md
               - src/__tests__/init.test.ts
               - test/e2e/existing.e2e.test.ts
               - test/fixtures/invariance/resolution.json
               - test/fixtures/invariance/summaries.json
  diff         +185 -58 across 9 files
  spent        34 min · 2 turns · 27s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 19, with the one-line `existing.e2e.test.ts` fix in it. Every done-when clause has a test that held, the gate and the whole `pnpm test:e2e` are green, and the step closes Phase 4, which makes this a release point for your `/version` call.

  **1.** New projects get `tsconfig.test.json` and a `typecheck-tests` check, and the stanza lists it after the slots

  `writeSharedStatic` writes `tsconfig.test.json` at the root of every shape. `newChecks` puts `typecheck-tests` after the eight slot entries in `checkride.config.json`. It runs `pnpm exec tsc -p tsconfig.test.json` like this repo's own check, with a status-line description and a `note` that says why it exists. The AGENTS.md stanza now takes its list from the config's keys, so it ends with `spell, typecheck-tests`. Left at the eight slots, the stanza would disagree with the config, and the first `checkride agent-setup` in a fresh project would rewrite it. A new unit test runs agent-setup on each fresh shape and expects it to write nothing. With the stanza reverted to the eight slots, that test fails in all three shapes. The check's status line ends in `[custom]`, because a config-only custom check carries origin `custom`, so the shapes e2e now expects `[config]` on the eight slots and `[custom]` on this one. `init.test.ts` pins the entry's command, args and description, and checks the written file byte for byte against the template. `getting-started.md` shows the entry and says why it's there, and the CHANGELOG's Changed section records it. I also narrowed one sentence of step 18's CHANGELOG entry. It said every check line of a fresh run ends in `[config]`, and it now says every slot's line does.

  **2.** The test config globs `**/src/**` and `**/test/**`, because root-relative globs leave a monorepo with nothing to check

  This repo's `tsconfig.test.json` includes `src/**/*` and `test/**/*`, relative to the root. Copied as is, those globs miss every package's `test/` in the monorepo and hybrid shapes. A fresh monorepo also has neither folder at its root, so tsc stops with TS18003 ("No inputs were found") and the first run goes red. I confirmed both against real scaffolds. With the root-relative globs, all three monorepo e2e cases failed, and the type error under `libs/core/test/` went unreported. The shipped config globs `**/src/**/*` and `**/test/**/*`, following the layout spec's D5 (shape-agnostic-globs), and excludes `**/test/fixtures/**`, following its D6 (fixtures-are-data). On an installed monorepo, TypeScript 7.0.2's `--listFiles` showed which files outside `node_modules` it took in: the package sources and the planted tests, nothing from `dist/` after a build, and nothing from either fixtures folder. Taking in `src/` means `typecheck-tests` re-checks what `types` already covers, as this repo's copy does. In exchange, the program is never empty in a project that has no `test/` folder yet.

  **3.** In every shape, a type error in each package's `test/integration/` fails `typecheck-tests` and nothing else

  The new shapes case writes a test that assigns a string to a `number`. It plants it in `test/integration/` at the root of every shape, and in `libs/core` or `packages/core` for the two workspace shapes. vitest strips the types and passes it, so `typecheck-tests` is the only check that fails, and the case asserts exactly that. It also reads tsc's `<file>(<line>,<col>): error` lines from `.check/typecheck-tests.stdout.txt` and expects exactly the planted files. That second assertion is what proves each package's `test/` is covered, not only the root's. The step-14 probe now fails `typecheck-tests` too, on its three imports that resolve to nothing, and still passes under `test/fixtures/`, so the new check keeps the fixtures carve-out with every other tool. All nine shapes cases pass. Both invariance goldens moved for the three `init:` subjects only, which is the update D51 (golden-placement) gives Phase 4's steps. Each shape's canonical, `--all` and `--changed` runs gain the same `custom:typecheck-tests` row, and each summary goes from 8 checks to 9 with the exit code still 0. No example moved in either half.

  **4.** The template ships as `tsconfig-test.json`, because `pack` refuses a `.test.` name in the tarball

  The first full gate went red on `pack`. Its fixed deny list matches `/\.test\./` so that test files never ship, and `templates/shared/tsconfig.test.json` matched it. That list holds for every consumer, so I left it alone. I followed the precedent `vitest.config.ts.template` already sets for the list's `\.ts$` instead: the template is named `tsconfig-test.json` and is written as `tsconfig.test.json`. A two-line comment over the template map says why, so a later tidy-up doesn't rename it back. The next gate was green on all 18 checks, with `pack` reporting 346 files and no forbidden paths.

  **5.** Step 18 had broken `existing.e2e.test.ts`, and one setup line restores what it tests

  The first whole `pnpm test:e2e` failed one case outside this step: "existing-failing: init disables a failing slot". That case builds its existing repo by running new-mode `init`, which has written `checkride.config.json` since step 18. Existing-mode `init` keeps a config it finds, so `links` stayed `"links"` where the case expects `false`. I confirmed the attribution in a scratch worktree. The case fails the same way at step 18's commit with none of this step's changes, and passes at step 17's. Step 18's done-when ran only the shapes e2e, and D52 (e2e-cadence) saves the whole suite for the phase's last step, which is this one. The fix deletes the config the scaffold wrote before existing-mode `init` runs, so the project stands in for a repo with tools and no checkride config. That is the situation the case was written for. Existing mode itself is unchanged, and keeping a config it finds is its documented behavior. With the fix, the whole suite is green: 12 files and 110 tests, none skipped. I also parked one stale comment I came across: `ADD_CONFIGS` still says new mode writes "all four" struct rules, where it has written ten since step 12.

- 2026-10-15 — step 21 checkpointed · 00b7e4237 — refactor(packs): split the adapter registry into ts and repo packs (1 drift, 26m)

  **Summary**: The adapter rows now live in two packs under `src/packs/`, `ts` and `repo`, and the package root exports them as `PACKS`, with the tools they run as `TOOLS`. `ADAPTERS` is drawn from the two packs and is deep-equal to 0.13's array, order included, and each `SLOTS` entry declares its `scope`. Both halves of the invariance golden pass unchanged, and the gate is green on all 18 checks.

  1. The rows moved with every value intact, `ADAPTERS` order included
  2. Pack rows keep the 0.13 `Adapter` shape, so R4's `invoke` form stays step 22's call
  3. `PACKS` and `TOOLS` are public plain data, held by the exports contract test
  4. `scope` is optional on the public `Slot` type, so code that builds its own slots still compiles
  5. Five files outside the seam, each required by a constraint, a harvest or a docs test

  **Readout**: Step 21 - refactor(packs): split the adapter registry into ts and repo packs

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored:
               - D5 (packs)
               - D7 (scope)
               - D51 (golden-placement)
               - D53 (inactive-slots)
  constraints  12 of 12 honored
  seam         strayed: 5 paths outside the seam
               - AGENTS.md
               - CHANGELOG.md
               - docs/contract.md
               - rules/no-logic-in-barrel.yml
               - test/integration/conventions.test.ts
  diff         +748 -436 across 16 files
  spent        26 min · 3 turns · 36s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 21. Every value a consumer could read before is unchanged, the gate and both halves of the golden are green, and the one call that binds later steps, the row shape in highlight 2, stays open for step 22 until the Phase 5 release.

  **1.** The rows moved with every value intact, `ADAPTERS` order included

  The 21 toolchain-bound rows went to `src/packs/ts.ts` and the five repo-wide rows (ast-grep, markdownlint-cli2, links, cspell, vale) to `src/packs/repo.ts`, comments and all. `ADAPTERS` lays the two packs' rows out slot by slot in `SLOTS` order. Plain concatenation would have moved all five repo rows behind every ts row. Order is part of a public export's value, and the first row per slot is the blessed default.

  I dumped HEAD's `ADAPTERS` to JSON before the edit and compared it with the built `dist/index.js` afterwards. All 26 rows were deep-equal, and `SLOTS` differed only by `scope`. A new unit test pins the 26 `slot:name` pairs in order. The old "every adapter targets a catalogue slot" test now walks the pack rows, because a row naming an unknown slot would drop out of `ADAPTERS` unseen.

  The snippets rows' scratch argument is now built from `CHECK_DIR` through a `SNIPPETS_TSCONFIG` constant. That settles the step-10 park: rule A5 (`no-check-dir-literal`) forbids the `.check` literal in `src/packs/`, and the value stays byte-identical. The contract half of the golden passes 14 of 14 and the e2e half 13 of 13, with `test/fixtures/invariance/` untouched.

  **2.** Pack rows keep the 0.13 `Adapter` shape, so R4's `invoke` form stays step 22's call

  R4 sketches a `PackAdapter` that carries `invoke: Invocation` in place of `command`, `args`, `fixArgs` and `builtin`. I kept the 0.13 rows instead. Converting them would mean deriving every 0.13 row back out of `invoke` for `ADAPTERS`, and the built-ins don't survive that. `pnpm-audit`'s args are the audit invocation and its threshold. The args on `pack` and both snippets rows are availability signatures, which the run and `doctor` both pass to `isAvailableUnder`. R4's `{ kind: 'builtin', id }` carries none of that. Step 22 is where argv starts going through a launcher, so it is the step that knows what the launcher needs from a row.

  One consequence to weigh: `PACKS` is public now. Once a release ships it, swapping its rows' `command` and `args` for `invoke` would be a breaking change, and a later pack would have to add `invoke` alongside them instead. No release falls between this step and step 23, so step 22 can still reshape the rows freely.

  I also left R4's `templates` field off `Pack`, because `templates/ts/` and `templates/repo/` don't exist until step 23, and parked it there. `Pack` carries what is true today: `name`, `markers` (ts has `package.json` and `tsconfig.json`, repo has none), `pins` (`js-lockfile` for both, per R5.3 and R5.4's implicit-mode chain), `env` (empty for both) and `adapters`. The pin-source type and `Pack['name']` admit only the values that exist, and later packs widen them.

  **3.** `PACKS` and `TOOLS` are public plain data, held by the exports contract test

  The package root now exports `PACKS`, keyed by pack name, and `TOOLS`, one row per tool with its `bin`, `npm` package and an `install` hint, plus the types `Pack` and `Tool`. The exports contract test lists both names and holds the four promises the contract doc now makes:

  - all four registry exports survive a JSON round trip unchanged (A1), compared with `toStrictEqual`, so an `undefined` field or a class instance fails it;
  - `PACKS` keys each pack by its own name;
  - `ADAPTERS` is exactly the two packs' rows, grouped by slot in `SLOTS` order;
  - each slot's `scope` is `repo` exactly when the repo pack fills it.

  A packs unit test checks that `TOOLS` covers exactly the 16 binaries the rows run through `pnpm exec`, and that each tool's `npm` package is among the `devDeps` of the rows that run it.

  Building `TOOLS` turned up a live bug, which I parked. The missing-tool hint in `spawn.ts` and `doctor.ts` passes the binary name to `installCommand`. Six tools have a binary that differs from their package (`tsc`, `biome`, `ast-grep`, `vale`, `stryker`, `attw`), so their hint is wrong, for example `npm install -D tsc`. `TOOLS.npm` now has the right name, and step 22 absorbs that code.

  **4.** `scope` is optional on the public `Slot` type, so code that builds its own slots still compiles

  Every `SLOTS` entry declares `scope`, per R5.1: `struct`, `docs`, `links`, `spell` and `prose` are `repo`, and the other fifteen are `target`. R4 types the field as required. But `Slot` is exported, and callers build their own slot lists for `runChecks` (`baseline.contract.test.ts` does, with `{ name: 'spell' }`). A required field would break their compile, which C1 (additive-contract) rules out. Nothing reads `scope` yet. Step 27 is the first reader, and it can say then what an undeclared scope means.

  `schema` and `unclaimed` stay out of `SLOTS` for now. Added today, they would show up as skipped entries in every summary, which D53 (inactive-slots) and the golden both forbid. Steps 33 and 66 add them along with the logic that keeps them absent while inactive.

  **5.** Five files outside the seam, each required by a constraint, a harvest or a docs test

  `docs/contract.md` and `CHANGELOG.md` move with the contract test, as C1 (additive-contract) and C11 (docs-in-step) require. The programmatic surface section lists `PACKS`, `TOOLS`, `Pack` and `Tool` and the four promises above, and the CHANGELOG gains a Contract entry and an Internal one.

  `rules/no-logic-in-barrel.yml` is now a byte-for-byte copy of the shipped rule, as step 17's harvest asked, and `PACKS` lives in `src/packs/packs.ts` behind a re-export-only barrel. On a scratch probe, the adopted rule flags `export const PACKS = …` in an `index.ts`, which the old rule let through. The full scan finds nothing in this repo.

  `AGENTS.md` gets the matching barrel bullet ("functions, classes and values"), and `packs/` joins the layout block and the folder-module sentence. `test/integration/conventions.test.ts` holds that sentence against the tree, and its count words stopped at "Eight". I extended them to "Twelve", which covers the folder modules R17 still plans. The README's slot table gets its scope column in step 73, as planned.

- 2026-10-15 — step 22 checkpointed · 65a6c27b1 — refactor(launch): resolve tool argv through a pin-source launcher (1 drift, 20m)

  **Summary**: Every argv a check or a fix spawns from an adapter row or a custom check now comes from a launcher in `src/launch/`, through the `js-lockfile` source, which took over all of `src/pm/`'s code. `pm.test.ts` is byte-identical and passes, the package-manager quartet e2e is green with all four managers installed, both halves of the invariance golden pass with no re-record, and the gate is green on all 18 checks. A new rule keeps pack names out of the orchestrator and the launcher, and the missing-tool hint now names the right package.

  1. `src/pm/` moved into `src/launch/`, and `src/pm/` only re-exports it now
  2. One launcher call returns a check's argv, or the reason it won't spawn
  3. Pack rows keep 0.13's `command` and `args`, which settles the `invoke` question step 21 left to this step
  4. Rule A2 is `rules/no-pack-name-literal.yml`, and it fires only where it should
  5. The install hint names the package now, and nine files outside the seam changed with the step

  **Readout**: Step 22 - refactor(launch): resolve tool argv through a pin-source launcher

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    1 of 1 honored
  constraints  12 of 12 honored
  seam         strayed: 9 paths outside the seam
               - AGENTS.md
               - CHANGELOG.md
               - src/__tests__/triage.test.ts
               - src/gate.ts
               - src/orchestrator/__tests__/orchestrator.test.ts
               - src/orchestrator/context.ts
               - src/orchestrator/execute.ts
               - src/orchestrator/types.ts
               - src/triage/gate.ts
  diff         +821 -649 across 24 files
  spent        20 min · 1 turn · 33s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 22. `pm.test.ts`, the quartet and both golden halves pass with no edit to any of them, and highlight 3 is the one call to weigh before the Phase 5 release fixes the `PACKS` row shape.

  **1.** `src/pm/` moved into `src/launch/`, and `src/pm/` only re-exports it now

  The four files moved with `git mv`, so their history follows them: `detect.ts` became `package-manager.ts`, `tools.ts` became `js-lockfile.ts` (it already held the source's whole question, where the lockfile's copy of a tool has to be), `launch.ts` became `refusal.ts` (the gate's "the script never started" table), and `translate.ts` kept its name. `resolve.ts` is new, and it holds the launcher.

  `src/pm/index.ts` now defines nothing and re-exports the same names from `../launch/index.js`. That is what lets `pm.test.ts` pass unchanged, as the done-when asks: it still imports from `../pm/index.js`, and every one of its cases now exercises the code in `src/launch/`. The orchestrator (`spawn.ts`, `fix.ts`, `context.ts`, `execute.ts`, `types.ts`) imports from `launch/` directly. The gate, `init`, `doctor`, `agent-setup`, the `pack` and `snippets` built-ins, `baseline-command` and `triage` still import through `pm/`, so none of them changed. I parked retiring the re-export: point those importers at `launch/`, move `pm.test.ts` under `src/launch/__tests__/`, and delete `src/pm/`.

  AGENTS.md now counts ten folder modules with `launch/` among them, and its layout block names both. `test/integration/conventions.test.ts` holds that sentence against the tree, and it caught my first rewrap, which split "have crossed that line" across two lines.

  **2.** One launcher call returns a check's argv, or the reason it won't spawn

  `launchCheck(slot, command, args, { cwd, pm })` returns either `{ command, args }` or `{ refusal }`. It runs the `js-lockfile` pre-flight (under npm or bun, refuse a `pnpm exec` tool missing from `node_modules/.bin`), then the exec-prefix translation. Any command other than `pnpm` spawns as written, the way a custom check's `node scripts/x.mjs` always has. `launchFix` is the translation alone, because 0.13's fix path never pre-flighted. One call returning either outcome is the shape step 30 needs, since R6.2's refusals (a declared source that can't run the tool, an unpinned tool under `requirePins`) come out of the same resolution as the argv.

  `defaultRunner` and the `security` built-in call `launchCheck`, and `fixInvocation` calls `launchFix`. `spawn.ts` keeps one private `refusedOutcome`, which turns a refusal into exit 1 and carries the old comment on why exit 1 is used and not -1. `missingToolOutcome` is gone. Its seven unit tests moved to `src/launch/__tests__/resolve.test.ts` against `launchCheck`, beside six new ones (argv per manager, a custom command passing through, the package-named hint, and `launchFix` never refusing). Its exit-code assertions live on in `orchestrator.test.ts`'s existing real-runner case, which asserts `exit_code: 1` and no `argv` for an npx-refused tool.

  I checked that the tests can fail. Making `launchCheck` return its input untranslated failed 16 tests: all 12 contract-golden subjects, three launcher tests and the orchestrator's real `npm run build` case.

  The `pack`, `snippets` and `smoke` built-ins still build their helper processes' argv themselves (`snippets` through `translateExec`, which now lives in `launch/`). Step 9 drew the same line for `argv` recording, since those processes are checkride's own. I parked routing them through the launcher once step 30 records `pin_source`.

  **3.** Pack rows keep 0.13's `command` and `args`, which settles the `invoke` question step 21 left to this step

  R4 sketches `invoke: Invocation` on each pack row. I kept the 0.13 row shape and have the launcher read the invocation off it: `pnpm exec <tool>` is a `js-lockfile` tool, `pnpm run`, `audit` and `pack` are package-manager subcommands, and anything else is a command spawned as written. The launcher has to read that form whatever the rows store, because config overrides and custom checks are written in it: this repo's own `lint` and `prose` override `args` as `["exec", "oxlint", …]`, and its `typecheck-tests` custom check is `pnpm exec tsc`. C2 (legacy-invariance) freezes all three. Storing `invoke` as well would give the rows two spellings of one invocation, and the merged `Adapter` the runner sees would still carry `command` and `args`.

  The cost is what step 21 flagged: once a release ships `PACKS` in this shape, adding `invoke` later is additive at best. Later packs don't need it, though. A bash row can say `command: 'shellcheck'` and resolve that executable through `TOOLS` and the pack's chain, and `go`, `cargo` and `terraform` can be read off `command` the same way. Phase 5's release falls after step 23, so this is the last step that can reverse it cheaply.

  **4.** Rule A2 is `rules/no-pack-name-literal.yml`, and it fires only where it should

  It matches a string fragment that is exactly `ts`, `go`, `rust`, `bash`, `python` or `terraform` under `src/orchestrator/` and `src/launch/`, and skips `__tests__`, as A5 does. Matching the fragment catches plain strings, template literals and literal types (`type X = 'ts'`). The tree scans clean. On a scratch probe file copied into four places, it reported 6 hits in `src/orchestrator/` and 6 in `src/launch/`, none in `src/packs/` or a `__tests__/` folder, and none on the look-alikes `'.ts'`, `'tsx'`, `'gopher'`, `'repo'` and `'pnpm'`. The probe files are deleted. `repo` is left out on purpose, following R16.2: it isn't a language, and the word turns up in ordinary strings.

  **5.** The install hint names the package now, and nine files outside the seam changed with the step

  `installCommand` looks the executable up in `TOOLS` and names its `npm` package, falling back to the executable for a tool `TOOLS` doesn't know. So `tsc` now gets `npm install -D typescript`, and likewise for `biome`, `ast-grep`, `vale`, `stryker` and `attw`. That settles step 21's park. Because both the pre-flight and `doctor` call `installCommand`, `doctor.ts` needed no edit, so the stray the harvest expected didn't happen. `pm.test.ts`'s `installCommand` cases use `oxlint`, whose package shares its name, so they pass unchanged. CHANGELOG.md has a Fixed entry for the hint and an Internal one for the launcher and the rule.

  The strays, each a consequence of the move:

  - `AGENTS.md`: the folder-module list and layout block (highlight 1).
  - `CHANGELOG.md`: C11 (docs-in-step).
  - `src/orchestrator/context.ts`, `execute.ts`, `types.ts`: one import line each, from `pm/` to `launch/`.
  - `src/orchestrator/__tests__/orchestrator.test.ts`: the moved pre-flight block, and its import from `launch/`.
  - `src/gate.ts`, `src/triage/gate.ts`: comments pointing at `pm/launch.ts`, now `launch/refusal.ts`.
  - `src/__tests__/triage.test.ts`: a comment naming the removed `missingToolOutcome`.
- 2026-10-16 — step 23 checkpointed · bee26afc3 — refactor(resources): read bundled files through one module (1 drift, 19m)

  **Summary**: Every read of the package's `templates/`, `schema/` and `skills/` now goes through `readResource` in `src/resources.ts`, a new ast-grep rule (A3) holds that, and the templates sit under `templates/ts/` and `templates/repo/shared/` with `init` writing byte-identical files: `pnpm check`, both invariance halves, `shapes.e2e` unchanged and the whole `pnpm test:e2e` (12 files, 110 tests) are green.

  1. One module now reads the package's own files
  2. The templates split into a ts folder and a repo folder, per R11.6
  3. Rule A3 flags a path or fs call that names a bundled directory
  4. Both parked items for this step are settled, one fixed and one dropped
  5. init reads package.json through readResource, which step 69 inherits

  **Readout**: Step 23 - refactor(resources): read bundled files through one module

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    3 of 3 honored
  constraints  12 of 12 honored
  seam         strayed: 8 paths outside the seam
               - AGENTS.md
               - CHANGELOG.md
               - docs/deep-modules.md
               - src/__tests__/init.test.ts
               - test/e2e/layout-rules.e2e.test.ts
               - test/integration/docs-currency.test.ts
               - test/integration/dogfood-config.test.ts
               - src/__tests__/resources.test.ts
  diff         +871 -777 across 85 files
  spent        19 min · 4 turns · 30s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 23. The done-when holds on every clause, with the whole e2e suite green and the shape and invariance goldens untouched, and the one design call (no `Pack.templates`) is cheap to reverse before Phase 5's release if you want R4 followed literally.

  **1.** One module now reads the package's own files

  `src/resources.ts` exports `readResource(relPath)`, which takes a package-root path with `/` separators (`templates/ts/shared/oxlintrc.json`), the same form a SEA asset key takes, so step 69 can swap the backing without touching a caller. `init.ts` lost `HERE` and `TEMPLATES_DIR`, and its `readTemplate(rel)` is now one line over `readResource`. `agent-setup/skills.ts` lost `SKILLS_DIR` and reads each skill through a small `readSkill` that keeps the old tolerance: a skill the package doesn't carry is skipped, not fatal. Its old helper, `readIfExists` in `agent-setup/files.ts`, had no other caller outside that file, so it lost its `export`. R14.1.3 also names `listResources(prefix)`. Nothing lists resources yet, and an export with no caller is what fallow's `dead` slot flags, so it lands with its first caller (step 46 or 69). A two-test `src/__tests__/resources.test.ts` reads one file from each bundled root and pins the throw on a missing one.

  **2.** The templates split into a ts folder and a repo folder, per R11.6

  `git mv` keeps each file's history. `templates/ts/` holds the three shapes (`flat/`, `monorepo/`, `hybrid/`) and `shared/` with the TypeScript configs, `gitignore`, `npmrc` and the ten rules. `templates/repo/shared/` holds what R11.6 assigns to every repo: `cspell.json`, `markdownlint-cli2.jsonc`, `vale.ini` with `styles/Repo/`, and `sgconfig.yml`. The rules stay at `ts/shared/rules/` and are still written to the project's flat `rules/`, because R11.6 says the ts rules are "unchanged" and the shape e2e had to pass without edits. Four tests that read templates straight off disk got path-only edits: `init.test.ts`, `docs-currency.test.ts`, `dogfood-config.test.ts` and `layout-rules.e2e.test.ts`. That last one now copies `sgconfig.yml` from `repo/` and the rules from `ts/`. `AGENTS.md`, `docs/deep-modules.md` and the CHANGELOG's Internal list name the new paths, so most of the seam row's strays are these test and doc edits.

  **3.** Rule A3 flags a path or fs call that names a bundled directory

  `rules/read-bundled-through-resources.yml` covers `src/**/*.ts`, except `src/resources.ts` and `__tests__/`. It flags a string that starts at `templates/`, `schema/` or `skills/` (with `../` or `/` allowed in front) when the string is a direct argument to `join`, `resolve`, an fs read, `fileURLToPath` or `new URL`. Before the fix it flagged exactly the two readers, `init.ts:112` and `skills.ts:28`. A scratch probe confirmed it also catches `new URL('../schema/…')` and `` `${ROOT}/templates/…` ``, and leaves alone `readResource('templates/…')`, `.cursor/skills`, the `'schema'` slot name step 25 adds, and the `$schema` URL. I anchored the match at the start of the path after the first draft flagged `.cursor/skills`. It's a guardrail, not a proof: a path held in a variable before the call goes unseen. A literal-only rule like A2 would have flagged the future `schema` slot name, which is why it looks at path calls.

  **4.** Both parked items for this step are settled, one fixed and one dropped

  The stale `ADD_CONFIGS` comment now says new-mode `init` writes all ten rules, names the six layout and barrel rules beside the three style ones, and says "the other nine", which matches `docs/deep-modules.md`. R4's `Pack.templates` field isn't added. The directory is always `templates/<pack name>/`, so the field would repeat `name`. It would also be an additive change to the public `PACKS` export, with a contract doc and test edit under C1 (additive-contract), and nothing would read it. That kept `src/packs/` out of the diff, and R4's sketch now has one field the code deliberately leaves off.

  **5.** init reads package.json through readResource, which step 69 inherits

  `productVersion()` used `TEMPLATES_DIR/../package.json`. It now calls `readResource('package.json')`, so `init.ts` doesn't locate the package itself. R14.1.2 embeds only `templates/`, `schema/` and `skills/`, so in binary mode this read throws and `productVersion` falls back to `0.1.0`, which would stamp a wrong `$schema` URL. Step 69 has to embed `package.json` or compile the version in. That's already part of its job, since `cli.ts --version` reads the same file.

- 2026-10-16 — step 24 checkpointed · 598f510d5 — chore(dev): pin every e2e toolchain in a dev mise.toml (1 drift, 114m)

  **Summary**: A root `mise.toml` now pins all fourteen e2e toolchains at exact versions, and `mise install` succeeds here (14 of 14). CI installs them with mise-action before the e2e step and requires them there, while a new helper lets a laptop that lacks a pack's tools skip that pack's cases with the reason on stderr. This repo's own run resolves the same checks as before.

  1. The pins are exact, and two of them match versions this repo already tests
  2. The helper skips a pack whose tools don't run and throws under the require flag, and its test is the one path outside the seam
  3. CI installs the toolchains after `pnpm check`, so this repo's own run sees the same PATH
  4. A `mise exec` probe auto-installed rustup into `~/.cargo`, and at your call I moved it into mise's own directories
  5. Parked: publish.yaml's e2e run gets no toolchains

  **Readout**: Step 24 - chore(dev): pin every e2e toolchain in a dev mise.toml

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    2 of 2 honored
  constraints  12 of 12 honored
  seam         strayed: 1 path outside the seam
               → test/integration/toolchains.test.ts
  diff         +257 -0 across 5 files
  spent        114 min · 3 turns · 27s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and land step 24. The pins install, the gate is tested, and CI's new e2e shape passed here end to end.

  **1.** The pins are exact, and two of them match versions this repo already tests

  Go 1.27.2, Rust 1.99.0 (minimal profile plus clippy and rustfmt, which the rust pack's `lint` and `format` need), Python 3.14.8, uv 0.13.1, shellcheck 0.11.0, shfmt 3.14.1, golangci-lint 2.14.0, typos 1.51.1, rumdl 0.2.79, vale 3.24.0, ast-grep 0.45.3, OpenTofu 1.13.1, tflint 0.64.0 and trivy 0.76.0. vale and ast-grep match the npm copies `package.json` pins (ast-grep's newest is 0.51.0), so the Node-free chain step 32 adds runs the same version the parsers will be proven against (C9 (real-fixtures)). Python is the newest 3.14 patch rather than the brand-new 3.15.0. Node stays out on purpose: pinning it would override CI's node matrix on PATH. Every version clears C8 (platforms)'s floors.

  **2.** The helper skips a pack whose tools don't run and throws under the require flag, and its test is the one path outside the seam

  `test/helpers/toolchains.ts` maps each pack (bash, go, rust, python, terraform, and repo for the Node-free alternates) to the tools its cases spawn. `describeWithToolchain(<pack>)` returns `describe` when every probe exits 0 and `describe.skip` otherwise, with the reason on stderr. Under `CHECKRIDE_REQUIRE_TOOLCHAINS=1` (exactly `1`) a missing tool throws, which fails the whole file. Probes run from `os.tmpdir()`, where the e2e cases run their copies, so a mise shim that only resolves inside this repo counts as missing rather than failing every case. On this machine's bare PATH, bash, go, terraform and repo skip and rust and python run; under `mise exec` all six run. `test/integration/toolchains.test.ts` holds the helper's tool list equal to `mise.toml`'s `[tools]` keys, requires exact x.y.z pins, and covers run, skip, throw and the collection-time skip with a fake probe. That test is the seam row's stray. With no pack e2e cases yet, nothing else imports the helper, so fallow's `unused-files` rule would fail `dead` without it. Steps 39, 47, 61 and 65 add the real callers.

  **3.** CI installs the toolchains after `pnpm check`, so this repo's own run sees the same PATH

  There is no separate e2e job: the `check` job's `pnpm test:e2e` step is the e2e run. `jdx/mise-action` (SHA-pinned at v5.1.2, the release before today's v5.2.0) goes right before it, after `pnpm check`. The action exports the install directories to later steps, so the CLI under test finds the tools from temp copies, not only through shims. The e2e step sets `CHECKRIDE_REQUIRE_TOOLCHAINS: '1'`. Locally, `doctor --json` is byte-identical with `mise.toml`, without it and under `mise exec`. The full `pnpm test:e2e` also passes under `mise exec` with the require flag, which is CI's new shape, including `examples/polyglot` on mise's Python 3.14.8.

  **4.** A `mise exec` probe auto-installed rustup into `~/.cargo`, and at your call I moved it into mise's own directories

  mise's `exec_auto_install` defaults to on, so my first `mise exec` installed the missing Rust pin. Without rustup on the machine, it ran rustup-init into `~/.cargo` and `~/.rustup`, which shadowed Homebrew's cargo 1.94.0 globally. Your shell profiles were never touched. You chose the move. I removed the rustup proxies and `~/.cargo/env*` (keeping `naga` and the registry) and deleted `~/.rustup`. Then I set `rust.cargo_home` and `rust.rustup_home` under `~/.local/share/mise/rust/` in `~/.config/mise/config.toml` and reinstalled. Global `cargo` is Homebrew's 1.94.0 again, and inside the repo it's 1.99.0 with clippy and rustfmt. CONTRIBUTING's new "E2e toolchains" section warns about this and gives the two settings, and a memory records it so it isn't repeated.

  **5.** Parked: publish.yaml's e2e run gets no toolchains

  `publish.yaml` also runs `pnpm test:e2e`, but it sits outside this seam. Once pack e2e cases land, a release would publish with them skipped. I parked giving it the same mise-action step.

- 2026-10-16 — step 25 checkpointed · 1d7103f24 — feat(config): accept targets and packs blocks with their validation (1 drift, 51m)

  **Summary**: `checkride.config.json` now accepts `targets`, `packs`, `requirePins` and `unclaimed`, and `changedBase` as before. The loader checks each of R2.3's twelve rules as it reads the file and exits 2 with that rule's own message before any check runs. Nothing runs the new blocks yet, so a config without them resolves exactly as it did, and the invariance golden passes unchanged.

  1. The loader holds V1 to V12, each with its own message and exit 2
  2. Only packs that exist are valid: `ts` today
  3. Loading the packs into the config loader needed one import cycle broken
  4. The schema and `SlotConfig` gained the tuning-only form V6 relies on
  5. V8 validates `schemas` before its slot exists, and one gap is parked

  **Readout**: Step 25 - feat(config): accept targets and packs blocks with their validation

  ```text
  check        green: 1 of 1 checks
  done-when    met
  decisions    honored
               - D53 (inactive-slots), D9 (packs-key), D6 (targets)
               - D23 (defaults-layer), D10 (resolution-order)
  constraints  12 of 12 honored
  seam         strayed: 8 paths outside the seam
               - AGENTS.md
               - CHANGELOG.md
               - src/artifacts/configured.ts
               - src/artifacts/index.ts
               - src/cli.ts
               - src/qa/qa.ts
               - src/targets/index.ts
               - src/triage/triage.ts
  diff         +1082 -84 across 13 files
  spent        51 min · 1 turn · 28s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve and checkpoint step 25. All twelve rules have their own message and test, eleven of them through a real exit-2 run. The golden proves implicit configs resolve as before, the gate is green, and the files outside the seam come from one import-cycle fix plus the docs and module list it requires.

  **1.** The loader holds V1 to V12, each with its own message and exit 2

  The rules live in a new `src/targets/resolve.ts`. It returns the first problem as reason text, and `config.ts` throws it as `invalid checkride.config.json: <reason>`. `loadConfig` and `loadConfigFile` both run it. `loadConfigFile` now takes the repo root, so a `--config` file outside the repo still checks target roots against the repo (one-line change in `src/cli.ts`). V7 runs as each preset folds in, so a preset two levels down is still caught, named by the file that extends it.

  S3 lives in `config.test.ts`. For each of eleven rules, one config breaks that rule and nothing else. It goes through `loadConfig` and through a real `runCli` run, which must exit 2 with the message on stderr and leave no `.check/` behind. A twelfth test checks that the twelve messages are all different, and more tests cover each rule's other cases.

  V11 is the exception. It's a rule about a defaults file, and no command loads one until step 53 adds `--defaults`. So its test calls the rules directly with `layer: 'defaults'`, and step 53 only has to pass that layer. V2's "another target name" clause can't be broken: `targets` is an object keyed by name, so `JSON.parse` folds a duplicate key into one entry, as it does for `checks`.

  Three mistakes that used to be ignored now exit 2: a `static` key in a repo config, a `skipExitCode` on an entry with no `command`, and a URL or absolute path as a `schemas` rule's `schema`. The published schema already rejected the first two. CHANGELOG lists them under Changed. To keep one message source, `skipExitCode` validation in `config.ts` now calls the same `skipExitCodeProblem` function.

  **2.** Only packs that exist are valid: `ts` today

  R2.2 types `PackName` as all six planned packs. I validate `lang` and the `packs` keys against `PACKS` instead, so `lang: "go"` is an error until the go pack lands. Each pack step then makes its name valid with no edit here. If all six were accepted now, step 27 would run a `go` target with no adapters, and every slot would report "no tool detected": a vacuous green. The TS type is `Exclude<Pack['name'], 'repo'>`, so it grows with `PACKS`. A test holds the schema's `packName` enum equal to `PACKS`' language packs, so each pack step has to update the schema too. Another test holds the reserved target names to `SLOTS` plus `schema` and `unclaimed`.

  V5's "file-list pack" is read from the data too: a pack takes `include` and `exclude` when one of its adapters takes `{files}`. That's true of none today, and true of bash once step 31 lands with `shellcheck -f json1 {files}`. Both V4's "different packs may nest" and V5's positive case are tested with a fake `sh` pack passed in, because the rules accept the catalogue as a parameter.

  **3.** Loading the packs into the config loader needed one import cycle broken

  With the rules reading `SLOTS` and `PACKS`, fallow found a cycle: `config.ts` → `adapters` → `packs/ts.ts` → `artifacts` (for `CHECK_DIR`) → `artifacts/configured.ts` → `config.ts`. I confirmed it with a probe before writing anything. The odd edge was `artifacts/` (the output directory) importing the config loader. So `configuredSlots`, the readers' list of the slots a repo configures, moved into `config.ts` unchanged, and `triage.ts` and `qa.ts` now import it from there. `src/artifacts/configured.ts` is deleted. That accounts for most of the files outside the seam. The others are AGENTS.md (the `targets/` module joins the layout and the folder-module list, which `conventions.test.ts` checks), CHANGELOG.md (required by C11 (docs-in-step)) and `src/targets/index.ts`, the module's barrel.

  **4.** The schema and `SlotConfig` gained the tuning-only form V6 relies on

  V6 says that once targets exist, a top-level entry for a target-scope slot is `false` or `{ optIn, timeout, order, note }`. The loader has always accepted that object form (it falls through to detection), but the schema's `slotConfig` required `use` or `command`. The exported `SlotConfig` type didn't allow it either. Both now have a `slotTuning` form. It's a widening, so it's additive, and the CHANGELOG Contract entry says so. The new schema blocks also carry what a schema can state: a name pattern, reserved names, roots that can't be absolute or contain `..`, `minProperties` for V9, and closed key sets.

  **5.** V8 validates `schemas` before its slot exists, and one gap is parked

  The done-when asks for V8 now, but adds `schemas` to the accepted keys only at step 66. So the loader checks a `schemas` rule's `schema` (bundled `checkride:<id>` or a repo-relative path, never a URL, which C4 (no-network) forbids). The key stays out of the JSON schema and the TS type until the slot ships. The contract paragraph says no run uses `targets`, `packs`, `requirePins`, `unclaimed` or `schemas` yet, following D55 (run-fields-ahead).

  Parked: R2.3 says errors from a `--config` file should name that path instead of `checkride.config.json`. Every `invalidConfig` hardcodes the repo file name, including resolve-time errors that never see the path. Step 53 needs the same thing for `--defaults`, and its seam holds `src/config.ts` and `src/cli.ts`.
