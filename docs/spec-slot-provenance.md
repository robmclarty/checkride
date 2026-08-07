<!-- markdownlint-configure-file { "MD024": { "siblings_only": true } } -->
<!-- Feature 1 and Feature 2 each carry a parallel `### Behavior` / `### Non-goals`;
     siblings_only still catches a true duplicate under the same parent. -->

# Spec: slot provenance — say *why* each check runs

**Status:** draft (not yet built)
**Motivation:** a real adopter surprise, observed 2026-07-10 in volley: its
`checkride.config.json` names three slots (`test`, `spell: false`, `docs: false`),
yet a run executes eight. The other five arrive via zero-config detection
(`sgconfig.yml` → `struct`, `fallow.toml` → `dead`, …), which is deterministic
and consented-to — you wrote those files — but the *causality is invisible at
the moment of surprise*. The mapping lives only in the README's slot/adapter
table. `doctor` can answer "what will run?", but nobody runs doctor because
they weren't surprised yet.

Two features close the gap at the two moments it matters: **at run time**
(feature 1) and **at adoption time** (feature 2). Neither weakens the
zero-config thesis: detection still works with no config file at all; these
make its outcome visible and its result pinnable.

## Feature 1 — provenance in the run output

### Behavior

Every rendered slot line and every `summary.json` entry states how the slot
came to run (or not run):

```text
  ✔ types      1738ms  TypeScript type checking …          [config]
  ✔ struct      547ms  Structural rules (ast-grep)         [detected: sgconfig.yml]
  ✔ links        13ms  Relative markdown link targets …    [built-in]
  ✔ licenses     90ms  License audit                       [custom]
  ○ spell         skip  disabled in checkride.config.json
```

- `[config]` — the slot is named in `checks` (a string, `use`, or `command`
  entry). Covers preset-inherited entries too: after `extends` folding the
  runner cannot tell them apart, and "your (effective) config asked for this"
  is the honest statement either way.
- `[detected: <file>]` — no config entry; the adapter won detection, and
  `<file>` is the first entry of its `detect` list that exists. This is the
  line that dissolves the surprise: it names the file on disk that opted the
  repo in.
- `[built-in]` — a detected adapter with an empty `detect` list (today only
  `links`), which is always available; there is no file to point at.
- `[custom]` — a config-only custom check (a `command` entry keyed by a
  non-catalogue name). Strictly implied by `[config]`, kept distinct because
  "this isn't a catalogue slot at all" is exactly what a reader scanning for
  an unfamiliar name wants to know.

Skip lines are already self-explaining (`disabled in checkride.config.json`,
`no tool detected for slot`, `no detect file present`, unavailable-under-pm)
and gain nothing.

`doctor` gets the same annotation on its per-slot report — same resolution
data, same rendering rule.

### Implementation sketch

Resolution already computes almost all of this; it just throws the detail away.

- `ResolvedCheck` (src/config.ts) gains
  `origin: 'config' | 'detected' | 'built-in' | 'custom'` and
  `detectedBy?: string`. The existing `explicit?: boolean` stays (selection
  logic uses it); `origin` is the human-facing superset.
- `resolveOne` sets `origin: 'config'` on any explicit entry;
  `detectAdapter` returns *which* detect file matched (today it returns only
  the adapter, src/config.ts:196) so the detection arm can set
  `origin: 'detected', detectedBy: file`, or `origin: 'built-in'` when
  `detect` is empty. The custom-check arm in `resolveChecks` sets
  `origin: 'custom'`.
- `formatStatusLine` (src/orchestrator.ts:241) appends the bracket suffix.
  Keep it last on the line and short — the line already carries mark, name,
  duration, and description.
- `SummaryCheck` gains `origin` and `detected_by` (snake_case in JSON, like
  `output_file`). **Additive fields under `schema_version: 1`** — same
  discipline as `baseline_masked` (docs/contract.md: fields may be added under
  a given schema_version, never removed or re-typed). Update the published
  JSON Schema accordingly.

### Non-goals

- No new flags, no verbosity gate. Provenance is one short token; if it ever
  needs a flag to hide, it is too long.
- No change to selection semantics (`--only`/`--skip`/`--include`, opt-in
  slots). This is presentation plus one recorded field.

## Feature 2 — `init` writes the detected slots into the config

### Behavior

Both init modes end with a `checkride.config.json` whose `checks` block names
every slot the run will execute — the config becomes the single place a reader
looks to answer "what runs here?", and each entry pins its adapter against
future changes in detection order or registry contents.

- **Existing mode already does this** (src/init.ts:579–587: adopted slots →
  adapter-name entries, probe-failing slots → `false`, never overwriting an
  existing file). That behavior is confirmed and kept; this spec makes it the
  rule for both modes rather than an accident of one.
- **New mode is the gap**: `initNew` scaffolds the blessed tool configs but
  writes no `checkride.config.json` at all, leaving the run to detection.
  It now also writes one, enumerating the slots its scaffolding just enabled
  (for example `types: "tsc"`, `lint: "oxlint"`, `struct: "ast-grep"`,
  `dead: "fallow"`, `test: "vitest"`, plus the always-on `links: "links"` and
  whichever of `docs`/`spell` the shape scaffolds), with the `$schema` header
  `initExisting` already emits.

Explicit entries are how the config model already expresses opt-in (an entry
opts an otherwise opt-in slot into the default run), so no new semantics are
introduced — `init` simply stops relying on detection for repos it set up
itself.

### Consequences to state in the docs

- A slot added to a scaffolded repo later (say, dropping in `knip.json`) will
  **not** auto-run, because config entries win over detection only per-slot —
  absent slots still detect. That is unchanged and correct: detection remains
  the zero-config fallback for anything the config does not name.
- Deleting a tool's config file while its `checks` entry remains flips the
  failure from "silently stops running" to a visible error/skip — a feature,
  and worth a line in getting-started.

### Non-goals

- No migration of existing repos' config files. A repo whose config predates
  this (volley being the motivating example) is updated by its owner, not by
  checkride.
- Zero-config operation is untouched: a repo that never ran `init` still
  detects everything, now with feature 1 telling it so.

## Rollout

Feature 1 is independent of feature 2 and lands first — it is pure
presentation plus an additive summary field, and it makes feature 2's output
self-verifying (`[config]` on every line after a fresh `init`). Both are
minor-version changes; neither touches the exit-code taxonomy or removes any
surface, so the docs/contract.md pin policy is satisfied.

Tests: unit-level on `resolveOne`/`detectAdapter` (origin and detectedBy per
resolution arm), snapshot of the rendered line suffixes, schema validation of
the extended `summary.json`, and an `initNew` e2e asserting the written
config names every scaffolded slot and the follow-up run reports `[config]`
across the board.
