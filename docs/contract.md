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
(0.3.0). Optional per-check fields (`skipped`, `reason`, `baselined`) are
present only when meaningful — absence is part of the shape.

**Array order is deterministic.** The `checks` array is ordered by the run's
group sequence — `'first'`s, then each numeric wave ascending, then `'single'`s,
then `'last'`s; within a group by catalogue position, then config-key order —
independent of the order the checks actually *finish*. The same selection
produces the same array order on every run, even when concurrency interleaves
completion. `total_duration_ms` is the **wall-clock** duration of the whole run;
when execution is sequential (including any `--bail` run) it equals the sum of
the per-check durations, exactly as before.

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

## CLI

The command set — `checkride` (run), `init`, `doctor`, `fix`, `baseline`,
`agent-setup`, `hooks`, `gate`, `triage`, `qa` — and the run flags:

```text
--only <a,b>  --skip <a,b>  --include <a,b>  --all  --changed
--bail  --json  --digest  --strict  --concurrency <n>
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
stop hook as a broken hook and lets the turn end. A `gate` that could not run at
all still blocks, in both harnesses: a gate that silently stops gating is the
vacuous green this contract exists to prevent.

**A launch that never happened is not a red.** A package manager can refuse to
start the check script and exit non-zero for it — pnpm answers an `engines.node`
mismatch with `ERR_PNPM_UNSUPPORTED_ENGINE` and exit 1, exactly as a failing test
does. `gate` reports that as **could not run**, naming the cause, and `triage`
reports it as `could-not-start`. The promise is what the two verdicts mean: a red
says checks ran and some failed, and `.check/` describes this run; a could-not-run
says **nothing ran and no artifact was written**, so no `.check/` file describes
this turn and no code change will clear it. The exit codes do not change — it
blocks either way — so a hook script that reads only the status is unaffected.

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
`--include` is a **usage error (exit 2)**, not a silently-empty selection — the
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
concurrently-running check keeps its own timeout and has its whole process group
reaped independently.

## Programmatic surface

Everything exported from the package root (`import ... from 'checkride'`) is
public and semver-bound:

`runChecks`, `runFix`, `selectChecks`, `runDoctor`, `runInit`, `loadConfig`,
`resolveChecks`, `ADAPTERS`, `SLOTS`, `SCHEMA_VERSION`,
`DEFAULT_TIMEOUT_SECONDS` — plus the exported types (`Summary`,
`SummaryCheck`, `RunFlags`, `RunOptions`, `RunResult`, `CheckrideConfig`,
`CustomCheck`, `SlotConfig`, `UseConfig`, `ResolvedCheck`, `Adapter`, `Slot`,
`DoctorCheck`, `DoctorReport`, `DoctorResult`, `InitOptions`, `InitResult`,
`Shape`).

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
  runs on a fully-observed run.

These promises live with their machinery rather than in `test/contract/`: the
timeout kill and grandchild reaping in
[`src/__tests__/orchestrator.test.ts`](../src/__tests__/orchestrator.test.ts),
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
