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

**Current step:** 6 — feat(report): record why each check runs as origin and detected_by
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

- [x] summary schema's skipped description says 'did not execute', but a skipExitCode self-skip ran; reword when step 5 lists the summary fields
- [x] list `baseline diff` in docs/cheatsheet.md and the README command table (step 3 documented it in contract.md, tools.md and --help only)

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
