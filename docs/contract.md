# The checkride contract

This document names the surfaces a consumer may **rely on** — the promises, as
opposed to today's incidental behavior. Everything listed here is backed by a
test in [`test/contract/`](../test/contract/) that fails the build if it
drifts. Anything *not* listed here is internal by definition and may change in
any release.

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

**Raw output stays authoritative.** The per-tool files beside the summary —
`.check/<slot>.json` when the tool emits JSON, `<slot>.stdout.txt` /
`<slot>.stderr.txt` otherwise — are the tool's own bytes, never normalized,
reshaped, or filtered. The summary is an index; the raw file is the truth.
This is the product's thesis and will not change.

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
`agent-setup` — and the run flags:

```text
--only <a,b>  --skip <a,b>  --include <a,b>  --all  --changed
--bail  --json  --digest  --strict
```

are promised. New commands and flags are additive; removing or repurposing one
is a breaking change.

**Stream discipline:** stdout carries machine output only (the summary JSON
under `--json`; otherwise nothing). Human-readable progress and warnings go to
stderr. `checkride --json | jq .` is safe.

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
  at either level disables the cap. A definition-of-done gate must not be able
  to hang forever.
- A timed-out check is killed (SIGTERM, then SIGKILL after a short grace) and
  recorded as **failed** with a `timed out after <n>s` note — red, never
  vacuous, never hung.
- An interrupted run (SIGKILL, power loss) never tears an artifact (see
  crash-consistency above) and never prunes the baseline — the ratchet only
  runs on a fully-observed run.

## Versioning and pin policy

checkride follows semver. Pre-1.0, minor versions may break (the semver 0.x
rule) — **consumers should pin exactly** (`"checkride": "0.3.0"`, no caret)
and upgrade deliberately. Post-1.0, a caret range is the intended usage.

Any change touching a surface in this document must name itself in
`CHANGELOG.md` under a **Contract** heading in that release's notes — a reader
scanning release notes must be able to find every contract-relevant change
without reading diffs.
