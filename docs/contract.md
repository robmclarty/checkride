# The checkride contract

This document names the surfaces a consumer may **rely on** — the promises, as
opposed to today's incidental behavior. Every surface listed here is backed by
a test that fails the build if it drifts — most in
[`test/contract/`](../test/contract/), and the rest in the unit suites under
`src/` beside the machinery they cover: the timeout and crash-consistency
promises in the suites named in [their section](#timeouts-and-interrupts)
below, and the config rules in the suite their [paragraph](#cli) names. Anything *not* listed here is
internal by definition and may change in any release.

Consumers of these promises include coding agents reading `.check/`, CI
pipelines gating on the exit code, and tools that delegate their definition of
done to checkride (plumbbob's commit gate, volley).

## Exit codes

| Code | Meaning | Consumer action |
| ---- | ------- | --------------- |
| `0` | Every executed check passed. | Proceed — but see [vacuous green](#vacuous-green) below. |
| `1` | At least one check failed. A **verification failure**: the work is not done. | Read `.check/summary.json`, then the failing slot's raw output. |
| `2` | The harness itself broke or was misused: a malformed `checkride.config.json`, an unknown command or flag, an internal error — or `--strict` with zero checks run. | Fix the invocation or environment; do not treat as "checks failed". |

The 1-vs-2 distinction is a promise: a gate may safely branch on it ("red
build" vs "broken harness"). `checkride doctor` uses the same `0`/`1` split
for "environment ok"/"environment has problems".

## Vacuous green

"Green because everything passed" and "green because nothing ran" are
distinguishable by every consumer:

- `summary.json` carries a top-level `checks_run` count of the checks that
  actually executed. `ok: true` with `checks_run: 0` means **nothing was
  verified**.
- A zero-run gets a loud stderr warning naming why each slot sat out and what
  would enable it.
- `--strict` turns a zero-run into **exit 2**. Anything that gates on
  checkride (CI, commit hooks, plumbbob) should run with `--strict`; a human
  exploring a fresh repo isn't punished by default.
- A custom check that exits its declared `skipExitCode` is **skipped**, not
  passed: it records the skipped shape below and stays out of `checks_run`, so
  a run where every check skipped itself is a zero-run, and `--strict` exits 2
  on it.
- `snippets` and `smoke` are **skipped**, not failed, when the scratch
  directory they generate files in, the `.check/` under their working
  directory (the repo root, or a target's root), can't be written, as in a
  read-only checkout that `--out` sent the artifacts away from. Their
  `reason` is `needs a writable ./.check for scratch files`.
- An active slot whose tool is not installed **fails** (exit 1); it does not
  skip. A skip would let the slot's absence read as coverage. Under
  `npx`/`bunx` the tool is resolved in the local tree rather than trusted to a
  per-user launcher cache, so the verdict follows the committed lockfile
  instead of varying by machine — see [tools.md](tools.md#package-managers).

## `.check/summary.json`

The aggregate report every run writes. Its shape is versioned by
`schema_version` (currently `1`) and published as a JSON Schema at
[`schema/checkride.summary.schema.json`](../schema/checkride.summary.schema.json),
which ships in the npm package.

**The additive-only discipline:** under a given `schema_version`, fields are
*added* (in lockstep with the published schema), never renamed, removed, or
retyped. A consumer written against schema version 1 keeps parsing every 1.x
summary. A non-additive change requires a `schema_version` bump and is a
breaking release.

Additive fields to date: per-check `baselined` (0.2.0), top-level `checks_run`
(0.3.0), per-check `origin`, `detected_by`, `argv`, `pin_source`,
`tool_version`, `narrowed`, `target`, `slot`, `pack` and `cwd`, `reason` on a
failed check, top-level `run`, `git` and `targets` (0.15.0), per-check
`baseline_captured_with` and `toolchain_version` (0.16.0), and per-check
`new_count` and `new`, with `reason` on a check that reached no verdict
(0.17.0).

The tables below name every field the schema allows, each with the rule for
when it's present. A field whose rule isn't "always" is left out otherwise,
never written as `null` or `false`, so absence is part of the shape. Inside
`run`, `git`, `git.base` and a `targets` entry, "always" means whenever that
object is present.
[`summary.contract.test.ts`](../test/contract/summary.contract.test.ts) holds
each list equal to the schema's properties, and the "always" rows equal to its
required ones, so a field can't reach the schema without a row here.

**Top-level fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `schema_version` | integer, `1` | always |
| `timestamp` | string, ISO 8601 | always: the time the report was written |
| `ok` | boolean | always: true when every check passed after baseline masking; a skipped check counts as passed, so read it with `checks_run` |
| `checks_run` | integer, 0 or more | always: the checks that executed, skipped entries left out |
| `total_duration_ms` | number, 0 or more | always: the run's wall-clock span |
| `run` | object, below | always: what the run selected, and whether it saw the whole pipeline |
| `git` | object, below | the working directory is in a git work tree whose `HEAD` names a commit, and git answered within 5 seconds |
| `targets` | array of target entries, below | multi-target mode, when `checkride.config.json` declares `targets` or `--discover` proposes them: each target the run checked, in config or discovery order |
| `checks` | array of per-check entries | always: one per selected check, skipped ones included, plus a skipped entry for each check `--only` or `--skip` left out, in the order below |

**`run` fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `partial` | boolean | always: true when `--only`, `--skip`, `--changed` or `--static-only` narrowed the run, it was a `checkride baseline` capture, which runs only the checks it can key, or `--bail` stopped it at a failure |
| `only` | array of strings | `--only` was given: the names it listed |
| `skip` | array of strings | `--skip` was given: the names it listed |
| `include` | array of strings | `--include` was given: the names it listed |
| `all` | `true` | `--all` was given |
| `changed` | `true` | `--changed` was given |
| `static_only` | `true` | `--static-only` was given |
| `discover` | `true` | `--discover` was given |
| `config` | string, an absolute path | `--config` or `CHECKRIDE_CONFIG` named the config file |
| `defaults` | string, an absolute path | `--defaults` or `CHECKRIDE_DEFAULTS` named the defaults file |
| `pins` | string, an absolute path | `--pins` or `CHECKRIDE_PINS` named the pins file |
| `out` | string, an absolute path | `--out` or `CHECKRIDE_OUT` named the output directory |

**`git` fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `head` | string | always: the full sha `HEAD` named as the run started |
| `dirty` | boolean | always: true when `git status --porcelain` listed anything, untracked files included |
| `base` | object, below | `--changed` was given: the base the run measured changes from |

**`git.base` fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `ref` | string | always: the base as `--base`, `CHECKRIDE_BASE` or `changedBase` named it, or `origin/main` or `HEAD` when nothing named one |
| `sha` | string | always: the full sha `ref` named |

**`targets` entry fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `name` | string | always: the target's name, which names its checks `<name>:<slot>` and its directory `<out>/<name>/` |
| `pack` | string | always: the pack that checks it: `ts`, `bash`, `go`, `rust`, `python` or `terraform` |
| `root` | string | always: the directory its checks run from, relative to the repo root and normalized, `.` for the root itself |
| `discovered` | `true` | `--discover` proposed the target |

**Per-check fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `name` | string | always: the slot name (`lint`), or the custom check's config key; `<target>:<slot>` (`web:lint`) for a target's check |
| `target` | string | multi-target mode, on a target's check: the target it belongs to |
| `slot` | string | multi-target mode, on every check: the catalogue slot or custom check name it fills |
| `pack` | string | multi-target mode, on every check, and implicit mode when the repo root marks a pack other than `ts` (a `go.mod`, `go.work`, `Cargo.toml`, `pyproject.toml`, `setup.cfg`, `setup.py`, `.terraform.lock.hcl` or `*.tf` file): the pack that fills it, the target's for a target's check and `repo` for a check of the repo as a whole, a top-level custom check included |
| `cwd` | string, repo-relative | the check ran from a directory other than the repo root, as a target's check does when its root isn't `.` |
| `adapter` | string or `null` | always: the adapter that ran or would have run (`oxlint`, or `custom:<key>` for a custom check with no `name`); `null` when the slot resolved to nothing |
| `description` | string | always: the adapter's description, or the slot name when the slot resolved to nothing |
| `ok` | boolean | always: pass or fail after baseline masking; `true` for a skipped check |
| `skipped` | `true` | the check didn't execute |
| `reason` | string | with `skipped`: why the check sat out, `static-only: <cause>` for one `--static-only` left out; on a failed check whose adapter declares `failOnOutput`: `<adapter> exited 0 but reported findings on stdout`; on a check refused before its tool spawned, with `exit_code` 1 (a tool the project never installed, a setup step not yet run, `prose` exemplars that are missing): the refusal's first line, whose whole text is in its `.stderr.txt`; on a check that never reached a verdict, with `exit_code` -1: what stopped it, `timed out after <N>s` for a timeout, and `check-<slot>: fallow could not run: <message> (exit <n>)` when fallow printed its own error report in place of one; on a failed check a committed baseline couldn't mask, since its tool stopped short of some errors, as tsc does on a syntax error: why, `tsc stopped short …, so the baseline neither masked its findings nor pruned its keys` |
| `exit_code` | integer or `null` | always: the tool's exit code, `-1` when it never reached a verdict: it failed to spawn or timed out, a built-in couldn't complete (`security` with the advisory endpoint unreachable), or fallow reported that it couldn't run, such as on a `fallow.toml` it can't read; `null` when skipped |
| `duration_ms` | number | always: wall-clock milliseconds, `0` when skipped |
| `output_file` | string or `null` | always: the JSON or JSON-lines (`.jsonl`) file the run wrote in the output directory (`.check/` unless `--out` named another), relative to it and so `<target>/<file>` for a target's check, or `null` when it wrote none |
| `origin` | `config`, `detected`, `built-in`, `custom` or `defaults` | `adapter` isn't `null`: why the check is in the run |
| `detected_by` | string | `origin` is `detected`: the matched detect file, `package.json: <dep>`, `package.json: scripts.<name>`, `<file>: [<table>]` for a TOML table that configures the tool, such as `pyproject.toml: [tool.ruff]`, or `<file>: <key>` for a pin that declares the tool, such as `mise.toml: shellcheck` |
| `argv` | array of strings, the command first | the check spawned its own tool: the command and arguments exactly as spawned, after package-manager translation |
| `pin_source` | `override`, `js-lockfile`, `go-mod-tool`, `rust-toolchain`, `uv-lock`, `tf-version`, `mise`, `nix` or `path` | the check's tool resolved through a pin source: the one that declared the copy that ran, `override` for one the `--pins` file pins, `nix` for a Nix dev shell's copy, or `path` for a tool nothing declared |
| `tool_version` | string | with `pin_source`, when a file read found the version of the tool that ran, or the pin source itself resolved it, as mise does |
| `narrowed` | `{ units, total }`: `units` the package patterns it ran, `total` how many modules the workspace uses | `--changed` narrowed a Go check to the workspace modules a change touched and their dependents |
| `baselined` | integer, 1 or more | a committed baseline masked at least one of the check's findings: how many |
| `new_count` | integer, 1 or more | the check failed with findings a committed baseline doesn't grandfather: how many, every finding of a key it doesn't hold and each one past a key's count |
| `new` | array of 1 to 50 strings | with `new_count`: the keys of those findings, sorted, the first 50 |
| `toolchain_version` | string | with `pin_source`, on a check of a pack that names a toolchain, `go` for the go pack: the release of that toolchain the check's tool ran on, when it could be found |
| `baseline_captured_with` | `{ pin_source, tool_version?, toolchain_version? }` | the check ran another copy of its tool than the baseline's `captured_with` records capturing its keys with: that record, so its new keys may be the tool's churn, and the ratchet held its keys back |

**Every check says why it's in the run.** `origin` is `config` when
`checkride.config.json` names the slot, presets it `extends` included, since
the two can't be told apart once folded. It's `detected` when no entry named
the slot and a detection signal chose the adapter, `built-in` when detection
chose an adapter that needs no signal (`links`, for one), `custom` for a
custom check keyed by a name outside the catalogue, and `defaults` when a
`--defaults` file filled a slot the repo's config and detection left empty, or
added a custom check of its own. A check that sat out
keeps the `origin` of the adapter that would have run, so a slot `--only` left
out, or a custom check that skipped itself, still says why it was selected.
The status line each executed check prints on stderr ends with the same fact
as a tag: `[config]`, `[detected: <detected_by>]`, `[built-in]`, `[custom]` or
`[defaults]`, and `checkride doctor` ends its slot rows the same way.

**A custom check can skip itself.** One that exits its declared
`skipExitCode` records the same entry as a slot with no tool: `skipped: true`,
`ok: true`, `exit_code: null`, `duration_ms: 0` and `output_file: null`. Its
`reason` is its last stderr line followed by `(exit N)`, and it writes no
artifact.

**A check that spawned its tool records what it ran.** `argv` holds the
command and its arguments exactly as checkride handed them to `spawn`. That's
after package-manager translation, so the canonical
`pnpm exec oxlint --format=json` reads `npx --no-install oxlint --format=json`
under npm, and under pnpm it keeps the `--config.verify-deps-before-run=false`
checkride puts ahead of `exec` and `run`. Under `--changed`, `{base}` is
already expanded. A tool that failed to start or timed out keeps its `argv`
beside its `exit_code: -1`, so the entry names what failed. A check that
spawned no tool of its own has none. That covers a built-in adapter (`links`,
`pnpm-audit`, `pack`, `smoke`, `snippets` and `snippets-dist`), which checkride
runs itself even when it starts processes along the way. It covers a check
refused before its tool started: an `npx` or `bunx` tool missing from the
local tree, or a `prose` slot whose exemplars are missing. And it covers every
skipped entry, a custom check that skipped itself included, since that entry
keeps the skipped shape above.

**A spawned tool says which copy ran.** A check's tool resolves through its
pack's pin chain (see [Packs and pins](./packs.md)), and `pin_source` names
the source that declared the copy that ran: `js-lockfile` for a
`pnpm exec <tool>` the project's package manager runs, a package script
(`pnpm run build`) included, `go-mod-tool` for a Go tool the target's
`go.mod` declares in a `tool` directive, run as `go tool <tool>`,
`rust-toolchain` for cargo, rustfmt or clippy, which a `rust-toolchain.toml`
pins with its toolchain, `uv-lock` for a Python tool the project's `uv.lock`
lists, run from the project's environment, `tf-version` for the `terraform`
or `tofu` CLI a `.terraform-version` or `.opentofu-version` declares, run
from `PATH` once it reports the release the file names, `override` for a tool the run's
`--pins` file pins, `mise` for a
tool a `mise.toml` in the repo names under `[tools]`, `nix` for a tool nothing
declared whose copy on `PATH` a Nix dev shell the repo declares put there,
which the repo's Nix files pin, and `path` for a tool nothing declared, found
on `PATH` and so unpinned. A toolchain's own executable, such as `go` or
`gofmt` in a go target, records `mise`, `nix` or `path` the same way.
[Packs and pins](./packs.md#pin-sources) says when a copy counts as a Nix
dev shell's. The values `pin_source` takes grow additively, as fields do:
one may be added in a release, never renamed or removed, so a consumer reads
an unknown one as a source it doesn't know yet. `tool_version` adds the
version when a file read finds it, or when the pin source itself resolved
it, never by running the tool: for `js-lockfile`, the `version` in
`node_modules/<package>/package.json` nearest the check's directory, for a tool
whose package `TOOLS` names, for `go-mod-tool`, the version `go.mod` requires
for the module that provides the tool, for `rust-toolchain`, the file's
channel when it names an exact release, for `uv-lock`, the version the
lock pins the tool's package at, for `tf-version`, the file's release when it
names one exactly, for `nix`, the version the copy's store path names,
such as `2.11.4` for `golangci-lint-2.11.4`, for `mise`, the version mise
resolved the pin to, which `mise which --version` prints as it confirms the
pinned copy is installed, such as `0.11.0` for `shellcheck = "0.11"`, and for
`override`, the release `mise where` resolved the `--pins` file's version to.
A mise pin that resolves to no release, such as `system`, records none, and
`path` records none, since the machine decides it. `pin_source` appears exactly where
`argv` does, apart from a command spawned as written through no pin source,
such as a custom check's `node scripts/x.mjs`, which records only its `argv`.
A custom check whose command is `pnpm exec <tool>` or another `pnpm`
subcommand, or a toolchain in a chain that reads `mise`, resolves and records
its `pin_source` as a catalogue check does. A declared pin whose source can't run the tool fails
the check with exit 1, naming the source; checkride never falls back to
another copy.

**A go check says which Go it ran on.** A pack whose checks all run on one
toolchain names it, and the go pack names `go`: golangci-lint compiles its
type checker and gofmt in and type-checks through the `go` it finds, so a new
Go release can re-key its findings while golangci-lint's own version stands
still. Each check of such a pack that records a `pin_source` adds
`toolchain_version`, the toolchain's release, found without running it: for
a check that runs `go` or `gofmt` itself, the version its pin source named;
for a tool a `go.mod` declares, the release of the `go` it runs through,
where mise or `--pins` resolved it; for any other tool mise runs, the `go`
mise resolves, which costs one `mise which --version go`; and otherwise the
release in the `VERSION` file at the GOROOT of the `go` the spawn's `PATH`
finds. A mise shim, a development build or no `go` at all leaves it out, and
the other packs' checks record none.

**A run records what it selected and the tree it read.** `run` names each
selection flag the run was given, so a narrowed run says so in the artifact
and not only on screen. `partial` is the test the baseline ratchet applies: a
run with `partial: true` didn't observe every check, so it never prunes
`checkride.baseline.json`. `git` names the commit the checks read and says
whether the work tree held changes that commit doesn't, and under `--changed`
it adds the base the run measured from. checkride asks git as the run starts,
alongside the checks, so the answer normally costs no time. A run whose checks
finish first waits for it, at most 5 seconds from the start, and
`total_duration_ms` counts that wait. When git hasn't answered by then, the
directory isn't in a work tree, or `HEAD` names no commit yet, `git` is left
out. git reads the tree as the checks start, and a gitignored `.check/`, as
`init` writes it, keeps the run's own artifacts out of `dirty`.

**A target's slots run once for that target, from its root.** When
`checkride.config.json` declares `targets`, the run checks the repo as a whole
once, at its root, and each target once from its own root. A repo-scope slot
(`struct`, `docs`, `links`, `spell`, `prose`, `unclaimed`) and a top-level
custom check keep
their bare names, run from the repo root and write into the output directory.
Every other slot runs once for each target whose pack fills it, or whose own
`checks` or pack block names it, as `<target>:<slot>`. Its entry comes from the
target's `checks`, then `packs.<pack>.checks`, then the top level's, then
detection, which reads the target's root: the first of those that picks a tool
or switches the slot off decides it, and `optIn`, `timeout` and `order` come
from the highest one that sets each. A target's custom checks, from its own
block or its pack's, run the same way. Each target's check runs with the
target root as its working directory and writes into `<out>/<target>/`, so its
`output_file` is `<target>/<file>`, and `{out}` in its args expands to that
directory as an absolute path, which keeps two targets' reports apart; a
repo-scope check's `{out}` is the absolute output directory. A built-in's
scratch files sit under the working directory's `.check/`, so a target's are at
`<target root>/.check/`, where they resolve the target's own modules, and its
skip reason names `./.check` relative to the entry's `cwd`. Before anything
runs, the run clears what it left for each target that the output directory's
previous `summary.json` listed in `targets` and the config no longer declares:
the files that summary's checks of the target name (`<slot>.stdout.txt`,
`<slot>.stderr.txt`, `<slot>.json` and each `output_file`), then the
`<target>/` directory once nothing else is in it. Nothing else is deleted: not
a file those checks didn't name, so a folder of yours under `--out` that shares
a target's name keeps your files, and not anything under a directory the
previous summary didn't list, a symlink, or a directory that holds the repo or
that target's own root. Without `targets` the run is unchanged, apart from
clearing what those targets left when the config has just dropped its
`targets`.

**Without `targets`, the repo is one target of the pack its root marks.** The
pack is the first match: a root `package.json` or `tsconfig.json` picks `ts`, a
root `go.mod` or `go.work` picks `go`, a root `Cargo.toml` picks `rust`, a root
`pyproject.toml`, `setup.cfg` or `setup.py` picks `python`, a root
`.terraform.lock.hcl` or `*.tf` file picks `terraform`, and nothing picks `ts`. The top-level `checks` are that target's own entries, so
for a target-scope slot or a custom check they rank above
`packs.<pack>.checks`, as they will once `target add` moves them into the
target, and the pack block is read for the root's pack alone. A ts root runs
exactly as 0.14 did when its config has no `packs`, and its entries carry no
`pack`. Any other root resolves as a target of its pack rooted at `.` would,
its pin chain and spawn environment included, and the repo-scope slots and
top-level custom checks as the `repo` pack, but every check keeps its bare
name, runs from the repo root, writes into the output directory, and records
its `pack`, with no `target`, `slot` or `cwd`. A top-level entry may pick a
target-scope slot's tool, since only one pack fills it. `init` adopts such a root as an existing repo, and refuses `--lang` there.

**Array order is deterministic.** The `checks` array is ordered by the run's
group sequence — `'first'`s, then each numeric wave ascending, then `'single'`s,
then `'last'`s; within a group by catalogue position, then repo scope before
target scope, then target order, then custom checks in config order (the
top-level ones, then each target's) — independent of the order the checks
actually *finish*. The same selection
produces the same array order on every run, even when concurrency interleaves
completion. `total_duration_ms` is the **wall-clock** duration of the whole run;
when execution is sequential (including any `--bail` run) it equals the sum of
the per-check durations, exactly as before, unless the run waited on git as
described above.

**Raw output stays authoritative.** The per-tool files beside the summary —
`.check/<slot>.json` when the tool emits JSON, `<slot>.jsonl` when it emits
JSON lines, `<slot>.stdout.txt` / `<slot>.stderr.txt` otherwise, under
`<target>/` for a target's check — are the tool's own bytes, never normalized,
reshaped, or filtered. The summary is an index; the raw file is the truth.
This is the product's thesis and will not change.

Only a check that declares an `outputFile` gets a JSON file, and the declared
extension says which form: a `.json` file takes stdout that parses as one
JSON value, and a `.jsonl` file takes stdout with at least one non-empty
line, every one of which parses as JSON on its own. A check that declares no
`outputFile`, a custom check included, keeps its stdout in
`<name>.stdout.txt` whatever it prints. JSON lines are a capture format, not
a normalization: the file holds the same bytes the tool printed.

The one thing dropped is output that is not the tool's. A launcher can print to
stdout before the tool does — pnpm narrates its dependency check there ahead of
`exec`/`run` — so a `<slot>.json` or `<slot>.jsonl` is written from the first
character of the JSON onward, discarding at most ten leading non-JSON lines.
Nothing *inside* the tool's output is touched, and a slot whose output doesn't
take its declared form, JSON lines with a line of text among them included,
keeps every byte in `<slot>.stdout.txt` instead.

**A tool that reports by printing can still fail its check.** Some tools,
`gofmt -l` among them, list what they found on stdout and exit 0 anyway. An
adapter that declares `failOnOutput` fails its check when the tool exits 0
with anything but whitespace on stdout: the entry is `ok: false`, keeps the
tool's `exit_code: 0`, and records `reason` as
`<adapter> exited 0 but reported findings on stdout`. A baseline can still
mask the check, as it masks any other. The go pack's `gofmt` and `deadcode`
declare it.

**`output_file` names a file that exists.** It is what the run actually wrote,
not what the adapter declares it usually writes: a slot that declares
`<slot>.json` but emitted text this run (or was skipped) reports `null`, and its
bytes are in `<slot>.stdout.txt`. A consumer may open a non-null `output_file`
without a guard.

**Artifacts are crash-consistent.** `summary.json`, the raw slot files,
`digest.md`, and `checkride.baseline.json` are written atomically
(temp-file-then-rename). A run killed at any point leaves each file either
previous-run-consistent or absent — never half-written. A consumer may parse
them without guarding against torn JSON.

**`digest.md` presence semantics.** Written only under `--digest` and only
when a check failed; a green `--digest` run removes any stale digest. Its
existence always means "this run had failures".

**A red `--digest` run prints its digest.** The text it writes to `digest.md`
also goes to stderr, last: below the `report:` and `digest:` lines and every
notice beneath them, such as a baseline that couldn't be parsed or the `hint:`
that new findings were grandfathered until a recent commit, so an agent
reading the run's output sees what failed without opening a file, and reads
what changes how the red reads first. stdout
stays as [stream discipline](#cli) keeps it, and a `--json` run prints no
human report, so there the digest is the file alone.

## `checkride.baseline.json`

The committed baseline: the file `checkride baseline` writes at the repo root,
beside `checkride.config.json`, and every run reads to subtract grandfathered
findings. Its shape is versioned by its own `schema_version` (currently `1`,
independent of the summary's) and published as a JSON Schema at
[`schema/checkride.baseline.schema.json`](../schema/checkride.baseline.schema.json),
which ships in the npm package. [The README](../README.md#baseline) explains
what the file is for; this section names what a consumer may rely on.

```jsonc
{
  "schema_version": 1,
  "slots": {
    "lint": ["src/legacy.ts:eslint(no-unused-vars):Variable 'legacy' is declared but never used."],
    "spell": ["docs/old.md::teh"]
  },
  "captured_with": {
    "lint": { "pin_source": "js-lockfile", "tool_version": "1.87.0" },
    "spell": { "pin_source": "js-lockfile", "tool_version": "9.0.0" }
  },
  "counts": {
    "lint": { "src/legacy.ts:eslint(no-unused-vars):Variable 'legacy' is declared but never used.": 2 },
    "spell": {}
  }
}
```

**The same additive-only discipline as the summary.** Under schema version 1
the file has `schema_version`, the integer `1`, `slots`, and optionally
`captured_with` and `counts`, and no other top-level field. `slots` is an object from
check name to an array of key strings: the slot name, or `<target>:<slot>`
for a target's check. A slot
whose adapter can be fingerprinted and had nothing to grandfather is present
with an empty array; a slot whose adapter has no parser, or whose output that
parser can't trust, is absent. `captured_with` records how
`checkride baseline` captured each check's keys: check name to the
`pin_source` its tool resolved through, the `tool_version` that source
named, when it named one, and the `toolchain_version` its tool ran on, for a
check of a pack that names a toolchain, as the run's summary recorded them. It holds only
checks `slots` holds, and only those whose tool resolved through a pin
source, and it's absent when none did. `counts` says how many findings each
key grandfathers, for a counted check: check name to each of its keys found
more than once, with how many times. It holds only checks `slots` holds with
at least one key, and it's absent when no check is counted. Fields
are added in lockstep with the published schema, never renamed, removed, or
retyped; a non-additive change bumps `schema_version` and is a breaking
release. The schema describes what checkride **writes**. What it accepts on
read is wider — see the tolerance promise below.

**A key names a finding by what it is, not where it sits.** Every key is a
string the slot's parser built; a consumer may compare keys, count them, and
diff them, never parse them. For the diagnostic parsers — oxlint, eslint and
biome, and the go, rust, bash, python and terraform packs' golangci-lint,
staticcheck, clippy, shellcheck, ruff and tflint (`lint`), ast-grep (`struct`),
markdownlint-cli2 and rumdl (`docs`), cspell and typos (`spell`), and vale
(`prose`) — the key is
`<file>:<rule>:<message>`: the message whitespace-collapsed, the rule empty for
cspell and typos (`<file>::<message>`). Only a finding that can fail the slot
is keyed:

- oxlint's and ast-grep's error-severity findings, unless the check's argv
  lets a warning fail too (oxlint's `--deny-warnings` or `--max-warnings`,
  ast-grep's `--error`, or an argv that runs the tool through a wrapper and so
  hides its flags), in which case every finding is keyed;
- eslint's errors (severity 2, a file it couldn't parse among them, keyed on an
  empty rule) and biome's `error` and `fatal` diagnostics, a warning as well
  when the argv lets it fail (eslint's `--max-warnings`, biome's
  `--error-on-warnings`, or a wrapper that hides the flags), and never a biome
  `info`;
- vale's error-severity alerts, and markdownlint-cli2's `error` lines, read
  from stderr where it prints them: a rule set to `"warning"` prints but can't
  fail the slot;
- every cspell, typos, golangci-lint and ruff finding;
- every staticcheck problem but an `ignored` one;
- clippy's `error`-level diagnostics, which the rust pack's `-D warnings`
  makes every one;
- shellcheck's comments at or above the argv's `--severity`, and rumdl's at or
  above its `--fail-on`, every one by default;
- tflint's issues at or above the argv's `--minimum-failure-severity`, every
  one by default, a notice included, and none under `--force`.

tsc's key (`types`) has the same form, its rule the diagnostic's `TS` code and
its message the first line of tsc's with what tsc filled into it written
`…`: each single-quoted span as `'…'`, then each double-quoted span as
`"…"`, each span in backticks as `` `…` ``, the list a "following …:" message
ends on as `…`, and every run of digits as `…`. So
`src/a.ts:TS2322:Type '…' is not assignable to type '…'.`,
`src/a.ts:TS2554:Expected … arguments, but got ….`, and
`src/a.ts:TS2740:Type '…' is missing the following properties from type '…': …`.
That text changes on edits elsewhere, as an anonymous object type prints its
whole shape, a property added to a type lengthens the list of those a value
lacks, and an older tsc names a module by its absolute path, so the key names
the error rather than what it mentions, and the errors it names alike in one
file are counted under it. A quote with a letter or digit on its outer side,
as in `can't`, bounds no span. Every tsc diagnostic can fail the slot and is
keyed. Where a run lists such a key's new findings, on stderr beneath the key
and in the digest, it shows each finding as tsc printed it, its place and
message whole. A run that stopped tsc short of some errors observes nothing, as one
that timed out doesn't: it masks nothing and prunes nothing, its check's
`reason` says why, and `checkride baseline` keeps the check's previous keys
and says why too, while `checkride/findings` still serves every finding it
printed. tsc stopped short when:

- it reported a diagnostic with no file, or on a `.json` file, where it
  reports a config it couldn't read or rejected: it type-checks none of a
  project whose options it rejects, and an unknown option, which it only
  reports, counts too;
- it reported a syntax error, a code tsc's parser reports (read from tsc
  7.0.2's), after which it type-checks none of that project;
- it reported `TS6305`, a referenced project whose declarations weren't
  built, whose types every file importing it then lacks;
- its output shows it died part way: killed by a signal, as pnpm, yarn or
  Node, under typescript 7's own launcher, reports one, or crashed, as a Go
  panic or fatal error, a Node heap or stack failure, or an uncaught
  exception shows. A line of a diagnostic, whatever its type holds, never
  counts;
- it found anything in a build that skips each project depending on one with
  errors: under `--stopBuildOnErrors`, with one dash or two and unless `false`
  follows it, or, before TypeScript 5.6, under `--build` itself, when the
  check's pin names the version and the build spans project references (it
  names more than one project, or the tsconfig it builds, `tsconfig.json`
  when it names none, holds `references` or can't be read). An argv that
  hides tsc's flags behind a script reads as tsc's default.

Some of what tsc hides a run can't show. Under `--noEmit` any other error in
a project hides its declaration-emit errors, and a project that skips its
emit under `noEmitOnError` never reports them. A referenced project that
emitted no declarations leaves each file importing it by its package's name
with `TS2307`, a module tsc can't find, or with an older build's
declarations where those still sit. Either way a run can prune the key of an
error it hid, which comes back as new once tsc reports it again.

A finding that fails the slot but names no file, such as staticcheck's
`compile` problem or a typos misspelling in a file name, keys with an empty
file. go build's, cargo check's, mypy's and basedpyright's type errors are
parsed for `checkride/findings` but never keyed, since each tool can stop
before it reports every error, and a run can't say which of the errors it
never reached were fixed: go build at ten errors in a package, building no
package that imports a broken one; cargo check at the first crate with
errors; mypy at a blocking error, a syntax error among them; and basedpyright,
in a file, at a syntax error its parser's recovery swallows the rest past.
Neither are terraform validate's errors, from a configuration that can't plan
either, and trivy's misconfigurations. Line and column are never part of these
keys, so a finding keeps its key when unrelated edits move it — the property
the ratchet and the merge story stand on. fallow's three slots (`dead`, `dupes`, `health`)
key on category and symbol instead, in the forms the parser documents, and
add a position only for a finding with no symbol to name. A `health` unit
fallow emits once to a file counts as a symbol: an Angular component's
`<component>` roll-up, and the one `<template>` of a markup file (an Angular
`templateUrl` file, or a `.vue`, `.svelte` or `.astro` component). An inline
template in a script file keeps its position, since nothing else tells two in
one file apart, and so does a Svelte `<snippet:NAME>`, since two in one file
may share a name. A file in a key is
named from the repo root: a target's check prints paths relative to its root,
and the key joins the root on, so `src/a.ts` from a target at `apps/web` keys
as `apps/web/src/a.ts`. A check at the repo root keeps the path as printed. An
absolute path inside the repo, which staticcheck, ruff and basedpyright print
for every finding, is made relative to the repo root, so a key reads the same
on every machine.

**A key grandfathers as many findings as it was captured with.** A key has
no position, so two of one finding in a file, two unchecked `x.Close()` calls,
share it. A check `counts` names is counted: each key grandfathers its count,
or one when the entry doesn't list it, and a finding past that is new. It
fails the check as a new key does, and stderr lists the key with both numbers,
`(3 found, 2 grandfathered)`. stderr lists a check's first ten keys with new
findings, sorted as the summary's `new` is, then a line saying how many more.
A check `counts` doesn't name was captured before
counts, by a release before them, and each of its keys grandfathers any number
of findings, as every key did then, so an upgrade changes no verdict. A
summary's `baselined` counts the findings the baseline grandfathered, not its
keys.

**The message inside a key belongs to the tool.** A key carries the tool's own
wording. A tool upgrade that rewords a message, renames a rule, or restructures
its report re-keys those findings, and they report as new until
`checkride baseline` recaptures them; a change to one of checkride's own
parsers does the same (0.6.0 and 0.9.4 were two), and the release notes say
so under that release. What is promised is the notice, never the wording.

So a run notices when a check ran another copy of its tool than
`captured_with` records: where both sides name a `toolchain_version`, one on
another `major.minor` line, such as Go 1.25.3 and 1.26.0 but not 1.25.5; past
that, where both sides name a `tool_version`, a different one, whatever
source named it, and where either names none, a different `pin_source`, such
as keys captured from `PATH` and a run in a Nix dev shell.
A record from a release whose `mise` source named no version reads as the
same copy as any run through mise. Such a check carries `baseline_captured_with` in the
summary, and a `baseline:` line on stderr names both copies when it has new
keys, or keys the ratchet held back, as its digest section does when it
fails. Its verdict is
unchanged: a new key still fails it. The ratchet prunes none of its keys,
since the copy the baseline was captured with may still report them. A check
with no record in `captured_with` is never held back.

**Written canonical, written atomically.** Every writer — `checkride baseline`
(including `init --baseline`), the ratchet, `recover --pick` — writes one shape:
slot names sorted, keys within each slot sorted and unique, `captured_with`
after `slots` with its checks sorted and each entry's `pin_source` before its
`tool_version`, and that before its `toolchain_version`, then `counts`, its
checks and keys sorted, each count two or more, two-space indentation, a trailing newline, through the
temp-file-then-rename write of the crash-consistency promise above. Two
branches that grandfather the same debt with the same tools produce
byte-identical files, and a write that would change nothing is skipped. A hunk
in `git diff` of this file is a change to the debt set or to the tools that
captured it, never to its formatting.

**Read is tolerant, and fails closed on the future.** A malformed baseline
never breaks a run. A file that does not parse, or whose `slots` is not an
object, masks nothing, and the run says so on stderr; `doctor` flags the same
file between runs. Inside a file that does parse, an unknown top-level field is
ignored, a slot whose value is not an array is dropped, a non-string key is
dropped, a `captured_with` entry that names no `pin_source` string, or no check
in `slots`, is dropped, a `counts` entry for a check `slots` doesn't hold is
dropped, and so is a count for a key the check doesn't hold, or one that isn't
a whole number of two or more. A `counts` entry that isn't an object still
counts its check, each key once, and a `counts` that isn't an object counts
every check, so a damaged count fails closed. A missing
`schema_version` reads as `1`. A `schema_version` above
the one this release writes is dropped whole: the run reports every finding
that is there rather than guess which ones a newer file meant to mask. The
reader takes text, not a path, so a historical copy from `git show` parses
under the same rules — which is what `recover` is built on. A key an earlier
release wrote in a form this one replaced reads as the key it takes now, so an
upgrade that moves a key without a change in what it names changes no
verdict: the `health` keys 0.18 wrote for `<component>` and a markup file's
`<template>`, which carried a position, read without it. A counted check
whose old keys read as one key grandfathers as many findings under it as they
did together. The file on disk keeps the old form until the ratchet or a full
`checkride baseline` rewrites it, since a narrowed capture and
`baseline --versions` leave every check they don't touch as the file holds
it.

**Who writes to it.** Keys are added only by `checkride baseline` and
`recover --pick`; a normal run only removes them, and only on a fully observed
run — the ratchet rule in [Timeouts and interrupts](#timeouts-and-interrupts),
and so does `checkride baseline --versions`, which never adds one. Counts
follow keys: `checkride baseline` counts every check it observes that holds a
key, the ratchet and `--versions` only lower a count to what the run found,
and never count a check, and `recover`'s union keeps each current key's count,
taking a recovered key's from the first counted snapshot that holds it.
A release before counts drops `counts` when its ratchet rewrites the file,
which leaves every key grandfathering any number again.
A check observes its entry only when it reached a verdict on its own findings.
One that timed out, failed to spawn or was interrupted (exit `-1`), or that
failed without a single finding its parser could read (a refusal, missing
setup, a crash), observes nothing: it prunes none of its keys, and it is never
masked green, so a timeout whose partial output holds only grandfathered keys
stays red. `checkride baseline` keeps such an entry's previous keys, and its
`captured_with` record, and names the check on stderr, rather than writing it
empty. Only `checkride baseline` writes `captured_with`: the ratchet carries it
as it is, and `recover --pick` keeps the current file's record for each check
that has one. `checkride baseline --versions` writes a check's record only as
[its rule](#cli) admits: for a check that ran to a verdict, reported no key its
entry lacks and no more findings of a key than it grandfathers, and ran a copy
the repo's pins chose, its toolchain included. A release before
0.16.0 rewrites the file without it.
`recover`'s own promises are in [CLI](#cli). The generated `protect` hook denies
an agent's edits to the file, so a change to it arrives as a reviewed diff.

## CLI

The command set — `checkride` (run), `init`, `doctor`, `fix`, `baseline`,
`recover`, `target`, `agent-setup`, `hooks`, `gate`, `triage`, `qa` — and the
run flags:

```text
--only <a,b>  --skip <a,b>  --include <a,b>  --all  --changed  --base <ref>
--bail  --json  --digest  --strict  --concurrency <n>  --config <path>
--out <dir>  --defaults <path>  --discover  --pins <mise.toml>  --static-only
```

are promised. New commands and flags are additive; removing or repurposing one
is a breaking change. `baseline` additionally promises `--versions`, whose
rule is below, and `--only` and `--skip`, and `init` and `agent-setup` promise
`--hook <a,b>` (select which hooks to write: `gate`, `dirty`, `protect`; an
unknown name is a usage error naming the valid set), `--no-hook` (write none),
`--remove-hook <a,b>` (tear installed ones back out — the config entry and the
generated script; same usage-error rule, and naming one hook in both `--hook`
and `--remove-hook` is a usage error), and `--harness <a,b>` (which harnesses to
write them for: `claude`, `cursor`; same usage-error rule). Omitting `--harness`
selects `claude` plus any harness the repo shows evidence of. `init` also
promises `--lang <ts|go|rust>` for a new project, its `--shape` values for each
(`flat`, `monorepo` and `hybrid` for ts, `module` and `workspace` for go,
`crate` and `workspace` for rust), and `--module <path>` for a Go module's
path. A `--shape` its `--lang` doesn't take is a usage error, and so is a
`--lang` other than `ts` in an existing repo, which `init` reads the languages
of for itself.

**`fix` runs the selected fixers over the repo as it stands.** It takes
`--only`, `--skip`, `--include`, `--all`, `--concurrency` and `--config` as
a run does, and `CHECKRIDE_CONFIG` too. It refuses, with exit 2 before
anything runs, the flags that would change which files its fixers rewrite
or with which tool: `--static-only`, `--discover`, `--base`, `--out`,
`--defaults` and `--pins`, each named with why, as in `fix doesn't take
--static-only: fixers rewrite files and can load the repo's code`. It
accepts the other run flags 0.14 accepted, `--changed`, `--bail`, `--json`,
`--digest` and `--strict`, without acting on any of them, and it never reads
`CHECKRIDE_PINS`, `CHECKRIDE_DEFAULTS`, `CHECKRIDE_OUT` or
`CHECKRIDE_BASE`. Each fixer is the copy of its tool the repo pins, over the
targets its config declares.

**`--config <path>` and `CHECKRIDE_CONFIG` name the config file.** Run,
`doctor`, `fix` and `baseline` read that file in place of
`<cwd>/checkride.config.json`. The flag beats the variable, and an empty
variable counts as unset. A relative path resolves against the working
directory; the file's own relative `extends` resolve against the file, while
paths inside its values stay relative to the repo being checked. A named file
that doesn't exist is exit 2, never a fall back to the repo's config. A run
whose file sits outside the repo (the directory checkride runs in) never
ratchets and never writes `checkride.baseline.json`, because it doesn't speak
for the repo's own gate; stderr says so when a ratchet would have pruned keys.
A file inside the repo, and the `baseline` command wherever its file sits,
behave as they do without the flag. `gate` takes neither: it strips
`CHECKRIDE_CONFIG` from the check it spawns, which always reads the repo's own
config.

**`--defaults <path>` and `CHECKRIDE_DEFAULTS` layer a config below
detection.** Run and `doctor` read the named file as a defaults layer, which
fills only what the repo leaves empty. A slot that no entry of the repo's
decides and detection leaves without a tool takes one from the file's
`packs.<pack>.checks`, then its `checks`; its entry records
`origin: "defaults"`, and its status line ends `[defaults]`. A tool detection
found, a repo entry that picks a tool or says `false`, and an inactive slot
stay as they are. A defaults `false`, or an entry naming an adapter the
check's pack doesn't have, fills nothing, so a ts linter at the file's top
level never lands on a go target. A filled slot keeps the opt-in status the
repo gives it, so an opt-in slot still needs `--include`, and the repo's
`optIn`, `timeout` and `order` apply over the file's. A custom check of the
file's joins only under a name the repo's config declares in none of its
blocks, a `false` included, and records `origin: "defaults"` too. The file's
top-level `timeout` and `requirePins` apply only where the repo's config sets
neither. The file holds only `checks`, `packs`, `extends`, `timeout`,
`requirePins` and `schemas`: `targets`, or any other key, exits 2. So does an
entry that breaks a rule resolution holds entries to, or a top-level entry
naming an adapter no pack has, whether or not it fills a slot in this repo,
and every such error names the file. The flag beats the variable, an empty
variable counts as unset, a relative path resolves against the working
directory, the file's own `extends` resolve against the file, and a named file
that doesn't exist is exit 2. A run with it never ratchets and never writes
`checkride.baseline.json`, wherever the file sits, and its summary records the
file as `run.defaults`. `gate` strips `CHECKRIDE_DEFAULTS` from the check it
spawns.

**`--pins <mise.toml>` and `CHECKRIDE_PINS` override the repo's pins.** A
run reads the named file's `[tools]` entries with their versions, each a
string or an inline table's `version`; an entry with no version, a
`[tools.<id>]` table, a file that pins no tool at all (no `[tools]` table, a
mistyped `[tool]` among them, or an empty one), or a missing file exits 2,
naming the file. The file
becomes an `override` source at the head of every pack's pin chain, ahead of
the repo's own pins: a tool whose mise id it names runs as
`mise exec <id>@<version> -- <bin>`, offline and with mise's installs off, and
records `pin_source: "override"` with the release `mise where` resolved that
version to as its `tool_version`, `2.14.0` for a `2.14`, as `doctor` reports
it. A
toolchain it names, such as `go`, runs that copy too. A version mise hasn't
installed, as `mise where` reports it, fails the check naming the tool and the
`mise install` that would fix it, and nothing downloads. It changes which copy
runs, never which checks run, so detection still reads only the repo's files.
mise reads no config file inside the repo for such a tool: checkride adds the
repo root to `MISE_IGNORED_CONFIG_PATHS`, after any paths it already holds, on
both the `mise where` and the `mise exec`, so a `mise.toml` there that mise
hasn't trusted neither fails the check nor gets trusted, and its `[env]` never
reaches the tool. A refusal names `mise trust` only for a config file above the
repo, which mise still reads.
The flag beats the variable, an empty variable counts as unset, and a relative
path resolves against the working directory. A run with it never ratchets and
never writes `checkride.baseline.json`, its summary records the file as
`run.pins`, and `gate` strips `CHECKRIDE_PINS` from the check it spawns.
`doctor` reads the flag and the variable the same way, and probes the copies
such a run would launch: each check whose tool or toolchain the file pins
reports `pinSource: "override"` and, as `toolVersion`, the version
`mise where` finds for it, a prefix resolved to the installed release. A
version mise hasn't installed reports the tool missing, naming the
`mise install` that would fix it, and a tool the file pins leaves the
unpinned rows.

**`--static-only` keeps only the checks that read the repo as data.** It's
a selector for a run before the repo is installed or sandboxed, and it isn't
a sandbox: it judges each check by names and known config keys, a tool
release can add a way to load code that judgment doesn't know, and untrusted
code belongs inside a real sandbox. A selected check stays in only when every
rule holds, and is otherwise skipped with the reason `static-only: <cause>`:

1. Its adapter is marked static in the registry, or a defaults file's entry
   vouches for it with `static: true`. A custom check from the repo, or an
   entry that swaps a static adapter's command, never qualifies, and neither
   does an entry whose `args` or `changedArgs` add an argument the adapter's
   own don't carry, such as prettier's `--plugin`, whether the repo's config
   sets it or a preset it extends does. An entry that only drops or reorders
   the adapter's arguments, as oxlint without `--type-aware` does, keeps the
   mark, and a defaults entry with `static: true` keeps its vouch. The skip
   names what the entry did: the command it swapped in, or the first argument
   it added.
2. Its argv carries none of the adapter's flags that need the install, such
   as oxlint's `--type-aware`, which the blessed oxlint invocation carries
   wherever a package.json from the check up to the repo root declares
   `oxlint-tsgolint`, and none that load code, such as tflint's `--config`. A
   flag counts with its value after `=` as well.
3. None of the adapter's code configs, such as `.markdownlint-cli2.cjs`,
   `oxlint.config.ts` or `prettier.config.mts`, sits where the tool reads a
   config, in any case of its name: under the check's directory, and for
   prettier, which takes the nearest config above a file, directly inside
   each directory above a target's root too, up to the repo root. The sniffs
   read what's on disk there, files git ignores included, but never inside a
   `node_modules`, whose packages' configs no static tool reads; a vale
   `StylesPath` or a cspell `import` that reaches into one counts instead,
   since what it names goes unread, as does a `StylesPath` outside the repo:
   absolute, under the home directory, or climbing out with `..`.
4. None of the config keys that load code is set in a config file it reads,
   such as `jsPlugins` or `extends` in `.oxlintrc.json`, `outputFormatters` in
   `.markdownlint-cli2.jsonc`, or a script, JavaScript or TypeScript, in
   cspell's `import`, in any of the config names cspell reads. A config held
   in `package.json` counts the same way, read from its `prettier`, `cspell`
   or `markdownlint-cli2` property, and a dependency of that name doesn't. A
   config that names a shared config, as a `.prettierrc` or `package.json`'s
   `prettier` can by holding a module's name as a string, counts, and so does
   a `package.json` that won't parse. A vale style that `extends: script`
   counts in any directory, since `StylesPath` can name any.
   A key counts however the file's parser would still read it: spelled with
   `\x`, `\u` or `\U` escapes, opening a flow mapping such as
   `{plugins: [./x.mjs]}`, or after a comma. A longer name that ends in it,
   such as `no-plugins`, doesn't. A key's value is read the way the parser
   reads it too, so a cspell `import` of a script counts with a `#` inside its
   quotes, split by YAML's escaped line break, past a comment at column 0 in
   its list, running on over lines, or behind a tag, and a YAML alias counts
   without being read.
5. Its tool resolves without an install. A tool whose pin source can't run it
   here, such as a `pnpm exec` tool missing from `node_modules/.bin`, skips
   with `static-only: needs an install (<detail>)` instead of failing.

The static adapters are prettier, biome and biome-format, oxlint, ast-grep,
markdownlint-cli2, rumdl, cspell, typos, vale, shellcheck, shfmt, gofmt, ruff
and ruff-format, terraform-fmt, tflint and trivy-config, and the `links` and
`unclaimed` built-ins; the rest never qualify. Three ways to load code are
known and not sniffed: a `prettier` key in a `package.yaml`, a cspell
`import` of a bare package name that resolves to a script, and whatever
trivy-config's own config can load. A terraform target's tflint
also skips wherever it would run a plugin binary, as
[Packs and pins](./packs.md#the-terraform-pack) lists. The run is
partial, so `run.partial` and `run.static_only` are `true`, and it never
ratchets or writes `checkride.baseline.json`. `doctor --static-only` reports
what such a run would do: each check it would skip carries the same
`static-only: <cause>` as `skip` and fails nothing, the run's own launcher
says whether each kept check's tool resolves without an install, and a
missing install is a warning rather than a failure.

**`--discover` checks the targets the repo's files propose.** Run and
`doctor` take the targets discovery proposes, the ones existing-mode `init`
would write, and apply them in memory as if the config declared them, writing
nothing. A config that already declares `targets` keeps them: run and `doctor`
check those targets as they would without the flag, and stderr carries one
note naming them as the reason, `--discover: the config declares its targets
(web, api), so they stand in for discovery`. The summary still records
`run.discover`, no target carries `discovered`, and the run never ratchets.
Otherwise, discovery reads the files git lists. A root that holds a
`package.json`, `pnpm-workspace.yaml` or `tsconfig.json` and runs a ts tool
of its own proposes one `ts` target at the root, which claims every nested ts
project. The root runs one when the config picks a tool for a target-scope
slot, at its top level or in `packs.ts.checks`, or when detection finds a
default ts check's tool there: a config file such as a `tsconfig.json`, an
`.oxlintrc.json` or a vitest config, or a package the root `package.json`
lists in `dependencies` or `devDependencies`. Otherwise each top-most
directory below the root holding a `package.json` or `tsconfig.json`
proposes its own, and a root `package.json`, which only installs tools, is
added to `unclaimed.ignore` in memory, since no ts target can claim it.
Each top-most `go.work` directory proposes a `go` target that claims the
modules its `use` directives name, and each top-most `go.mod` no go target
claims proposes one more. Each top-most `Cargo.toml` with a `[workspace]` table
proposes a `rust` target, and each top-most `[package]` manifest outside it one
more; a cargo-fuzz harness, whose `[package.metadata]` sets `cargo-fuzz =
true`, proposes nothing, so the crate above it claims it. Each top-most
directory holding a `pyproject.toml`, `setup.cfg` or `setup.py` proposes a
`python` target. Each directory holding a `.terraform.lock.hcl` proposes a
`terraform` target, one below another included: a root module no module call
reads, which the outer one's `validate` never checks. Such a nested target
switches `lint`, `format` and `security` off, since the outer one's
`tflint --recursive`, `fmt -recursive` and `trivy config` already read its
files, and runs `validate` alone. Each top-most directory holding `.tf` files
that none of those claims proposes one more. Where a pack's second rule
finds a root above one its first rule proposed (a `go.mod` above a `go.work`,
a `[package]` above a `[workspace]`, `.tf` files above a lock file), the inner
root wins and the outer one proposes nothing, since two targets of one pack
can't nest, terraform's lock-file roots apart: its markers stay unclaimed, so
`unclaimed` reports them rather than the run failing. The shell files outside all of those gather into one
`bash` target, those at such an outer root included. A
target is named after its root's last segment, `.` becoming `app`. When two
targets would take one name, or one would take a slot's, a reserved or a
custom check's name, each of them takes a longer one, whatever order they were
found in: targets at one root their pack's name (`ts` and `go`), targets at
different roots the shortest run of their root's trailing segments no other of
them shares (`api-infra` and `web-infra`), and one with neither its pack's
name after its own (`test-ts`), then a number. When discovery proposes nothing, or only one target at the root of
the pack the root marks, the repo stays in implicit mode and the run is
unchanged. Otherwise the target at the root of that pack takes the top-level
entries for target-scope slots and the baseline's entries, `lint` read as
`app:lint`, as `target add` would hand them over, so masking keeps working.
With no such target, those entries are dropped, and stderr names each. The
summary's `targets` entries carry `discovered: true` and `run.discover` is
`true`. The run never ratchets or writes `checkride.baseline.json`.

**`--changed` measures from one base ref.** It resolves from `--base <ref>`,
then `CHECKRIDE_BASE` (an empty variable counts as unset), then the config's
`changedBase`, then `origin/main` when it names a commit, then `HEAD`. A check's
`changedArgs` say `{base}` where they need it: vitest runs `--changed {base}` and
jest `--changedSince {base}`, so with nothing named and `origin/main` present the
argv is the one 0.14 spawned. A base that `--base`, the variable or the config
names and that doesn't name a commit exits 2 before anything runs, because
narrowing from some other base would check a different change. A defaulted
`origin/main` that doesn't resolve, as in a clone without that remote, falls
back to `HEAD` with a warning on stderr. Outside `--changed` the base is never
resolved, and `gate` strips `CHECKRIDE_BASE` from the check it spawns, as it does
`CHECKRIDE_CONFIG`.

**With `targets`, `--changed` skips the targets nothing changed under.** The
changed paths are every path that differs between the work tree and the merge
base of the base and `HEAD`, committed, staged or not, plus the untracked files
git doesn't ignore. A rename counts as both its paths, and with no merge base
the base itself stands in. Each check of a target with no changed path under
its root is recorded as skipped, with the reason `no changes under <root>`.
Repo-scope and top-level checks run as before, and an affected target's checks
get their `changedArgs`. When git can't list the paths, as outside a git
repository, no target is skipped and stderr says so. A repo without `targets`
narrows through `changedArgs` alone, as it always did.

**A Go check names its packages with `{go-packages}`.** An adapter argument
that is exactly `{go-packages}` expands, in a go target or a Go root without
targets, to `./...` at a module root, and to `./<dir>/...` for each `use`
directive at a `go.work` root, in `go.work` order, since a workspace root's own
`./...` matches none of its modules. `argv` records the expansion.

**A Go workspace narrows to the modules a change touched.** At a go target
whose root holds a `go.work`, `go build` and `go test` run only the modules
that hold a changed path, the deepest `use` directory winning, and every
module that depends on one of them, transitively, where a module depends on
another by requiring its module path or replacing a module with its
directory, in its `go.mod` or the `go.work`, or by importing one of its
packages from any `.go` file, a `_test.go` file included, since a workspace
resolves an import no `require` names. An import belongs to the workspace
module whose path is the longest prefix of it; a module's files are the ones
its `./...` reaches, stopping at a directory that holds its own `go.mod`, and
a `.go` file checkride can't read makes its module depend on every other.
Their argv names `./<dir>/...` for each, in `go.work` order, and the entry records
`narrowed: { units, total }`. A change to `go.work`, `go.work.sum` or any
`go.mod`, or a workspace file checkride can't read, runs every module and
records no `narrowed`; a change under none of the modules skips both checks
with the reason `no Go module changed under <root>`. deadcode and govulncheck
read the whole program, so they never narrow, and a single module has
nothing to narrow.

**With `targets`, `unclaimed` reports the code no target checks.** It's a
repo-scope slot that runs in every multi-target run. A marker is a file that
marks one language's code: `package.json` and `tsconfig.json` for `ts`,
`go.mod` and `go.work` for `go`, `Cargo.toml` for `rust`, `pyproject.toml`,
`setup.cfg` and `setup.py` for `python`, and `.terraform.lock.hcl` and every
`*.tf` file for `terraform`. A marker is claimed when a target of its pack is
rooted at the marker's directory or above it, so a target at the root of a
workspace claims every package in it. Every marker no target claims fails the check (exit 1),
except one under `node_modules/`,
`vendor/`, `target/`, `.venv/`, `.terraform/`, `.check/`, the output directory,
any `testdata/` or any `test/fixtures/`, and one an `unclaimed.ignore` glob
matches, the glob matching the path or a directory above it. The files it
reads are the ones git lists, tracked or untracked but not ignored, or every
file outside a git repository. It writes `unclaimed.json` in the output
directory, in checkride's own format, even when it passes:

```json
{ "unclaimed": [ { "path": "tools/gen/package.json", "kind": "ts",
                   "suggest": { "name": "gen", "lang": "ts", "root": "tools/gen" } } ] }
```

`suggest` is the target that would claim the marker, named as discovery
names its targets: after its directory, or `app` at the root, and longer when
a slot, a target, a custom check or another suggestion holds that name. A root `package.json` above
ts targets in their own directories is unclaimed, and because two ts targets
can't nest, the way to quiet it is `unclaimed.ignore: ["package.json"]`. The
same holds for any marker whose suggested target would hold a target of its
pack, such as a root `go.mod` above a `go.work` discovery proposed, and the
message says so in place of suggesting that target. Terraform's targets nest,
so for its markers the message suggests the target, and says to switch
`format`, `lint` and `security` off in each one it would hold, as
`target add` does when it adds one target inside or around another.
Without `targets`, `unclaimed` is **inactive**: absent from `checks`, as an
unselected opt-in slot is, but under `--all` too. Its name stays a valid token,
so `--only unclaimed` or `--include unclaimed` records one skipped entry with
the reason `runs only when checkride.config.json declares targets`. A config
entry that picks a tool for the slot, such as a custom check of the same
name, runs either way.

**`checkride target add` declares a target and converts a repo that has
none.** `checkride target add <name> --lang <pack> --root <dir>` adds the
target to `checkride.config.json`, creating the file when it's absent, and
names in its `checks` each non-opt-in tool detection finds under its root.
`--add <a,b>` names the blessed tool for those slots too, and for a ts,
python or terraform target scaffolds its config under the root. In a repo that declares no targets, the
implicit target becomes an explicit one of its pack named `--root-name`
(default `app`), rooted at `.`: the top-level `checks` entries for target-scope slots move into
its `checks`, and `checkride.baseline.json`'s entries move from `<slot>` to
`<name>:<slot>` with their keys unchanged, so the next full run masks exactly
what the last one did. A target of the implicit pack rooted at `.` takes the
implicit one over instead. A root that marks no pack, which resolves as ts
only by default, converts only when it resolves a target-scope check that
runs a tool, through detection, an entry or `packs.ts.checks`, or a
top-level entry picks one; otherwise the new target is declared alone, and
the top-level entries, which can then only switch a slot off or tune it,
stay where they are. Every change is printed; `--dry-run` prints them and writes nothing.
The new config is merged and validated first, so a change that breaks a rule
(a ts target nesting under the converted root, for one) exits 2 having written
nothing, as does a baseline that can't be parsed.

**`init` in an existing repo proposes the targets its files suggest.** A
directory is an existing repo when its root holds a `package.json` or another
shipped pack's marker, or, holding none, when discovery proposes a project
below it, as in a repo whose languages all live in subdirectories; only a
directory with neither gets a new project scaffolded. `init` reads the repo's
files as `unclaimed` does and proposes a ts target at the root when the root
holds a `package.json`, `pnpm-workspace.yaml` or `tsconfig.json` and runs a ts
tool of its own, as `--discover` reads it, claiming every nested package, and
otherwise one for each top-most `package.json` or `tsconfig.json` directory
below it, listing a root `package.json` in `unclaimed.ignore`. The repo's
implicit target becomes a target of its own only when its root marks a pack
and, for a ts root, runs a ts tool of its own, so `init` never declares a ts
target at `.` that checks nothing. Shell files
outside every other proposed target's root propose one bash target, at the
deepest directory holding them all, named `scripts` when that directory is
the root's `scripts/` and `shell` otherwise. Other names come from each
root's last segment, `.` becoming `app`, and a name that collides takes a
longer one, as `--discover` names them above. When it proposes no more than
one target at the root, of the pack the root marks, that is the mode the repo
already runs in, so nothing changes. Anything more is printed as
a `targets` block and written the way `target add` writes it, unless
`--dry-run`. A config that already declares `targets` is left alone. The go,
rust, python and terraform targets it proposes follow the rules `--discover`
gives above. `init` runs each default-on catalogue check once to see what
fails, never an opt-in one, a custom check or `unclaimed`, under the config
it would write, the targets it proposes included, `--dry-run` too, or the
repo's own config when it has one, and names each by its check name,
`api:lint` for a target's. A check it disables is written `false` in its own
entry, a target's under that target's `checks`, in a config it writes, or,
in a repo with its own, for a target it declares there, and under
`--baseline` it captures the baseline after the config declares every
target, so each one's keys are grandfathered.

**A bash target's checks run over its files.** An adapter argument that is
exactly `{files}` expands, in a target of a file-list pack (bash), to the files
under the target's root that git lists, tracked or untracked but not ignored,
or every file under it outside a git repository. Its `include` globs keep a
file, by default every `.sh` and `.bash` file and each extensionless file whose
first line is a `bash`, `sh`, `dash` or `ksh` shebang, and its `exclude` globs
drop a file or a whole directory. Paths are relative to the target's root, one
argument each, so `argv` names every file the check read. A target whose list
matches nothing records its checks as skipped with the reason
`no files matched`. A list that would take a check's argv past 200,000 bytes
is a usage error (exit 2), raised before any check runs or any artifact is
written, and the message names the target's `include` and `exclude`.

**`--out <dir>` and `CHECKRIDE_OUT` move a run's artifacts.** The summary, the
raw files and `digest.md` are written to that directory instead of
`<cwd>/.check`, and `output_file` stays relative to it. The flag beats the
variable, an empty variable counts as unset, a relative path resolves against
the working directory, and the flag with no directory is exit 2. `baseline`
takes it for its capture run, `triage` reads from it and passes it to the run it
starts as `CHECKRIDE_OUT`, `qa` reads from it, and `doctor` probes that
directory instead of `.check`. Every line that names an artifact names the
directory the run used: the `report:` and `digest:` lines, the digest's raw
pointers, and the `triage` and `qa` reports. It's written relative to the
working directory when it sits inside it, so `.check/` by default, and absolute
when it sits outside. `{out}` in a check's `args` or `changedArgs`, a custom
check's included, expands to the same directory: `.check` with no flag or
variable, so 0.14's argv holds, and the absolute path when one names it. With
`targets` declared it's always absolute, and a target's check gets its own
`<dir>/<target>` ([above](#checksummaryjson)).
Scratch isn't output. `snippets` and `smoke` generate files that have to
resolve the repo's own modules, so they write under the `.check/` of the
directory they run from, the repo root or a target's root, whatever `--out`
says, and skip when it can't be written. A run whose directory sits
outside the repo never ratchets and never writes `checkride.baseline.json`,
like a `--config` outside it, while `baseline --out` still writes the file at
the repo root. `gate` strips `CHECKRIDE_OUT` from the check it spawns and reads
`<repo>/.check/`, and the hooks never pass it. Separate `--out` values keep two
runs' artifacts apart; they don't keep the tools apart, since build info, test
caches and `.fallow/` are shared, so concurrent runs that write those belong in
separate worktrees.

**A capture runs only the checks whose findings it can key.** `checkride
baseline` skips each check whose adapter no parser the baseline keys with
reads, a test runner's, a built-in's, and a type checker's other than tsc's
among them, with
`baseline: <adapter>'s output adds no key` as its summary entry's reason,
since its output could add nothing to the file, and its summary records
`run.partial: true`. `--only` and `--skip` select
the checks a capture runs as they select a run's, an unknown token or an empty
list being exit 2, and the capture then rewrites only the entries of the
checks it recorded: every check they leave out keeps its keys, its counts and
its `captured_with` record as the file holds them, byte for byte, and a
capture that records no check, because none it selected is one the baseline
keys or none ran to a verdict, writes nothing and says so. A file that can't be parsed
stops a narrowed capture with exit 2 before anything runs, since the checks it
leaves out couldn't keep their keys; a capture of every check replaces such a
file whole, as it always did. `baseline --versions` takes `--only` and
`--skip` too, and names only the checks they select.

**`baseline diff` says what the working tree grandfathers, and writes
nothing.** `checkride baseline diff [<ref>] [--json]` reads `<ref>`'s committed
`checkride.baseline.json` through git (default `HEAD`), compares it with the
working-tree file, and prints the keys added and removed per check. A file
missing on either side reads as empty, so a ref from before the baseline
existed reports every current key as added. `--json` prints one object:

```json
{
  "ref": "origin/main",
  "sha": "4f2c1e0b9d8a7c6b5a4f3e2d1c0b9a8f7e6d5c4b",
  "added": { "lint": ["src/a.ts:eslint(no-unused-vars):Variable 'x' is declared but never used."] },
  "removed": { "struct": ["src/b.ts:no-class:no classes"] },
  "added_count": 1,
  "removed_count": 1,
  "recounted": { "lint": { "src/c.ts:errcheck:Error return value of `x.Close` is not checked": { "from": 1, "to": 2 } } },
  "recounted_count": 1
}
```

`ref` is the ref as given, `sha` the full sha it resolved to, and `added` and
`removed` map each check that changed to its sorted keys, leaving out checks
that didn't. `recounted` maps each check to the keys both copies hold whose
count changed, each to `{ "from": n, "to": n }`, the findings it grandfathers
at `ref` and in the working tree, `null` for a check captured before counts,
and `recounted_count` counts them. Fields are added, never renamed or removed. It exits 0 whenever
it ran, keys added or not, because the diff is evidence rather than a verdict,
and 2 when the ref names no commit, git is missing, or either copy can't be
parsed (a file from a newer checkride included). `--config` belongs to the
capture: `baseline diff` rejects it, and `baseline` rejects a stray argument,
so a misplaced `diff` never rewrites the file.

**`baseline --versions` records the copy each check ran, and adds no key.**
A tool upgrade holds a check back from the ratchet when it ran another copy
than `captured_with` records, and a capture would grandfather whatever is new
in the run along with the churn. `checkride baseline --versions` runs the
checks as a capture does, masking nothing, then changes a check's entry only
when all three hold: the check ran to a verdict on its own findings; every
key it reported is already in its entry, found no more often than its count
allows; and its tool resolved through a pin
source other than `path`, the repo's own pin, as did the toolchain it ran on
where it records one (the `go` the repo's `mise.toml` pins, or its Nix
shell's, not one from a machine's `PATH` or a user's own mise config), so CI
runs the same copy. A prefix pin, such as mise's `"0.11"`, resolves per
machine among the releases installed, so pin a release exactly where CI and
the machine that runs this have to agree. Such a
check's `captured_with` record becomes the copy that ran, and the keys that
copy no longer reports are pruned, and each count lowered to what it found. Every other check keeps its entry and
record byte for byte. stderr names each check it re-recorded, with both
copies and how many keys it pruned, and each it left, with why: it didn't
run, it reached no verdict, it reported new keys, or it ran an unpinned tool
or toolchain.
The file is written only when a check was re-recorded. It never adds a key
and never changes a verdict, since a key a check doesn't report can't fail
it, which is why an agent may run it; plain `baseline` stays a human's call.
It takes `--config` and `--out` as `baseline` does, and exits 0 whenever it
ran, and 2 when there's no `checkride.baseline.json`, the file can't be
parsed, `--config` names a file outside the repo, which could run fewer checks
and prune keys the repo's run still reports, or it's given a stray argument.

**`recover` rebuilds the baseline from git history and never mutates git
state.** `checkride recover` takes `--pick <n|sha|union>`, `--exact`,
`--dry-run`, `--depth <n>`, and `--json`. Without `--pick` it is a reader: a
Markdown listing of candidate states reconstructed from the baseline file's
recent commits, on stdout, exit 0 (`--json` for the machine shape). With
`--pick` it writes `checkride.baseline.json` atomically — the union of the
candidate and the current file by default (nothing removed; the ratchet prunes
stale resurrections on the next full green run), the snapshot verbatim under
`--exact` — as an ordinary working-tree edit: no `git checkout`, no index
writes, nothing committed on your behalf. Exit codes are 0 (listed or applied)
and 2 (usage or environment error — git missing, not a repository, unknown
pick); never 1, because nothing here is a check failure.

**`hooks` manages hooks and touches nothing else.** `checkride hooks add [a,b]`
and `checkride hooks remove <a,b>` write or tear out the harness config entries
and generated scripts for the named hooks, taking `--harness <a,b>` and
`--dry-run`. They never read or write AGENTS.md — so no state of that file can
block them, and no run of them can change it. `add` defaults to every hook;
`remove` requires an explicit list, because a bare command that tore out the gate
would be the silent un-gating this tool exists to prevent. Both are idempotent.

**What a hook *is* belongs to the harness, not to checkride.** The three hook
names are promised; whether one lands as a config entry, a permission rule, or a
generated script is checkride's to choose per harness, and may change. Under
Claude Code, `protect` is `permissions.deny` rules and `dirty` is an inline
command, so the gate script is the only file generated there. What is promised
about the deny rules is the part a consumer builds on: checkride **appends** its
own and removes only those, so rules you add beside them survive every refresh.

**checkride owns the AGENTS.md stanza, and only the stanza.** Everything outside
the `checkride:begin`/`checkride:end` markers is yours and is never rewritten;
the marked region is checkride's and is refreshed in place. The begin marker
carries a hash of the body checkride generated, so the two stay distinguishable:
a run whose stanza no longer matches its hash refuses rather than overwrite it,
exits 2, and writes nothing at all, so a refused run leaves the repo as it found
it. `--force` overrides, on both `init` and `agent-setup`. Silently discarding a
repo's own additions is the failure this prevents; the exit code and the "writes
nothing" rule are the promise.

A stanza written before the hash existed is checked against the wordings
checkride actually released: one that matches is its own output and refreshes
normally, and only one that matches nothing is treated as edited. The guard is
for repos that customized their stanza, not for every repo that upgraded.

**Your CLAUDE.md gains one line, `@AGENTS.md`, and nothing else.** Claude
Code reads AGENTS.md on its own only while a repo has no CLAUDE.md, so once
one exists the stanza reaches Claude Code only through that import. `init`
and `agent-setup` write a CLAUDE.md that imports AGENTS.md when there is
none. They leave a CLAUDE.md alone when it already imports AGENTS.md (outside
code) or carries the stanza itself, and they never write through a symlink:
one to AGENTS.md already loads it, and one to anywhere else may not be the
repo's file. They
replace one that is exactly the pointer an earlier release wrote, which only
linked to AGENTS.md. Any other CLAUDE.md keeps every byte, and the import
goes on a line of its own at the end, in the file's own line endings. A
second run writes nothing, and a run the stanza guard refuses leaves CLAUDE.md
as it found it. `doctor` reports an `unchecked ts configs` row, which fails
nothing, when a ts target's `types` or `test` found no tool while configs for
it sit in the packages below, and the stanza `init` and `agent-setup` write
names them under `Not covered`. `doctor` reports an `agent instructions` row when a CLAUDE
file keeps the stanza from loading.

**`gate` is the one command outside the 0/1/2 split**, because it answers a
harness's hook protocol rather than checkride's own. Under `--harness claude` it
exits 2 while the pipeline is red (Claude Code blocks on 2 and ignores 1) and 0
when green. Under `--harness cursor` it **always exits 0** and carries the
verdict as `{"followup_message": …}` on stdout, because Cursor reads a non-zero
stop hook as a broken hook and lets the turn end.

**A launch that never happened is not a red.** A package manager can refuse to
start the check script and exit non-zero for it — pnpm answers an `engines.node`
mismatch with `ERR_PNPM_UNSUPPORTED_ENGINE` and exit 1, exactly as a failing test
does. A `check` script whose own shell finds no `checkride` to run, in a repo
that never installed one, fails the same way (`sh: checkride: command not
found`, a line of its own); the same line a recursive run prefixes with one of
its packages is not read as one, since another package's checks may have run.
`gate` reports either as **could not run**, naming the cause, and `triage`
reports it as `could-not-start` where the package manager exits 1, as pnpm does
for both. npm, yarn and bun exit 127 for the second, which `triage` reports as
off-contract, as it reports every exit outside checkride's 0/1/2. The promise is
what the two verdicts mean: a red says the check failed, and `.check/` describes
this run when the run wrote its summary; a could-not-run
says **nothing ran and no artifact was written**, so no `.check/` file describes
this turn and no code change will clear it.

**A could-not-run blocks only when blocking could lead to a fix.** Since 0.11.0
the verdict splits by who can clear it. A refusal the *repo* can fix — no `check`
script, no package.json — blocks exactly as a red does, because the agent holding
the edit tools can fix it. A refusal only the *environment* can fix — an
`engines` pin the hook's Node fails, a pnpm the repo's `packageManager` pin
doesn't name, a package manager corepack will not verify, a checkride that was
never installed, whose verdict names the install — **stands down**: `gate` exits 0 with no
`decision`, and says so. Two things are promised about that path and neither may
be weakened: it is never silent (Claude Code gets a `systemMessage`, Cursor a
single `followup_message`, both stating that nothing was verified — and both get
stderr as well), and it is never reported as green (`ran: true, green: false`).
Cursor's copy is rationed to one per conversation because that field submits a
new turn; the generated hook script exports `CHECKRIDE_GATE_RETRY` (`0` or `1`)
from the stop payload to say whether the one message has been spent, and
checkride sends it only on an explicit `0`. A hook script that exports neither
value gets stderr alone, which is what keeps an unrefreshed repo from looping.
Blocking on a cause the turn cannot reach does
not produce a fix; it re-asks the same agent every turn until someone removes the
gate, which is a worse outcome than a loud stand-down.

**The generated stop-hook scripts bound every could-not-run cause.** Claude
Code's Stop payload carries `stop_hook_active` and Cursor's a `loop_count`. The
generated gate reads whichever its harness sends, and on the second consecutive
could-not-run it stands down rather than blocking again — including for causes
this document does not enumerate. A **red** pipeline is never bounded this way:
that loop is the gate working.

**`gate.preflight` is the supported seam for wrapping the gate.** checkride owns
the generated hook scripts and overwrites them on every refresh, so a repo with
something to say before the gate needs somewhere that survives one. A
`"preflight"` under `gate` in checkride.config.json names a repo-relative script
the generated gate runs, from the repo root, *before* checkride is started —
which is what lets it answer for a repo where checkride itself cannot start.

What is promised is the exit-code reading, which is the gate's own: **0** runs
the gate, **2** blocks the turn, and any other status stands the gate down. Both
non-zero branches use the script's output as the message and never start
checkride. A configured path that does not exist **blocks**, so a typo cannot
silently disarm the gate. Because the path is re-read from config on every
`hooks add`/`agent-setup`, a bare refresh restores the wiring rather than
clobbering it — that is the whole reason this is a config key and not a flag. A
preflight narrows nothing, so it never puts narrowing words on a verdict.

**A gate profile narrows the gate, and the gate says so.** `checkride.config.json`
may carry a `gate` key (`only`, `skip`, `changed`) that applies to the stop-gate
run and nothing else; its flags are appended after the check script's own, so the
profile wins. A profile token no check answers to, or a config the gate can't
read, a malformed `gate` included, blocks the turn with a "could not run"
verdict naming the mistake, before anything spawns, rather than exiting 2,
which Cursor would read as a broken hook. The promise is the disclosure: while a profile is active, every
verdict the gate emits names the narrowing in its parenthetical — `only types,
lint`, `without test`, `affected-only` — so a narrowed green can never read as a
full green. That would be the vacuous pass this contract exists to prevent, so
the disclosure is part of the feature rather than a nicety. A profile that
narrows nothing (`"gate": {}`) is treated as no profile, and the verdict says
nothing.

**checkride aligns the check run to the repo's Node pin.** When the repo names an
exact interpreter (`.nvmrc` or `.node-version`), the running Node does not
satisfy it, and a matching one is installed under a known version-manager layout,
`gate` prepends that interpreter's `bin` to the check run's `PATH` and says so on
stderr. Agent harnesses run hooks in a non-login shell, so a hook otherwise gets
the machine's default Node rather than the contributor's. `engines.node` is a
*range* and never selects an interpreter — it is read only to explain a failure.
`CHECKRIDE_NODE_BIN` is promised: a directory to prepend verbatim, or `off` to
disable alignment. Nothing is ever downloaded and no version manager is invoked.

`gate` also writes its verdict to **stdout as a single-line JSON hook body**, in
the calling harness's schema, and that is where a *user-visible* report lives —
`systemMessage` under `--harness claude` (both green and red), the
`followup_message` under `--harness cursor` (red only, because that field
submits a turn). The exit code above is unchanged and remains the promise; the
body is additive, and a hook script that ignores stdout still gates correctly on
the code alone.

**A red verdict carries what failed, and names only what this run wrote.** The
gate always runs the check with `--digest`. When this run wrote a summary and a
digest, the agent's half of the body, `reason` under `--harness claude` and
`followup_message` under `--harness cursor`, carries the digest's text, held to
its 8,000-byte budget, below the instruction, which names `.check/digest.md` as
its copy, so the agent reads what failed without opening a file. A digest file
with no text counts as none. `systemMessage` stays the one-line verdict, and
the stderr line doesn't repeat the digest, which the check's own output above it
already printed. A red whose run wrote no digest points at `.check/summary.json`.
One whose run wrote no summary either, as a `check` script that fails before
checkride runs leaves it, points the agent at no `.check/` file, since each one
there is an earlier run's: it says the run wrote no summary, and to run the
check to see why. A file is this run's when its mtime is no more than a second
before the gate started, the slack a coarse filesystem clock needs.

One exception is promised alongside it: under `--harness claude`, `gate` reports
`ran: false` and exits 0 without running the pipeline when Cursor is executing
the repo's Claude Code hooks *and* a native Cursor gate is registered — Cursor
runs every matching hook source, and two gates for one turn is two pipelines in
one `.check/`. See [Cursor](./cursor.md#cursor-also-runs-your-claude-code-hooks).

`triage` and `qa` render a Markdown report on stdout and exit 0 whenever a
report was produced — the verdict is in the report, not the process status, so a
red repo never looks like a broken reader.

**Selection takes tokens, and is validated.** `--only`, `--skip` and
`--include`, and a gate profile's `gate.only` and `gate.skip`, name checks with
tokens:

| Token | Selects |
| --- | --- |
| `lint`, a slot | That slot in every target whose pack fills it, or the one check of that name in a repo with no targets. |
| `links`, a repo-scope slot | The repo-scope check. |
| `licenses`, a custom check | That custom check. |
| `api`, a target | Every check of that target a full run would run. |
| `api:lint` | One check. |

Naming a slot opts it in, so `--only format` runs `format` even though it's
opt-in. A target token names no slot, so `--only api` leaves `api`'s opt-in
slots out unless `--all` or an `--include` token lets them in. `--skip`
narrows `--only`, so `--only api --skip api:test` runs every check of `api`
but its tests, and a check both lists name sits out. A token that
selects no check is a **usage error (exit 2)**, not a silently empty selection,
and so is an empty list: the error names the bad token and every valid one. A
typo like `--only lints` must never quietly disable the gate. The gate checks
its profile's tokens before it spawns anything, so a bad one is a **could not
run** that names `gate.only` or `gate.skip` and the valid tokens. It blocks,
because the repo can fix it, and under `--harness cursor` it still exits 0. In
a repo without `targets`, no check has a target, so a target name or
`<target>:<slot>` is an unknown token there.

**A config's targets and packs are validated before anything runs.**
`checkride.config.json` takes `targets` (named targets, each a `lang` pack and
a `root` directory), `packs` (slot config for every target of one pack),
`requirePins` and `unclaimed` beside the keys it already took. A config that
breaks one of these rules exits 2 with `invalid checkride.config.json: <reason>`,
or the `--config` or `--defaults` path in place of the file name, naming the
target, pack or entry at fault, before any check runs or any artifact is
written:

- A target name is a lowercase letter and up to 31 more lowercase letters,
  digits and hyphens. It's never a slot's name, `schema` and `unclaimed`
  included, nor any custom check's, at the top level or in a target's or a
  pack's `checks`, so a selection token means one thing. Nor is it
  `doc-snippets`, the directory the `snippets` check keeps its scratch in.
- A root is an existing directory, given relative to the repo root, never
  absolute or through `..`. Two targets of one pack never share their roots,
  and never nest them, apart from terraform's, whose root modules nest;
  targets of different packs may do either.
- `include` and `exclude` belong only to a pack that checks a list of files
  (bash).
- Once targets are declared, a top-level entry for a target-scope slot is
  `false` or sets only `optIn`, `timeout`, `order` and `note`. An entry that
  picks a tool belongs under `packs.<pack>.checks` or a target's own `checks`,
  and the message names both.
- A preset that `extends` names never declares targets, and `targets` is never
  empty. A preset's top-level entry that picks a target-scope slot's tool,
  by an adapter's name or `{ use }`, lands in `packs.<pack>.checks` of the
  pack that has that adapter wherever it can't apply at the top level: when
  the repo declares targets, or when the pack its root marks has no such
  adapter. It reaches that pack's checks alone, below the preset's own pack
  block, so a fleet preset's `"lint": "oxlint"` neither breaks the rule above
  in a repo with targets nor switches a Go root's linter off. A pick the
  root's pack can run stays at the top level and deep-merges with the repo's
  own entry as before, and the repo's own entries keep the rule above.
- A `packs` key names a pack, and every adapter a `packs` block or a target
  names belongs to that pack. A repo-scope slot is configured only at the top
  level.
- `schemas` is an array of rules, and each rule's `schema` names a bundled
  `checkride:<id>` schema or a path relative to the repo root, never a URL or
  an absolute path, because a check never fetches.
- `skipExitCode` sits only on a `{ command }` entry, and a repo's config never
  sets `static`, which only a defaults file may.
- A defaults file declares no `targets`, and nor does anything it `extends`.
- `gate` holds only `only` and `skip`, each a list of check names, `changed`,
  a boolean, `preflight`, a path, and `note`.

A top-level key the config schema doesn't declare is no error, since nothing
reads it, but a run, `fix` and `doctor` each print a warning on stderr naming
the file that holds it, the repo's config, a preset it extends, or a
`--config` file, so a misspelled key such as `check` doesn't sit there
unnoticed while the run ignores it.

Seven packs ship, `ts`, `repo`, `bash`, `go`, `rust`, `python` and
`terraform`, which [Packs and pins](./packs.md) covers. A run checks each
declared target as the [summary section](#checksummaryjson) describes, and
reports the code no target checks through `unclaimed`. A `schemas` key is
accepted, and held to the rule above, but no run acts on it: the `schema` slot
that reads it waits for a later release, so a config may carry its rules ahead
of that slot. `requirePins` fails a check whose tool
resolves from `PATH` with no pin, apart from a toolchain's own executable,
such as `go`, `cargo`, `terraform` or `tofu`, whose version the project's own
files bound. A ts root without targets resolves every tool through its
package manager, so none of its checks reaches `PATH`. A config without
`targets` reads `packs` for the pack its root marks alone, below its top-level
`checks`, so a 0.14 config, which has no `packs`, resolves exactly as before.
[`config.test.ts`](../src/__tests__/config.test.ts) holds
each rule, its message and its exit code.

**Stream discipline:** stdout carries machine output only (the summary JSON
under `--json`; otherwise nothing). Human-readable progress and warnings go to
stderr. `checkride --json | jq .` is safe.

## Check ordering and concurrency

Every check has an effective `order` that fixes when it runs relative to the
others, resolved as the config entry's `order`, then the adapter default, then
the slot default, then `'any'`. The vocabulary and what each value promises:

| `order` | The promise |
| ------- | ----------- |
| a number | A **wave**. Distinct wave numbers run in ascending order with a barrier between them; checks that share a number are one group with no ordering promise among themselves. Integers are the conventional waves; a decimal sequences a step within a wave (`1` before `1.1` before `1.2`). |
| `'first'` | Before every other check. |
| `'last'` | After every other check, singles included. |
| `'single'` | Exclusive — runs with nothing else in flight, after the numeric line and before `'last'`, one single at a time. |
| `'middle'` | After every `'first'` and before every `'last'` — nothing more. |
| `'any'` | No ordering promise at all. The default when `order` is omitted. |

`order` is honored on every object-form config entry — a slot's `{ use, order }`
and a custom check alike. `'first'` and `'last'` keep exactly their historical
meaning (before / after every other check) and are pinned by a backward-compat
contract test.

Only the relationships above are promised. `'any'` and `'middle'` in particular
say nothing about *which* concurrent group they join; a release may schedule them
differently as long as the stated relationships hold.

For a worked before/after showing what this surface buys on a real repo, see
[Ordering waves in practice](./ordering-in-practice.md).

**Concurrency.** Checks that share a wave run concurrently through a bounded
pool. `--concurrency <n>` sets the pool size — `1` is fully sequential, and the
default is a conservative cap derived from the CPU count. `--bail` overrides it:
the run goes fully sequential and stops at the first failure, and a one-line
stderr note reports that `--concurrency` was ignored (the combination is safe,
just slower — not a usage error). Concurrency never weakens the
[timeout and interrupt](#timeouts-and-interrupts) promises: every
concurrently running check keeps its own timeout and has its whole process group
reaped independently.

**Locks.** An adapter row may name a `lock` key (the exported `Adapter`
type's `lock`; a config entry has none). Two checks whose keys are equal never
run at the same time, even in one wave. `{root}` in a key expands to the
check's target root, `.` for the repo root, so `cargo:{root}` keeps one
target's cargo checks apart while another target's run beside them, and a key
without `{root}` holds across every target. A check held back by its key isn't
started: the pool runs what it can meanwhile, and the check's timeout and
`duration_ms` begin only once it starts. A lock holds a check back only while
another check holding its key runs, so under `--concurrency 1` or `--bail` it
changes nothing.

## Programmatic surface

Everything exported from the package root (`import ... from 'checkride'`) is
public and semver-bound:

`runChecks`, `runFix`, `selectChecks`, `runDoctor`, `runInit`, `loadConfig`,
`resolveChecks`, `ADAPTERS`, `SLOTS`, `PACKS`, `TOOLS`, `SCHEMA_VERSION`,
`DEFAULT_TIMEOUT_SECONDS` — plus the exported types (`Summary`,
`SummaryCheck`, `RunFlags`, `RunOptions`, `RunResult`, `CheckrideConfig`,
`CustomCheck`, `SlotConfig`, `UseConfig`, `ResolvedCheck`, `Adapter`,
`CodeKey`, `Slot`, `Pack`, `Tool`, `DoctorCheck`, `DoctorReport`, `DoctorResult`, `InitOptions`,
`InitResult`, `ProbeFailure`, `Shape`).

The four registry exports are plain data, and each survives a JSON round trip
unchanged. `PACKS` maps each pack's name (`ts`, `repo`, `bash`, `go`, `rust`,
`python`, `terraform`) to its adapter rows, root markers, pin sources and
environment, and the go pack's to the toolchain its checks run on, `go`, as
`toolchain`. `ADAPTERS` is the `ts` and
`repo` packs' rows, grouped by slot in `SLOTS` order. `TOOLS` has one row for
each external tool the packs run as a tool, with the npm package that
provides it or the `mise.toml` keys that pin it. The executables a toolchain
ships, which an adapter runs directly, such as `go`, `gofmt`, `cargo`,
`terraform` and `tofu`, have no row there: each resolves through its
toolchain's own pin. Each
`SLOTS` entry carries a `scope`: `repo` for the slots the repo pack fills,
which check the repo as a whole, and `target` for the rest, which a language
pack fills. The last, `unclaimed`, also carries `activeWith: 'targets'`, the
config key it needs before it runs.
[`exports.contract.test.ts`](../test/contract/exports.contract.test.ts) holds
each of these promises.

An adapter row's optional fields say how its pack runs it, and a row sets only
the ones it needs:

- `detectPin` and `detectTable` detect a tool by a pin that declares it, or by
  a TOML table that configures it, such as `[tool.ruff]` in `pyproject.toml`.
- `onlyWith` names a file the adapter applies only beside, and the reason its
  slot stands down without it; `setup` names a directory a setup step writes,
  so the check fails naming that step where it's missing.
- `failOnOutput` fails a check whose tool exits 0 having printed to stdout,
  `narrowsUnderChanged` lets `--changed` narrow a Go check's packages,
  `network` runs it without the variables that block downloads, and `lock`
  keeps two checks with the same key from running at once.
- `static`, `nonStaticArgs`, `codeArgs`, `codeConfigs`, `codeKeys` (each a
  `CodeKey`) and `configSearchesUp` are what `--static-only` reads, and a
  resolved adapter's `staticDrop` says what a config entry did to take the
  `static` mark. A `CodeKey`'s `under` names the JSON property its config
  sits in, as `package.json`'s `prettier`, and `shared` marks a file that
  may hold a shared config's module name instead.

A `TOOLS` row's optional fields say where a tool comes from: `npm`, `goTool`
and `pypi` name the npm package, the Go package a `go.mod` `tool` directive
names, and the PyPI package; `mise` the `[tools]` keys that pin it; `run` the
argv it runs as when it isn't its own executable, such as `cargo clippy`; and
`component` the rustup component that provides it.

**`checkride/findings` reads a run's findings without reimplementing its
parsers.** The subpath is public and semver-bound as well, and exports
`parseFindings`, `findingsFor` and `isParseable`, with the types `Finding`,
`ParseOptions` and `FindingsCheck`:

- `parseFindings(adapter, raw, options?)` parses one adapter's raw output.
  `options` names the check's `slot`, its `root` (the summary's `cwd`, `''`
  for the repo root), the absolute `repoRoot`, and the `argv` that ran.
- `findingsFor(check, runDir, { repoRoot })` takes a `summary.json` check
  entry and the output directory its run wrote, and opens that check's own
  artifact: the `output_file` the entry names, else the `<slot>.stdout.txt` or
  `<slot>.stderr.txt` its parser reads, under `<target>/` for a target's
  check. The entry's `cwd`, `argv` and slot decide the rest.
- `isParseable(adapter)` says whether an adapter has a parser: `oxlint`,
  `eslint`, `biome`, `ast-grep`, `cspell`, `vale`, `fallow`,
  `golangci-lint`, `staticcheck`, `clippy`, `cargo-check`, `shellcheck`,
  `markdownlint-cli2`, `rumdl`, `typos`, `tsc`, `go-build`, `ruff`, `mypy`,
  `basedpyright`, `tflint`, `terraform-validate` and `trivy-config` today.
  The set only grows. A custom check whose `name` is one of these is read by
  that adapter's parser.

Each `Finding` carries `adapter`; `slot`, the check's, or for `fallow` the one
its report names (`dead`, `dupes` or `health`); `file`, named from the repo
root with forward slashes; `line` and `column`, 1-based, when the tool reports
them; `rule`, `''` when the tool names none; `message`; `severity`, the tool's
own level string, verbatim, and for eslint, whose report gives a number, the
word its formatters print for it, `error` or `warning`; and `gates`, whether the finding can fail the
check under the argv that ran, or under the adapter's registry args when no
argv is known, absent when that can't be told, as for a basedpyright warning
without `--warnings`, which fails the run only where its config sets
`failOnWarnings`, or a trivy finding whose argv runs trivy through a wrapper.
A trivy finding gates only under a nonzero `--exit-code`, and then when
`--severity` lists its level or is absent. A path a tool printed relative
to a target's root joins that root, and an absolute path inside `repoRoot` is
made relative to it; one outside stays absolute. A nested module's path that
tflint names through a symlinked working directory, climbing to `/` and back
down its real path, names its file from `repoRoot` when the file lies inside
it. A terraform validate diagnostic about the whole configuration, such as a
provider `init` never installed, names no file.

`null` means the adapter has no parser, the check was skipped, its artifact
can't be read, or its output can't be trusted (vale's runtime-error report, a
fallow report checkride can't read, a golangci-lint or shellcheck report with
no findings list, an oxlint report with no `diagnostics` list, an ast-grep,
rumdl or ruff report that isn't an array, an eslint report that isn't an array
of results or holds a message it can't read, a biome report with no
`diagnostics` list, one holding a diagnostic it can't read, or one whose errors
and warnings aren't the counts its `summary` gives, a basedpyright
report with no `generalDiagnostics` list, a tflint report with no `issues`
list or with an entry in `errors`, a terraform validate report with no
`diagnostics` list, trivy output that isn't its report object, markdownlint-cli2
stderr that holds text but no finding, a cargo build that never printed
`build-finished`). An empty array means parsed and clean. A tsc run that
stopped short of some errors, which the baseline neither masks nor prunes
with, still parses into every finding it printed.
The API is best-effort: it never writes under the output directory and never
decides a verdict, so the raw artifact stays authoritative and the check's
`ok` is still the verdict.

<!-- snippet: check -->
```ts
import { readFile } from 'node:fs/promises';
import type { Summary } from 'checkride';
import { findingsFor, type Finding } from 'checkride/findings';

const runDir = '.check';
const summary = JSON.parse(await readFile(`${runDir}/summary.json`, 'utf8')) as Summary;
const gating: Finding[] = summary.checks
  .flatMap((check) => findingsFor(check, runDir, { repoRoot: process.cwd() }) ?? [])
  .filter((finding) => finding.gates === true);
```

Everything not exported from the package root or `checkride/findings` —
internal modules, file layouts, private helpers — is not public API, even if
technically importable.

## Timeouts and interrupts

- Every check runs under a timeout by **default**: the check's own `timeout`,
  else the config-level `timeout`, else `DEFAULT_TIMEOUT_SECONDS` (600). `0`
  at any level disables the cap. A definition-of-done gate must not be able
  to hang forever. One catalogue slot exercises the check-level clause:
  `mutation`, whose stryker and cargo-mutants adapters ship `timeout: 0`, so
  mutation runs uncapped out of the box. It is opt-in and never in the gate
  the cap protects, and only a per-check `timeout` caps it.
- A timed-out check is killed (SIGTERM, then SIGKILL after a short grace) and
  recorded as **failed** with a `timed out after <n>s` note — red, never
  vacuous, never hung.
- An interrupted run (SIGKILL, power loss) never tears an artifact (see
  crash-consistency above) and never prunes the baseline — the ratchet only
  runs on a fully observed run. Within one, a check that timed out, was
  refused, or failed with nothing its parser could read observes nothing, so
  it prunes none of its keys either, and neither does a check that ran another
  copy of its tool than its keys were captured with
  ([`checkride.baseline.json`](#checkridebaselinejson)).

These promises live with their machinery rather than in `test/contract/`: the
timeout kill and grandchild reaping in
[`src/orchestrator/__tests__/orchestrator.test.ts`](../src/orchestrator/__tests__/orchestrator.test.ts),
crash consistency in
[`src/__tests__/atomic.test.ts`](../src/__tests__/atomic.test.ts), and the
ratchet's preserve-the-unobserved rule in
[`src/__tests__/baseline.test.ts`](../src/__tests__/baseline.test.ts). The
same discipline applies: a change that breaks one of those tests is a contract
change, never a quiet test edit.

## Versioning and pin policy

checkride follows semver. Pre-1.0, minor versions may break (the semver 0.x
rule) — **consumers should pin exactly** (`"checkride": "0.15.0"`, no caret,
or the same exact version on a `mise.toml`'s `npm:checkride` entry) and
upgrade deliberately. Post-1.0, a caret range is the intended usage.

Any change touching a surface in this document must name itself in
`CHANGELOG.md` under a **Contract** heading in that release's notes — a reader
scanning release notes must be able to find every contract-relevant change
without reading diffs.
