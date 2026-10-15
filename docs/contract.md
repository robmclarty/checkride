# The checkride contract

This document names the surfaces a consumer may **rely on** — the promises, as
opposed to today's incidental behavior. Every surface listed here is backed by
a test that fails the build if it drifts — most in
[`test/contract/`](../test/contract/); the timeout and crash-consistency
promises are exercised where the machinery lives, in the suites named in
[their section](#timeouts-and-interrupts) below. Anything *not* listed here is
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
  directory they generate files in, `<repo>/.check/`, can't be written, as in
  a read-only checkout that `--out` sent the artifacts away from. Their
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
(0.3.0), per-check `origin`, `detected_by` and `argv`, and top-level `run` and
`git` (0.15.0).

The tables below name every field the schema allows, each with the rule for
when it's present. A field whose rule isn't "always" is left out otherwise,
never written as `null` or `false`, so absence is part of the shape. Inside
`run`, `git` and `git.base`, "always" means whenever that object is present.
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
| `checks` | array of per-check entries | always: one per selected check, skipped ones included, plus a skipped entry for each check `--only` or `--skip` left out, in the order below |

**`run` fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `partial` | boolean | always: true when `--only`, `--skip` or `--changed` narrowed the run, or `--bail` stopped it at a failure |
| `only` | array of strings | `--only` was given: the names it listed |
| `skip` | array of strings | `--skip` was given: the names it listed |
| `include` | array of strings | `--include` was given: the names it listed |
| `all` | `true` | `--all` was given |
| `changed` | `true` | `--changed` was given |
| `static_only` | `true` | `--static-only` was given; checkride has no such flag yet |
| `discover` | `true` | `--discover` was given; checkride has no such flag yet |
| `config` | string, an absolute path | `--config` or `CHECKRIDE_CONFIG` named the config file |
| `defaults` | string, an absolute path | `--defaults` or `CHECKRIDE_DEFAULTS` was given; checkride has no such flag yet |
| `pins` | string, an absolute path | `--pins` or `CHECKRIDE_PINS` was given; checkride has no such flag yet |
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

**Per-check fields.**

| Field | Type | Present when |
| --- | --- | --- |
| `name` | string | always: the slot name (`lint`), or the custom check's config key |
| `adapter` | string or `null` | always: the adapter that ran or would have run (`oxlint`, or `custom:<key>` for a custom check with no `name`); `null` when the slot resolved to nothing |
| `description` | string | always: the adapter's description, or the slot name when the slot resolved to nothing |
| `ok` | boolean | always: pass or fail after baseline masking; `true` for a skipped check |
| `skipped` | `true` | the check didn't execute |
| `reason` | string | with `skipped`: why the check sat out |
| `exit_code` | integer or `null` | always: the tool's exit code, `-1` when it failed to spawn or timed out, `null` when skipped |
| `duration_ms` | number | always: wall-clock milliseconds, `0` when skipped |
| `output_file` | string or `null` | always: the JSON file the run wrote in the output directory (`.check/` unless `--out` named another), relative to it, or `null` when it wrote none |
| `origin` | `config`, `detected`, `built-in` or `custom` | `adapter` isn't `null`: why the check is in the run |
| `detected_by` | string | `origin` is `detected`: the matched detect file, `package.json: <dep>` or `package.json: scripts.<name>` |
| `argv` | array of strings, the command first | the check spawned its own tool: the command and arguments exactly as spawned, after package-manager translation |
| `baselined` | integer, 1 or more | a committed baseline masked at least one of the check's findings: how many |

**Every check says why it's in the run.** `origin` is `config` when
`checkride.config.json` names the slot, presets it `extends` included, since
the two can't be told apart once folded. It's `detected` when no entry named
the slot and a detection signal chose the adapter, `built-in` when detection
chose an adapter that needs no signal (`links`, for one), and `custom` for a
custom check keyed by a name outside the catalogue. A check that sat out
keeps the `origin` of the adapter that would have run, so a slot `--only` left
out, or a custom check that skipped itself, still says why it was selected.
The status line each executed check prints on stderr ends with the same fact
as a tag: `[config]`, `[detected: <detected_by>]`, `[built-in]` or `[custom]`,
and `checkride doctor` ends its slot rows the same way.

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

**Array order is deterministic.** The `checks` array is ordered by the run's
group sequence — `'first'`s, then each numeric wave ascending, then `'single'`s,
then `'last'`s; within a group by catalogue position, then config-key order —
independent of the order the checks actually *finish*. The same selection
produces the same array order on every run, even when concurrency interleaves
completion. `total_duration_ms` is the **wall-clock** duration of the whole run;
when execution is sequential (including any `--bail` run) it equals the sum of
the per-check durations, exactly as before, unless the run waited on git as
described above.

**Raw output stays authoritative.** The per-tool files beside the summary —
`.check/<slot>.json` when the tool emits JSON, `<slot>.stdout.txt` /
`<slot>.stderr.txt` otherwise — are the tool's own bytes, never normalized,
reshaped, or filtered. The summary is an index; the raw file is the truth.
This is the product's thesis and will not change.

The one thing dropped is output that is not the tool's. A launcher can print to
stdout before the tool does — pnpm narrates its dependency check there ahead of
`exec`/`run` — so a `<slot>.json` is written from the first character of the
JSON onward, discarding at most ten leading non-JSON lines. Nothing *inside* the
tool's output is touched, and a slot whose output never parses as JSON keeps
every byte in `<slot>.stdout.txt` instead.

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
  }
}
```

**The same additive-only discipline as the summary.** Under schema version 1
the file has two top-level fields and no others: `schema_version`, the integer
`1`, and `slots`, an object from slot name to an array of key strings. A slot
whose adapter can be fingerprinted and had nothing to grandfather is present
with an empty array; a slot whose adapter has no extractor is absent. Fields
are added in lockstep with the published schema, never renamed, removed, or
retyped; a non-additive change bumps `schema_version` and is a breaking
release. The schema describes what checkride **writes**. What it accepts on
read is wider — see the tolerance promise below.

**A key names a finding by what it is, not where it sits.** Every key is a
string the slot's extractor built; a consumer may compare keys, count them, and
diff them, never parse them. For the four diagnostic extractors — oxlint
(`lint`), ast-grep (`struct`), cspell (`spell`), vale (`prose`) — the key is
`<file>:<rule>:<message>`: the message whitespace-collapsed, the rule empty for
cspell (`<file>::<message>`). Only a finding that can fail the slot is keyed:
vale's error-severity alerts, and oxlint's and ast-grep's error-severity
findings, unless the check's argv lets a warning fail too (oxlint's
`--deny-warnings` or `--max-warnings`, ast-grep's `--error`, or an argv that
runs the tool through a wrapper and so hides its flags), in which case every
finding is keyed. Line and column are never part of these keys, so a
finding keeps its key when unrelated edits move it — the property the ratchet
and the merge story stand on. fallow's three slots (`dead`, `dupes`, `health`)
key on category and symbol instead, in the forms the extractor documents, and
add a position only for a finding with no symbol to name.

**The message inside a key belongs to the tool.** A key carries the tool's own
wording. A tool upgrade that rewords a message, renames a rule, or restructures
its report re-keys those findings, and they report as new until
`checkride baseline` recaptures them; a change to one of checkride's own
extractors does the same (0.6.0 and 0.9.4 were two), and the release notes say
so under that release. What is promised is the notice, never the wording.

**Written canonical, written atomically.** Every writer — `checkride baseline`
(including `init --baseline`), the ratchet, `recover --pick` — writes one shape:
slot names sorted, keys within each slot sorted and unique, two-space
indentation, a trailing newline, through the temp-file-then-rename write of the
crash-consistency promise above. Two branches that grandfather the same debt
produce byte-identical files, and a write that would change nothing is skipped.
A hunk in `git diff` of this file is a change to the debt set, never to its
formatting.

**Read is tolerant, and fails closed on the future.** A malformed baseline
never breaks a run. A file that does not parse, or whose `slots` is not an
object, masks nothing, and the run says so on stderr; `doctor` flags the same
file between runs. Inside a file that does parse, an unknown top-level field is
ignored, a slot whose value is not an array is dropped, a non-string key is
dropped, and a missing `schema_version` reads as `1`. A `schema_version` above
the one this release writes is dropped whole: the run reports every finding
that is there rather than guess which ones a newer file meant to mask. The
reader takes text, not a path, so a historical copy from `git show` parses
under the same rules — which is what `recover` is built on.

**Who writes to it.** Keys are added only by `checkride baseline` and
`recover --pick`; a normal run only removes them, and only on a fully observed
run — the ratchet rule in [Timeouts and interrupts](#timeouts-and-interrupts).
`recover`'s own promises are in [CLI](#cli). The generated `protect` hook denies
an agent's edits to the file, so a change to it arrives as a reviewed diff.

## CLI

The command set — `checkride` (run), `init`, `doctor`, `fix`, `baseline`,
`recover`, `agent-setup`, `hooks`, `gate`, `triage`, `qa` — and the run flags:

```text
--only <a,b>  --skip <a,b>  --include <a,b>  --all  --changed  --base <ref>
--bail  --json  --digest  --strict  --concurrency <n>  --config <path>
--out <dir>
```

are promised. New commands and flags are additive; removing or repurposing one
is a breaking change. `init` and `agent-setup` additionally promise
`--hook <a,b>` (select which hooks to write: `gate`, `dirty`, `protect`; an
unknown name is a usage error naming the valid set), `--no-hook` (write none),
`--remove-hook <a,b>` (tear installed ones back out — the config entry and the
generated script; same usage-error rule, and naming one hook in both `--hook`
and `--remove-hook` is a usage error), and `--harness <a,b>` (which harnesses to
write them for: `claude`, `cursor`; same usage-error rule). Omitting `--harness`
selects `claude` plus any harness the repo shows evidence of.

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

**`--changed` measures from one base ref.** It resolves from `--base <ref>`,
then `CHECKRIDE_BASE` (an empty variable counts as unset), then the config's
`changedBase`, then `origin/main` when it names a commit, then `HEAD`. A check's
`changedArgs` say `{base}` where they need it: vitest runs `--changed {base}` and
jest `--changedSince {base}`, so with nothing named and `origin/main` present the
argv is the one 0.13 spawned. A base that `--base`, the variable or the config
names and that doesn't name a commit exits 2 before anything runs, because
narrowing from some other base would check a different change. A defaulted
`origin/main` that doesn't resolve, as in a clone without that remote, falls
back to `HEAD` with a warning on stderr. Outside `--changed` the base is never
resolved, and `gate` strips `CHECKRIDE_BASE` from the check it spawns, as it does
`CHECKRIDE_CONFIG`.

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
variable, so 0.13's argv holds, and the absolute path when one names it.
Scratch isn't output. `snippets` and `smoke` generate files that have to
resolve the repo's own modules, so they write under `<repo>/.check/` whatever
`--out` says, and skip when it can't be written. A run whose directory sits
outside the repo never ratchets and never writes `checkride.baseline.json`,
like a `--config` outside it, while `baseline --out` still writes the file at
the repo root. `gate` strips `CHECKRIDE_OUT` from the check it spawns and reads
`<repo>/.check/`, and the hooks never pass it. Separate `--out` values keep two
runs' artifacts apart; they don't keep the tools apart, since build info, test
caches and `.fallow/` are shared, so concurrent runs that write those belong in
separate worktrees.

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
  "removed_count": 1
}
```

