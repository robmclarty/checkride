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

**Current step:** 1 — feat(config): let a custom check report a skip through its exit code
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☐ 1. feat(config): let a custom check report a skip through its exit code
- ☐ 2. feat(cli): read the config from a path with --config
- ☐ 3. feat(baseline): add baseline diff against a git ref
- ☐ 4. fix(baseline): key only the oxlint and ast-grep findings that can fail
- ☐ 5. docs(contract): list every summary field and hold the list with a test
- ☐ 6. feat(report): record why each check runs as origin and detected_by
- ☐ 7. feat(changed): resolve one base ref for --changed and pass it as {base}
- ☐ 8. feat(summary): record the run's selection and git state
- ☐ 9. feat(summary): record the argv each check spawned
- ☐ 10. refactor(artifacts): route every artifact path through one output dir
- ☐ 11. feat(cli): write artifacts to another directory with --out
- ☐ 12. feat(init): ship the six layout and barrel rules in new-project mode
- ☐ 13. feat(init): make the starter files obey the rules they ship
- ☐ 14. feat(init): carve test/fixtures out of every scaffolded tool
- ☐ 15. test(init): verify the location rules by scanning a real tree
- ☐ 16. docs(init): describe the shipped layout and rules
- ☐ 17. chore(test): adopt the test layout in this repo
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

- [ ] summary schema's skipped description says 'did not execute', but a skipExitCode self-skip ran; reword when step 5 lists the summary fields

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

- (none yet)

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