`ref` is the ref as given, `sha` the full sha it resolved to, and `added` and
`removed` map each check that changed to its sorted keys, leaving out checks
that didn't. Fields are added, never renamed or removed. It exits 0 whenever
it ran, keys added or not, because the diff is evidence rather than a verdict,
and 2 when the ref names no commit, git is missing, or either copy can't be
parsed (a file from a newer checkride included). `--config` belongs to the
capture: `baseline diff` rejects it, and `baseline` rejects a stray argument,
so a misplaced `diff` never rewrites the file.

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

**`gate` is the one command outside the 0/1/2 split**, because it answers a
harness's hook protocol rather than checkride's own. Under `--harness claude` it
exits 2 while the pipeline is red (Claude Code blocks on 2 and ignores 1) and 0
when green. Under `--harness cursor` it **always exits 0** and carries the
verdict as `{"followup_message": …}` on stdout, because Cursor reads a non-zero
stop hook as a broken hook and lets the turn end.

**A launch that never happened is not a red.** A package manager can refuse to
start the check script and exit non-zero for it — pnpm answers an `engines.node`
mismatch with `ERR_PNPM_UNSUPPORTED_ENGINE` and exit 1, exactly as a failing test
does. `gate` reports that as **could not run**, naming the cause, and `triage`
reports it as `could-not-start`. The promise is what the two verdicts mean: a red
says checks ran and some failed, and `.check/` describes this run; a could-not-run
says **nothing ran and no artifact was written**, so no `.check/` file describes
this turn and no code change will clear it.

**A could-not-run blocks only when blocking could lead to a fix.** Since 0.11.0
the verdict splits by who can clear it. A refusal the *repo* can fix — no `check`
script, no package.json — blocks exactly as a red does, because the agent holding
the edit tools can fix it. A refusal only the *environment* can fix — an
`engines` pin the hook's Node fails, a package manager corepack will not verify,
a checkride that was never installed — **stands down**: `gate` exits 0 with no
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
profile wins. The promise is the disclosure: while a profile is active, every
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

One exception is promised alongside it: under `--harness claude`, `gate` reports
`ran: false` and exits 0 without running the pipeline when Cursor is executing
the repo's Claude Code hooks *and* a native Cursor gate is registered — Cursor
runs every matching hook source, and two gates for one turn is two pipelines in
one `.check/`. See [Cursor](./cursor.md#cursor-also-runs-your-claude-code-hooks).

`triage` and `qa` render a Markdown report on stdout and exit 0 whenever a
report was produced — the verdict is in the report, not the process status, so a
red repo never looks like a broken reader.

**Selection is validated.** An unknown slot name in `--only`, `--skip`, or
`--include` is a **usage error (exit 2)**, not a silently empty selection — the
error names the bad slot and the valid set (the catalogue slots plus any config
custom-check names). A typo like `--only lints` must never quietly disable the
gate.

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

## Programmatic surface

Everything exported from the package root (`import ... from 'checkride'`) is
public and semver-bound:

`runChecks`, `runFix`, `selectChecks`, `runDoctor`, `runInit`, `loadConfig`,
`resolveChecks`, `ADAPTERS`, `SLOTS`, `PACKS`, `TOOLS`, `SCHEMA_VERSION`,
`DEFAULT_TIMEOUT_SECONDS` — plus the exported types (`Summary`,
`SummaryCheck`, `RunFlags`, `RunOptions`, `RunResult`, `CheckrideConfig`,
`CustomCheck`, `SlotConfig`, `UseConfig`, `ResolvedCheck`, `Adapter`, `Slot`,
`Pack`, `Tool`, `DoctorCheck`, `DoctorReport`, `DoctorResult`, `InitOptions`,
`InitResult`, `Shape`).

The four registry exports are plain data, and each survives a JSON round trip
unchanged. `PACKS` maps each pack's name (`ts`, `repo`) to its adapter rows,
root markers, pin sources and environment. `ADAPTERS` is the `ts` and `repo`
packs' rows, grouped by slot in `SLOTS` order. `TOOLS` has one row for each
external tool those rows run, with the npm package that provides it. Each
`SLOTS` entry carries a `scope`: `repo` for the slots the repo pack fills,
which check the repo as a whole, and `target` for the rest, which a language
pack fills.
[`exports.contract.test.ts`](../test/contract/exports.contract.test.ts) holds
each of these promises.

Everything not exported there — internal modules, file layouts, private
helpers — is not public API, even if technically importable.

## Timeouts and interrupts

- Every check runs under a timeout by **default**: the check's own `timeout`,
  else the config-level `timeout`, else `DEFAULT_TIMEOUT_SECONDS` (600). `0`
  at any level disables the cap. A definition-of-done gate must not be able
  to hang forever. One catalogue default exercises the check-level clause: the
  `mutation` slot's stryker adapter ships `timeout: 0`, so mutation runs uncapped
  out of the box — it is opt-in and never in the gate the cap protects.
- A timed-out check is killed (SIGTERM, then SIGKILL after a short grace) and
  recorded as **failed** with a `timed out after <n>s` note — red, never
  vacuous, never hung.
- An interrupted run (SIGKILL, power loss) never tears an artifact (see
  crash-consistency above) and never prunes the baseline — the ratchet only
  runs on a fully observed run.

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
rule) — **consumers should pin exactly** (`"checkride": "0.3.0"`, no caret)
and upgrade deliberately. Post-1.0, a caret range is the intended usage.

Any change touching a surface in this document must name itself in
`CHANGELOG.md` under a **Contract** heading in that release's notes — a reader
scanning release notes must be able to find every contract-relevant change
without reading diffs.
