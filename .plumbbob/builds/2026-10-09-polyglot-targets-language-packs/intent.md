# polyglot targets, language packs, and what a review agent needs

**Phase** (your own bookkeeping while framing): frame
**Size:** large
**Scope:** polyglot

*Source: [docs/spec-polyglot.md](../../../docs/spec-polyglot.md), the draft of 2026-10-08,
absorbed whole. Its Frame, Decisions, Constraints, Phases and Steps appear below as written,
apart from the amendments that cite D45 to D54, the calls settled at the plan pause. Its
reference sections R1 to R17, which the steps cite by number, are preserved under
[Source](#source) the same way.*

**Baseline.** The spec was written against checkride 0.13.0 (`351e639`). This build starts from
0.14.0, the session baseline. File and line references are against 0.13.0, so confirm each site
by name against HEAD before editing. From here on this file is the live plan, and the spec stays
the as-written source until step 74 marks it implemented.

**Sources.** This spec folds four inputs into one build ([D2 (one-source)](#d2)):

1. The polyglot targets draft (`research/checkride-polyglot-targets-spec.md`, v0, 2026-09-28):
   targets, language packs, pin chains, `unclaimed`, the `schema` slot and a standalone binary.
   `research/` is gitignored, so this spec restates everything the build needs from the draft. Its
   milestones M1 to M6 become Phases 5 to 8, 12 and 13.
2. Two issues from a private PR-review agent that runs checkride over PR checkouts and reads
   `.check/` as evidence for review findings:
   [#6](https://github.com/robmclarty/checkride/issues/6) (pin provenance, Go narrowing, `--out`, a
   findings API, explicit skips, a baseline diff) and
   [#7](https://github.com/robmclarty/checkride/issues/7) (Python and Terraform packs, a defaults
   layer, static-only runs, finding severity).
3. The maintainer's review of both issues (2026-10-08). It added one base ref for `--changed`,
   `--config`, a record of each run's scope, a fix for baseline keys on warnings that can't fail,
   and the rule that runs shaped from outside the repo never write to it.
4. Two queued drafts: [slot provenance](../../../docs/spec-slot-provenance.md) (both features) and
   [the test layout](../../../docs/spec-test-layout.md), built here as Phase 4.

## Frame

- **Problem:** checkride's thesis is language-neutral, but its machinery is TypeScript-only.
  Outside TypeScript everything is a custom check, with no `doctor`, `fix`, baseline, blessed
  defaults or scaffold, and a repo gets exactly one toolchain. A real consumer, a PR-review agent,
  now needs mixed repos checked: TypeScript, Go, Python, Terraform, shell and markdown, often in
  one PR. It runs checkride from outside the repo, with its own config, defaults, pins and output
  directory, against a checkout it may not write to, and with a static-only pass before its
  sandbox exists. It needs summaries that say why each check ran, which tool copy ran, at which
  commit and over which scope, and findings with lines and severity. Two of today's surfaces fail
  it outright: a custom check can't say "skipped", so a vacuous green is live in a real repo, and
  `--changed` hardcodes `origin/main`, which a sandbox clone may not have.
- **Smallest thing that solves it:** build the polyglot targets design with the review agent's
  requests folded in, plus the queued `init` work, in fourteen phases that each leave `main` green
  and releasable ([D1 (one-build)](#d1)).
- **Done looks like:**
  - every request in #6 and #7 maps to a shipped step ([Traceability](#traceability));
  - a 0.13 TypeScript repo with no new flag or config key runs exactly as before, apart from the
    additive summary fields R8 lists ([C2 (legacy-invariance)](#c2));
  - every example, old and new, is green, and each plant fails with the expected check name;
  - the review agent's recipes (R13.6) run end to end on a fixture: a static-only pass over an
    uninstalled copy, then a full pass over an installed one, with every finding parsed through
    `checkride/findings`;
  - `pnpm check` and `pnpm test:e2e` are green locally with the dev toolchains, and in CI with
    `CHECKRIDE_REQUIRE_TOOLCHAINS=1`.
- **Explicitly NOT doing:**
  - new-project shapes for `python` and `terraform` ([D38 (no-new-shapes)](#d38));
  - vulture, import-linter, pip-audit or checkov, and packs for Java, C#, Zig or Odin;
  - narrowing for anything but `go-build` and `go-test`, or a "new issues only" golangci-lint mode;
  - a normalized findings artifact under `.check/`, or a coarse cross-tool `level`;
  - any claim that checkride sandboxes, isolates or vets anything ([C10 (not-a-sandbox)](#c10));
  - `--out` for the gate and hooks, or any read-only guarantee beyond checkride's own writes;
  - Windows and musl binaries; crates.io, PyPI or `go install` shims; creating the Homebrew tap
    repository; publishing a release (the tap and every release stay manual, after the build);
  - self-update, installing toolchains or tools from a check, or a network escape hatch;
  - batching long file lists, bats, per-target ast-grep configs, TOML validation in `schema`, JSON
    formatting outside `ts`, and Go mutation, dupes or health;
  - migrating existing repos' configs.

## Traceability

| Request | Source | Decision | Steps |
| --- | --- | --- | --- |
| Record which pinned copy ran, the commit, the base, and why each check ran | #6 item 1 | [D13 (pin-recorded)](#d13), [D16 (provenance)](#d16), [D17 (run-record)](#d17) | 6, 8, 9, 30 |
| Narrow `{go-packages}` under `--changed` | #6 item 2 | [D35 (go-narrowing)](#d35) | 43 |
| `--out <dir>` | #6 item 3 | [D21 (out-dir)](#d21), [D48 (out-per-target)](#d48) | 10, 11, 27 |
| A findings parse API that keeps line numbers | #6 item 4 | [D28 (one-parser)](#d28), [D29 (findings-api)](#d29), [D49 (text-findings)](#d49) | 48 to 51, 60, 64, 68 |
| Custom checks can say "skipped" | #6 item 5 | [D34 (skip-exit-code)](#d34) | 1 |
| A baseline diff | #6 item 6 | [D33 (baseline-diff)](#d33) | 3 |
| Go pack and extractors before the binary and `schema` | #6 ordering note | [D1 (one-build)](#d1) | Phases 7 and 8 before 12 and 13 |
| A `python` pack | #7 item 1 | [D36 (python)](#d36) | 58 to 61 |
| A `terraform` pack | #7 item 2 | [D37 (terraform)](#d37) | 62 to 65 |
| A defaults layer and outside pins | #7 item 3 | [D9 (packs-key)](#d9), [D23 (defaults-layer)](#d23), [D24 (discover)](#d24), [D25 (pins-override)](#d25) | 25, 53 to 55 |
| Runs-repo-code metadata and a static-only run | #7 item 4 | [D26 (static-only)](#d26) | 56 |
| Severity in the parse API | #7 item 5 | [D30 (gates-not-level)](#d30) | 49 |
| Two runs per PR need their own output and config | #7 note on `--out` | [D20 (config-path)](#d20), [D21 (out-dir)](#d21) | 2, 11 |
| The contract doc doesn't list `adapter` | #7 follow-up comment | [D19 (contract-fields)](#d19) | 5 |
| One base ref for every `--changed` path | review | [D18 (one-base)](#d18) | 7, 29 |
| Baseline keys on warnings that can't fail | review | [D27 (gating-keys)](#d27) | 4 |
| Runs shaped from outside never write the repo | review | [D22 (consumer-runs-write-nothing)](#d22), [D47 (consumer-trigger)](#d47) | 2, 11, 53 to 56 |
| Slot provenance, features 1 and 2 | queued draft | [D16 (provenance)](#d16) | 6, 18 |
| The test layout, and its type-check question | queued draft | [D44 (test-layout-in)](#d44) | 12 to 17, 19 |
| Polyglot draft milestones M1 to M6 | polyglot draft | [D3 (stay-typescript)](#d3) to [D15 (network-security-only)](#d15) | Phases 5 to 8, 12, 13 |

## Architecture sketch

```text
checkride.config.json, or --config <file>        --defaults <file>         --pins <mise.toml>
        │  (extends folded in)                           │                          │
        ▼                                                ▼                          │
targets/resolve ─► mode + targets ◄── --discover    defaults layer                 │
        │                                                │                          │
        ├─► per target: packs/<pack> ─► slot → adapter:  target > packs > top-level > detection > defaults > skip
        ├─► repo scope: packs/repo   ─► struct docs links spell prose schema unclaimed
        ▼
selection: --only --skip --include --changed (+ --base), then the --static-only filter
        ▼
scheduler: waves + lock groups
        ▼
launch/resolve ─► argv via [override?, native pin, mise, path] + pack env (no fetch); cwd = target root
        ▼
capture: json | jsonl | txt; failOnOutput; skipExitCode ─► <out>/[<target>/]<name>.<ext>
        ▼
baseline subtract (gating keys only) ─► <out>/summary.json (+ digest.md) ─► exit 0 / 1 / 2
        │                                          │
        └─ ratchet: the repo's own full run only    └─► checkride/findings ◄── consumers
```

## Decisions

### Scope and sequencing

- <a id="d1"></a>**D1 (one-build)**: one plumbbob build in fourteen phases, ordered by what the
  review agent needs first: run-level fixes, then Go and the parsers, then consumer mode, Python
  and Terraform, with the `schema` slot and the binary last. Each phase ends with `pnpm check`
  and `pnpm test:e2e` green ([D52 (e2e-cadence)](#d52)) and is a release point, and releases stay manual `/version` calls, *because* a build this
  long needs safe stopping points, and the build itself must never publish anything.
- <a id="d2"></a>**D2 (one-source)**: this spec supersedes the polyglot targets draft and the
  slot provenance draft, and builds the test layout spec as Phase 4, *because* a build needs one
  source of truth, and the polyglot draft lives in a gitignored folder no clone can read.
- <a id="d3"></a>**D3 (stay-typescript)**: checkride stays one TypeScript codebase, with no
  rewrite, *because* the engine (spawn, capture, summarize, gate on the exit code) is already
  language-agnostic.
- <a id="d4"></a>**D4 (schema-slot)**: JSON support is a repo-scope `schema` slot that parses JSON,
  JSONC, YAML and markdown frontmatter and validates them against JSON Schemas, SKILL.md
  frontmatter included (R11.5). It's not a pack, *because* data files cross every language, and
  their tool is a validator, not a toolchain.

### Packs and targets

- <a id="d5"></a>**D5 (packs)**: slots stay one language-neutral vocabulary, and adapters move into
  packs: `ts`, `repo` (the repo-scope slots), `bash`, `go`, `rust`, `python` and `terraform`
  (R4, R5), *because* a slot's meaning must not depend on the language, and a pack is the unit
  that carries pins, environment, markers and templates.
- <a id="d6"></a>**D6 (targets)**: a target is a named (pack, root) pair. Multi-target mode is
  opt-in through `targets` or `--discover`, and without either a 0.13 repo runs exactly as before,
  *because* one toolchain per repo is the limit being removed, and existing repos must not notice
  ([C2 (legacy-invariance)](#c2)).
- <a id="d7"></a>**D7 (scope)**: every slot has a scope. Target-scope slots run once per target,
  with the target root as working directory. Repo-scope slots (`struct`, `docs`, `links`,
  `spell`, `prose`, `schema`, `unclaimed`) run once at the repo root, *because* toolchain-bound
  checks belong to a root, while file scanners are polyglot already.
- <a id="d8"></a>**D8 (naming)**: in multi-target mode, target-scope checks are named
  `<target>:<slot>` and write under `<out>/<target>/`, *because* names must stay unique and
  selectable (R5.2).
- <a id="d9"></a>**D9 (packs-key)**: a top-level `packs.<pack>.checks` block configures a slot for
  every target of that pack. Presets and the defaults file may carry it, though neither may
  declare `targets`, *because* a preset or a review agent can't know a repo's targets (this
  answers the polyglot draft's question about pack-level preset defaults).
- <a id="d10"></a>**D10 (resolution-order)**: a slot resolves from the target's entry, then
  `packs`, then top-level `checks`, then detection, then the defaults layer, then skip (R3),
  *because* the repo decides which tool fills a slot, and outside defaults fill only what the repo
  leaves empty.
- <a id="d11"></a>**D11 (unclaimed)**: a repo-scope `unclaimed` check fails when a toolchain marker
  (`go.mod`, `Cargo.toml`, `package.json`, `pyproject.toml`, a `.tf` file, and so on) sits outside
  every target that could check it (R11.3), *because* an unchecked directory is the polyglot form
  of vacuous green.

### Pins and the network

- <a id="d12"></a>**D12 (pin-chain)**: each pack resolves a tool through its pin chain, native
  source first, then `mise`, then `PATH`. The first declaring source wins with no fall-through,
  and `PATH` marks the tool unpinned (R6), *because* quietly substituting another copy would make
  a verdict depend on the machine it ran on.
- <a id="d13"></a>**D13 (pin-recorded)**: every check that spawns a tool records `pin_source`, and
  `tool_version` when a file read gives it. checkride never spawns `--version` to find it. This
  replaces the polyglot draft's `pinned: false`, *because* a quoted finding must trace to the copy
  that produced it (#6 item 1), at no cost per check.
- <a id="d14"></a>**D14 (no-fetch)**: every launcher path that could download is switched off
  through the spawn environment: Go, cargo, rustup, uv, mise, tfenv, tofuenv, Terraform's version
  check and trivy's check bundle (R6.4), *because* "a check never fetches a tool" has to hold for
  every launcher, not only the npm one.
- <a id="d15"></a>**D15 (network-security-only)**: only `network: true` adapters in the opt-in
  `security` slot touch the network. `terraform validate` is not one of them: `terraform init
  -backend=false` is a prerequisite, the way `go mod download` is, *because* flagging validate as
  `network` (as #7 proposed) would break the one rule the pin model rests on.

### Runs that explain themselves

- <a id="d16"></a>**D16 (provenance)**: every active check records `origin` (`config`, `detected`,
  `built-in`, `custom` or `defaults`) and, when detected, `detected_by`. The status line shows it
  as a bracket suffix, and new-mode `init` writes a config naming every slot it scaffolds,
  *because* "why did this run" should be answerable at the moment of surprise (this absorbs both
  features of the slot provenance draft).
- <a id="d17"></a>**D17 (run-record)**: the summary gains a top-level `run` (the selection, mode
  flags and `partial`) and `git` (`head`, `dirty`, and `base` under `--changed`), and each spawned
  check records its `argv` (R8), *because* a narrowed run must say so in the artifact, not only on
  screen, and argv is the exact answer to "what ran".
- <a id="d18"></a>**D18 (one-base)**: `--changed` uses one base ref everywhere, resolved from
  `--base`, then `CHECKRIDE_BASE`, then config `changedBase`, then `origin/main` when it resolves,
  then `HEAD`. Adapters receive it as `{base}`, changed paths are measured from the merge base,
  and the resolved ref and sha are recorded (R10), *because* vitest and jest hardcode
  `origin/main` today, the polyglot draft defaulted to `HEAD`, and sandbox clones often lack
  `origin/main`.
- <a id="d19"></a>**D19 (contract-fields)**: `docs/contract.md` lists every summary field, and a
  test holds that list equal to the JSON Schema's, *because* the follow-up comment on #7 misread
  a doc that names only a few fields.

### Consumer mode

- <a id="d20"></a>**D20 (config-path)**: `--config` and `CHECKRIDE_CONFIG` replace
  `<cwd>/checkride.config.json`. `extends` resolves against that file, and paths inside config
  values stay repo-relative, *because* running once with the base branch's config and once with
  the PR's needs it, and a read-only checkout can't take a swapped file.
- <a id="d21"></a>**D21 (out-dir)**: `--out` and `CHECKRIDE_OUT` move checkride's artifacts
  (summary, raw files, digest), and `triage` and `qa` read from there. Adapters reach their
  own artifact directory through `{out}`. Scratch for `snippets` and `smoke` stays under the
  target root's `.check/` (`<repo>/.check/` in implicit mode), and the gate and hooks always use
  `<repo>/.check/` (R9, [D48 (out-per-target)](#d48)), *because* concurrent and sandboxed runs
  need separate artifacts (#6 item 3), module resolution needs scratch inside the tree, and the
  dirty-marker protocol is repo-local.
- <a id="d22"></a>**D22 (consumer-runs-write-nothing)**: a run with a `--config` outside the repo,
  `--defaults`, `--pins`, `--discover`, `--static-only`, or an `--out` outside the repo never
  ratchets and never writes `checkride.baseline.json` (R13.5), and the `baseline` command is
  exempt ([D47 (consumer-trigger)](#d47)), *because* only the repo's own gate may rewrite repo
  files, and these runs don't represent it.
- <a id="d23"></a>**D23 (defaults-layer)**: `--defaults` and `CHECKRIDE_DEFAULTS` name a config
  layered below detection, with origin `defaults`. It may hold `checks` (custom checks included),
  `packs`, `extends`, `timeout`, `requirePins` and `schemas`, never `targets` (R13.1), *because*
  the repo's detected tool must beat an outside default (#7 item 3), and `extends` can't express
  that: its entries count as explicit config, which outranks detection.
- <a id="d24"></a>**D24 (discover)**: `--discover` runs existing-mode discovery at run time and
  applies its proposed targets in memory, lifting top-level target-scope entries the way
  `target add` would. Nothing is written (R13.2), *because* a polyglot repo with no `targets`
  otherwise runs only the pack at its root (R2.1).
- <a id="d25"></a>**D25 (pins-override)**: `--pins` and `CHECKRIDE_PINS` name a `mise.toml` that
  becomes the first source in every pin chain, recorded as `pin_source: "override"` and run as
  `mise exec <id>@<version> -- <bin>` (R13.3), *because* the agent's toolbelt has to run without
  writing into the checkout, and the swap has to show on each check.
- <a id="d26"></a>**D26 (static-only)**: `--static-only` keeps a check only when its adapter is
  marked `static`, its config isn't code (judged by file names and known keys) and its tool
  resolves without an install (R13.4). Every other check is skipped with a `static-only:` reason.
  A repo's custom check never qualifies; the defaults layer can vouch for its own. The docs
  present the flag as a selector, never a sandbox, *because* #7 needs a pre-sandbox pass, and the
  classification is best-effort: a tool release can add a new way to load code at any time.

### Findings and the baseline

- <a id="d27"></a>**D27 (gating-keys)**: baseline fingerprints key only findings that can fail the
  check under the argv that ran. vale works this way already, and oxlint and ast-grep join it.
  When gating can't be known, every finding is keyed, *because* keying a warning that can't fail
  lets a new warning keep a baselined slot red, and keying everything is the safe side (a false
  red, never a false green).
- <a id="d28"></a>**D28 (one-parser)**: each tool output format gets one parser under
  `src/findings/parsers/`, and baseline fingerprints derive from it, with existing keys held
  byte-identical by a golden test, *because* the findings API and the baseline must not drift
  apart, and existing baselines must keep masking.
- <a id="d29"></a>**D29 (findings-api)**: the `checkride/findings` subpath exports
  `parseFindings`, `findingsFor` and `isParseable` (R12). It's best-effort, returns `null` for an
  adapter it can't parse, never writes under the output directory and never decides a verdict,
  *because* consumers shouldn't reimplement checkride's parsers (#6 item 4), while raw output
  stays authoritative.
- <a id="d30"></a>**D30 (gates-not-level)**: a finding carries `severity` (verbatim), `gates` (when
  knowable) and `slot`, and no coarse `level`, *because* a tool's severity isn't what fails the
  check: shellcheck fails on `info` findings and golangci-lint on every issue, so a coarse level
  would call gate-failing findings advice (#7 item 5).
- <a id="d31"></a>**D31 (types-parse-only)**: type-checker parsers (tsc, go build, cargo check,
  mypy, basedpyright, terraform validate) feed the findings API but not the baseline, *because*
  type errors aren't grandfathered today, and nobody asked to change that.
- <a id="d32"></a>**D32 (docs-baselined)**: the `docs` adapters (markdownlint-cli2, rumdl) join the
  baseline, *because* lint, spell and prose already take part, and the polyglot draft baselined
  rumdl. `init --baseline` then grandfathers markdown findings instead of disabling `docs`, and
  the release notes say so.
- <a id="d33"></a>**D33 (baseline-diff)**: `checkride baseline diff [<ref>]` (default `HEAD`)
  prints added and removed keys per check, with `--json` for machines, and exits 0 when it ran
  and 2 on error (R7.3), *because* the pieces already exist for `recover` (#6 item 6).
- <a id="d34"></a>**D34 (skip-exit-code)**: a custom check may declare `skipExitCode` (1 to 255).
  A match records the contract's existing skipped shape (`exit_code: null`, `duration_ms: 0`),
  with a reason taken from the last stderr line followed by `(exit N)`, *because* a wrapper that can't
  run here must otherwise choose between red and a false green (#6 item 5), and the contract
  already defines what skipped looks like.

### Packs this build adds

- <a id="d35"></a>**D35 (go-narrowing)**: under `--changed`, `{go-packages}` narrows to the changed
  workspace modules plus their transitive in-workspace dependents, for adapters that opt in
  (`go-build`, `go-test`). `deadcode` and `govulncheck` never narrow. A `go.work` or `go.mod`
  change, or an unreadable graph, expands fully, and narrowing is recorded as `narrowed` (R10.4),
  *because* today every Go change in a 54-module workspace builds and tests all 54 (#6 item 2).
- <a id="d36"></a>**D36 (python)**: the python pack's markers are `pyproject.toml`, `setup.cfg` and
  `setup.py`; its pins are `uv-lock` (run from the project `.venv`), then `mise`, then `PATH`; it
  ships ruff (lint, format), mypy then basedpyright (types) and pytest (test) (R5.7), *because*
  `requirements*.txt` is too common outside Python projects to mark one, and the PyPI `pyright`
  wrapper downloads Node on first run (#7 item 1).
- <a id="d37"></a>**D37 (terraform)**: in the terraform pack, every `.tf` file marks terraform code
  for `unclaimed`, and discovery proposes one target per `.terraform.lock.hcl` directory plus one
  per remaining top-most `.tf` cluster. It ships `terraform fmt` (opt-in format), tflint (lint),
  `terraform validate` (types, skipped where no lock file marks a root module) and trivy config
  (opt-in security), and runs `terraform` or `tofu` per its version file (R5.8), *because* a lock
  file is the reliable root-module signal, while "a directory with `.tf` files" also matches every
  child module (#7 item 2).
- <a id="d38"></a>**D38 (no-new-shapes)**: the python and terraform packs ship blessed configs for
  `target add` and existing mode, but no new-project shapes, *because* the consumer reviews
  existing repos, and shapes can follow in their own build.

### Distribution and tests

- <a id="d39"></a>**D39 (sea-binary)**: the standalone binary is built with Node's single
  executable application (SEA) support, switching to `bun build --compile` only if SEA fails the
  e2e suite. Releases carry darwin-arm64, darwin-x64, linux-x64 and linux-arm64 (glibc) tarballs,
  `SHA256SUMS` and provenance attestations, and mise's `github:` backend is the documented pin for
  repos without Node (R14), *because* SEA keeps runtime parity with the tested npm path (this
  settles the polyglot draft's binary and mise questions).
- <a id="d40"></a>**D40 (entry-command)**: the AGENTS.md stanza, the generated hooks and the plugin
  skills all run checkride through the entry command (R6.6), and the skills call
  `checkride triage` that way everywhere, *because* a binary-only repo has no `pnpm run check`.
- <a id="d41"></a>**D41 (require-pins-default)**: `init --lang go|rust` writes `requirePins: true`,
  and existing repos default to `false`, *because* a new project can start pinned, while an
  existing one would turn red on upgrade.
- <a id="d42"></a>**D42 (toolchain-tests)**: unit tests use fake spawners and output captured from
  real tools. A pack's e2e cases skip when its toolchain is absent, unless
  `CHECKRIDE_REQUIRE_TOOLCHAINS=1`, which CI sets, and a dev `mise.toml` pins every e2e toolchain,
  *because* the build has to run on a laptop that lacks some tools, while CI proves all of them.
- <a id="d43"></a>**D43 (examples)**: each pack gets an example with plants, and `examples/polyglot`
  becomes `examples/python-project` on the python pack, *because* examples are the e2e evidence,
  and a Python example that ignores the python pack would mislead.
- <a id="d44"></a>**D44 (test-layout-in)**: Phase 4 builds the test layout spec as written. Its
  [Q1 (links-default-exclude)](../../../docs/spec-test-layout.md#q1) and
  [Q2 (dogfood)](../../../docs/spec-test-layout.md#q2) resolve on their leans (`fixtures` joins the `links`
  default exclude; this repo adopts the layout), and its
  [Q3 (test-typecheck)](../../../docs/spec-test-layout.md#q3) lands right after the provenance step that
  makes it possible, *because* that spec's own leans settle all three, and this build delivers the
  third one's precondition.

### Settled at the plan pause

- <a id="d45"></a>**D45 (capture-gate)**: json and jsonl capture apply only to a check that declares
  an `outputFile`, and the declared extension says which (`go-build` declares `types.jsonl`); a
  custom check without one keeps 0.13's text capture whatever it prints (R11.1), *because*
  sniffing every check would rename existing custom checks' artifacts on upgrade, which
  [C2 (legacy-invariance)](#c2) forbids and the golden can't see (was [Q2 (capture-gate)](#q2)).
- <a id="d46"></a>**D46 (checkride-pin)**: Go and Rust scaffolds pin checkride as `npm:checkride`,
  with `node` beside it, until a binary ships; the entry command counts `npm:checkride` or
  `github:robmclarty/checkride` as declaring checkride, and the distribution docs describe the
  switch to `github:` for repos that want no Node (R6.6, R7.5, R14.2), *because* the `github:`
  backend has nothing to install until Phase 13 and a manual release, and
  [Q1 (scope-cut)](#q1) may still cut Phase 13 (was [Q3 (checkride-pin)](#q3)).
- <a id="d47"></a>**D47 (consumer-trigger)**: the `baseline` command is the repo's explicit write
  and writes `checkride.baseline.json` whatever `--config` or `--out` it's given, and `--config`
  makes a consumer run only when the file sits outside the repo, the test `--out` already uses
  (R13.5), *because* [D22 (consumer-runs-write-nothing)](#d22) as first written left
  `baseline --config` nothing to do, and would stop a repo that passes its own `--config` from
  ever ratcheting (was [Q4 (consumer-trigger)](#q4)).
- <a id="d48"></a>**D48 (out-per-target)**: `{out}` is a check's own artifact directory: `.check` in
  implicit mode, as today, the absolute `<out>/<target>` for a target-scope check in multi-target
  mode, and the absolute `<out>` for a repo-scope one; scratch lives at `<target root>/.check/`,
  which is `<repo>/.check/` in implicit mode (R9), *because* a target-scope check runs from its
  target root, where a relative `.check` lands under the target and one shared `<out>` makes
  targets overwrite each other, and generated files must resolve the target's own modules (was
  [Q5 (out-per-target)](#q5)).
- <a id="d49"></a>**D49 (text-findings)**: each parser declares the stream it reads (the JSON
  artifact, stdout or stderr) and the baseline hands it that stream; `findingsFor` takes the run
  directory instead of raw text and opens the check's artifact itself, while `parseFindings` keeps
  taking raw text (R12.1, R12.2, R13.6), *because* the baseline reads stdout only, markdownlint-cli2
  reports on stderr, and a text-output check's summary entry names no file, so those findings
  would never reach the baseline or the review agent (was [Q6 (text-findings)](#q6)).
- <a id="d50"></a>**D50 (key-rebasing)**: target-scope baseline keys carry repo-root-relative paths
  from step 27, when targets arrive: the existing extractors join the check's root onto each path,
  and step 48 moves that join into the parsers (R12.4), *because* every phase end is a release,
  and keys that changed between Phase 6 and Phase 8 would turn every grandfathered finding red and
  let the ratchet prune the old keys (was [Q7 (key-rebasing)](#q7)).
- <a id="d51"></a>**D51 (golden-placement)**: the invariance golden splits into a contract half
  (resolved checks, order, names, argv and output file names, computed with a fake spawner and no
  installs) and an e2e half (summaries and exit codes), and step 20 builds first; Phase 4's steps
  update the init-shape entries on purpose, each in its own diff (S1), *because* summaries need
  installed examples, which `pnpm check` never has, and a golden recorded after steps 7 and 10
  would pin whatever they left rather than 0.13's behavior (was [Q8 (golden-placement)](#q8)).
- <a id="d52"></a>**D52 (e2e-cadence)**: a step whose done-when names an e2e test runs that file
  before its checkpoint, each phase's last step runs the whole `pnpm test:e2e`, and the plumbbob
  gate stays `pnpm check`, *because* `pnpm check` leaves `test/e2e/` out, this repo runs e2e before
  any release, and every phase end is a release point (was [Q9 (e2e-cadence)](#q9)).
- <a id="d53"></a>**D53 (inactive-slots)**: an inactive `schema` or `unclaimed` slot is absent from
  `checks`, the way an unselected opt-in slot is, but both names stay valid tokens, so selecting
  one records a skipped entry with its reason, and V2 reserves both names from step 25 (R2.3,
  R5.1), *because* two skipped entries in every existing repo's summary would break
  [C2 (legacy-invariance)](#c2), and a target named `schema` would otherwise break on the Phase 12
  upgrade (was [Q10 (inactive-slots)](#q10)).
- <a id="d54"></a>**D54 (go-mod-readonly)**: the go pack's spawn environment leaves `GOFLAGS` alone
  (R6.4), *because* Go 1.24 already refuses to rewrite `go.mod`, and an explicit `-mod=readonly`
  makes Go ignore `vendor/`, so a vendored module's checks would fail offline under `GOPROXY=off`
  (was [Q11 (go-mod-readonly)](#q11)).

### Settled during the build

- <a id="d55"></a>**D55 (run-fields-ahead)**: step 8's schema, contract doc and contract test
  define all twelve R8.1 `run` fields, five of them ahead of their flags (`out`, `defaults`,
  `discover`, `pins` and `static_only`), and those five doc rows say checkride has no such flag
  yet. The step that adds each flag records it through `runRecord` in `src/orchestrator/run.ts`
  and drops that note from its row, and step 56 also adds `--static-only` to `isPartialRun` and
  to the `partial` row, *because* the contract is then written once and consistently, and a flag
  shipped without its field would leave a narrowed or redirected run silent in its summary while
  the doc still said the flag didn't exist (settled at step 8 and its harvest).
- <a id="d56"></a>**D56 (out-labels)**: every line that names an artifact (the run's `report:` and
  `digest:` lines, the digest's raw pointers, and the `triage` and `qa` reports) names the run's
  actual output directory: relative to the working directory when it sits inside it, so `.check/`
  by default, and absolute when it sits outside. `src/artifacts/` derives that label from the
  directory, *because* step 10 routed that text through `CHECK_DIR`, and under `--out` it would
  still send a reader, the review agent of #6 among them, to `.check/` files that aren't there
  (settled at step 10's harvest).
- <a id="d57"></a>**D57 (prune-own-files)**: for a target that the output directory's previous
  summary listed and the config dropped, a run deletes only the files that summary's checks of
  the target name by convention (`<slot>.stdout.txt`, `<slot>.stderr.txt`, `<slot>.json` and
  each `output_file`), then the `<target>/` directory once nothing else is in it, with or
  without `targets` in the config, *because* a folder already under `--out` that shares a
  target's name takes that target's artifacts, and deleting the whole folder when the target is
  dropped would take the user's own files with it, breaking R9's promise that checkride never
  deletes what it didn't write (settled at step 27's harvest).
- <a id="d58"></a>**D58 (fix-same-chain)**: `checkride fix` launches each fixer through its
  check's pin chain with `launchCheck`, so it runs the copy the check runs and is refused where
  the check would be: an `npx` or `bunx` tool the project never installed, a pin whose source
  can't run the tool, or an unpinned tool under `requirePins`. A refused fixer prints the
  launcher's message and counts as failed, and the other fixers still run, *because* a fixer
  from a launcher's cache is the substitution [D12 (pin-chain)](#d12) rules out, and `fix`
  writes files (settled at step 30 and its harvest, from step 22's park).
- <a id="d59"></a>**D59 (nearest-pm)**: a check's package manager is the nearest one declared,
  by `packageManager` field and then lockfile, from its working directory up to the repo root,
  else `pnpm`. A target with its own lockfile runs under it, and a workspace package that
  declares neither runs under the root's. `nearestPackageManager` in
  `src/launch/package-manager.ts` resolves it, `src/orchestrator/place.ts` carries it per check
  and the fix path does the same, *because* a target with its own non-pnpm lockfile otherwise
  launched under the root's manager and recorded that manager's argv, and the `js-lockfile`
  source's declaration and version reads already walk up from the working directory (settled at
  step 30 and its harvest, from step 27's park).
- <a id="d60"></a>**D60 (builtins-unpinned)**: the `pack`, `smoke`, `snippets` and
  `snippets-dist` built-ins record neither `argv` nor `pin_source`, and their helper processes
  don't go through the launcher, *because* a built-in's verdict is checkride's own, not a pinned
  tool's, as step 9 ruled for `argv` (settled at step 30 and its harvest, from step 22's park).
- <a id="d61"></a>**D61 (shebang-sniff)**: R11.2's shebang sniff keeps an extensionless file whose
  first line names `bash`, `sh`, `dash` or `ksh` as its interpreter, directly by path or through
  `env` with any `env` flags (`#!/bin/sh`, `#!/usr/bin/env bash`, `#!/usr/bin/env -S dash -e`),
  matched in `src/targets/files.ts` as
  `^#!\s*(?:\S*/)?(?:env\s+(?:-\S+\s+)*)?(?:bash|sh|dash|ksh)(?:\s|$)`, *because* the regex R11.2
  first gave only matched `#!bash` and `#!/usr/bin/env bash`, which misses `#!/bin/bash` and
  `#!/bin/sh`, the commonest shebangs (settled at step 31 and its harvest).
- <a id="d62"></a>**D62 (entry-package-json)**: R6.6's entry command keeps `<pm> run check` for any
  repo whose root has a `package.json`, with or without a `check` script, and reaches mise's
  pinned checkride or the one on `PATH` only in a repo with no `package.json`, *because* a 0.13
  repo without a check script ran `<pm> run check` from its gate, and triage reports it as "gate
  not run" ([C2 (legacy-invariance)](#c2)), while D40's motivating case, a binary-only repo, has
  no `package.json` at all (settled at step 35 and its harvest).
- <a id="d63"></a>**D63 (qa-mutation-path)**: `qa` reads a check's `mutation.json` only where the
  repo's stryker `jsonReporter.fileName` writes it into the output directory, a target's own
  directory for a target's check, checkride routes no stryker file, and `docs/plugin.md` says so,
  *because* that path comes from the repo's stryker config, not from argv checkride builds, and
  `mutation` is opt-in and too slow for a review agent's run (settled at step 38 and its harvest,
  from the Ranges section's step 38 lean).
- <a id="d64"></a>**D64 (cargo-target-dir-lock)**: Rust rows lock on `cargo:{root}` alone, with no
  `cargo:global` key; targets that share one `CARGO_TARGET_DIR` serialize on cargo's own
  build-directory lock, and `docs/packs.md` says that wait counts against their timeouts,
  *because* a scheduler branch for it breaks [C5 (pure-data)](#c5), several rust targets sharing
  one target directory is rare, and the cost is a slow red, never a false green; a data form such
  as `cargo:{env:CARGO_TARGET_DIR|root}` can follow if a repo hits it (settled at step 45 and its
  harvest, from the Ranges section's step 45 lean).
- <a id="d65"></a>**D65 (verified-argv)**: R5.5, R5.6, R6.1, R6.2 and R6.4 read as steps 41 to 46
  shipped them after running each tool at the version the dev `mise.toml` pins: `go build` takes
  `-o /dev/null`; golangci-lint takes `--show-stats=false` and `{go-packages}`; govulncheck runs
  in text mode; cargo-deny's JSON lines land in `security.stderr.txt`; cargo-mutants takes
  `--output {out}`; the `rust-toolchain` source pins `cargo` itself, rustfmt and clippy, and
  refuses without `rustup` on `PATH`; `go-mod-tool` reads, at a `go.work` root with no `go.mod`,
  the tool directives of the modules the workspace uses; a toolchain walks its pack's chain and
  isn't refused under `requirePins`; and a rust check clears `RUSTUP_TOOLCHAIN` where a toolchain
  file pins the toolchain, *because* the plan's argv wrote a binary into a single-main module,
  left `lint.json` unwritten behind golangci-lint's tally, missed every module of a workspace,
  and made Go's `security` a vacuous green, since `govulncheck -format json` exits 0 on a called
  vulnerability, while mise's exported `RUSTUP_TOOLCHAIN` overrode a repo's pinned channel, and
  steps 50, 56, 72 and 73 build from this text (settled at step 47's harvest, from steps 41 to
  46).
- <a id="d66"></a>**D66 (implicit-pack)**: R2.1's implicit pack, a root `go.mod`, `Cargo.toml`,
  Python or Terraform marker picking that pack when no `targets` is configured, is built as
  step 76, ordered before step 52; until it lands, `init --lang go|rust` writes an explicit `app`
  target at the root, *because* no step built it, `config.ts` still resolves every implicit repo
  as `ts`, and step 52's Go adoption, step 54's `--discover` (R11.4's single root target stays
  implicit) and the review agent's runs over checkouts without a config all build on it (settled
  at step 47's harvest, from step 46's park).
- <a id="d67"></a>**D67 (typos-brief)**: R12.2's `typos` row reads text (`--format brief`), the
  format the adapter has run since step 32 and the parser reads from step 51: one
  `./<file>:<line>:<col>: error: <message>` line per misspelling, its `./` dropped from the key,
  and a misspelled file name, which brief prints as a bare `error: <message>`, kept as a gating
  finding with no file, *because* R12.2 first said jsonl, which nothing runs, and step 73 folds
  R12 into the docs (settled at step 51's harvest, from step 51's park).
- <a id="d68"></a>**D68 (discover-go-rust)**: R11.4's go and rust rules (each `go.work` directory
  a go target claiming its `use` modules, then each unclaimed `go.mod`; each `Cargo.toml` with
  `[workspace]` a rust target, then each unclaimed `[package]` manifest) are built in step 54,
  alongside `--discover`, and a lone proposed target at the root is implicit only when its pack
  is the one R2.1 picks there, *because* step 37 shipped only the ts and bash rules on the
  premise that each pack's release would add its own, steps 42 and 45 didn't, and without them
  `--discover` over a mixed repo, the run #7 and [D24 (discover)](#d24) want, proposes no target
  for its Go or Rust code (settled at step 76's harvest, from step 76's park).
- <a id="d69"></a>**D69 (config-error-file)**: every config error names the file it came from:
  `invalid <path>: <reason>` for a `--config`, `--defaults` or `--pins` file, at load and at
  resolve time alike, the latter through a label each config loaded from another path keeps,
  and a defaults file's entries are held to resolution's rules as it loads, so a typo surfaces
  in every repo rather than only one where the entry fills a slot, *because* F36's error helps
  only if it names the defaults file (settled at step 53 from the Ranges section's lean, folded
  at step 57's harvest).
- <a id="d70"></a>**D70 (implicit-top-over-packs)**: in a repo without `targets`, the top-level
  `checks` are the implicit target's own entries, so for a target-scope slot or a custom check
  they rank above `packs.<pack>.checks` of the root's pack, ts roots included, then
  detection, then the defaults layer's `packs` and `checks`; multi-target mode keeps R3 as
  written, *because* a preset's or a defaults file's `packs` block would otherwise do nothing in
  a repo without `targets`, a pack default must not beat the repo's own entry, and `target add`
  moves those top-level entries into the converted target, where they rank the same way
  (settled at step 53 from the Ranges section's lean, folded at step 57's harvest).
- <a id="d71"></a>**D71 (consumer-calls)**: R13.1, R13.3 and R13.4 read as steps 53 to 56 shipped
  them where the plan was silent. A defaults entry fills a slot with the opt-in status the repo
  gives it and never opts one in itself; a defaults `false`, or a pick the check's pack has no
  adapter for, fills nothing; a defaults file holds only its listed keys, any other exiting 2,
  and a top-level entry naming an adapter no pack has exits 2. The `override` source runs
  offline (`MISE_OFFLINE=1`) behind a `mise where <id>@<version>` check, a toolchain the file
  pins runs that copy in any chain, and detection never reads the file. A `CodeKey` names a file
  by name at any depth or by path glob, with an optional `value` regex; an entry that swaps a
  static adapter's command loses the mark; under `--static-only` the js-lockfile pre-flight
  covers every package manager but a PnP install; keys are sniffed as text, erring toward a
  skip. `doctor` refuses `--pins` and `--static-only` with exit 2 until step 69 teaches it
  both, *because* steps 72 and 73 build the docs from R13, and they would otherwise document
  rules no run keeps (settled at steps 53 to 56, folded at step 57's harvest).
- <a id="d72"></a>**D72 (mutation-sandbox)**: stryker runs the tests through a vitest config of
  its own that leaves out the ones that read the repo's git state
  (`test/integration/dogfood-config.test.ts`), which `pnpm check` still runs, *because*
  stryker's sandbox is a gitignored copy with no git state of its own, so those tests fail its
  dry run and no full mutation run can start, while they guard the repo's files rather than
  the code stryker mutates, and C12 (quality-floors) needs the repo-wide score (folded at step
  57's harvest, from step 53's park).
- <a id="d73"></a>**D73 (discover-stands-down)**: `--discover` over a config that declares
  `targets` checks those targets, as a run without the flag would, prints one stderr note saying
  the config's targets stand in for discovery, and still records `run.discover`, with no target
  marked `discovered`; it stays a consumer run that never ratchets ([D22 (consumer-runs-write-nothing)](#d22)).
  This replaces F37's exit 2, *because* a review agent runs one recipe over many repos and can't
  know which declare targets before it reads their configs, the repo's own targets are better
  evidence than discovery, and the flag hasn't shipped (the maintainer's call at step 57's
  boundary, from that harvest's `--discover` item).

## Constraints

- <a id="c1"></a>**C1 (additive-contract)**: every contract change is additive under
  `schema_version: 1`, moves the JSON Schema, `docs/contract.md` and its contract test in the same
  step, and is listed under **Contract** in `CHANGELOG.md`. No step edits a contract test without
  the doc.
- <a id="c2"></a>**C2 (legacy-invariance)**: a 0.13 TypeScript repo run with no new flag or config
  key resolves the same checks, order, names, argv, output files and exit code, and its
  `summary.json` differs only by the additive fields R8 lists. A golden test holds this from the
  first step on, because step 20 builds first ([D51 (golden-placement)](#d51)).
- <a id="c3"></a>**C3 (raw-output)**: raw tool output is never normalized or filtered. New
  artifacts are checkride's own formats (`unclaimed.json`, `schema.json`), and the findings API is
  a library that never writes under the output directory.
- <a id="c4"></a>**C4 (no-network)**: checks make no network call except `network: true` adapters
  in the opt-in `security` slot. Test setup may download (`go mod download`, `uv sync`,
  `cargo fetch`, `tofu init`); checks never do.
- <a id="c5"></a>**C5 (pure-data)**: `PACKS`, `TOOLS` and every adapter row are pure data that
  survive a JSON round trip, and the orchestrator and launcher never branch on a pack's name,
  held by an ast-grep rule.
- <a id="c6"></a>**C6 (runtime-deps)**: the npm package gains exactly three runtime dependencies,
  `ajv`, `yaml` and `jsonc-parser`, exact-pinned and lazy-loaded by the `schema` slot. Nothing
  else joins `dependencies`.
- <a id="c7"></a>**C7 (house-style)**: TypeScript strict, ESM and NodeNext; functional and
  procedural, with no `class`, `this` or `extends`; named exports; unit tests in `__tests__/`; the
  deep-module layout; and `pnpm check` green at every step (AGENTS.md). The `security` slot is
  opt-in in this repo's config for now, because `pnpm audit` answers to the day's advisory feed
  rather than to the step's code, so `pnpm check`, CI and plumbbob skip it; run it explicitly with
  `pnpm check --include security`.
- <a id="c8"></a>**C8 (platforms)**: macOS and Linux; Node 22.18 or later; Go 1.24 or later;
  stable Rust 1.85 or later; Terraform 1.5 or OpenTofu 1.6 or later; and a uv-managed environment
  for Python projects.
- <a id="c9"></a>**C9 (real-fixtures)**: every parser is proven against output captured from the
  real tool at the version the dev `mise.toml` pins, stored under `src/__tests__/fixtures/`, and
  never hand-written.
- <a id="c10"></a>**C10 (not-a-sandbox)**: no doc, flag, field or message claims that checkride
  isolates, sandboxes or vets anything.
- <a id="c11"></a>**C11 (docs-in-step)**: a step that adds or changes a surface updates its doc and
  `CHANGELOG.md` in the same commit, and the docs-currency tests learn the pack tables and the
  slot scope column.
- <a id="c12"></a>**C12 (quality-floors)**: the mutation score stays at or above
  `stryker.config.mjs`'s break threshold (68 today), and line coverage at or above 70%, with the
  new modules included. The mutation canary (`test/e2e/mutation-canary.e2e.test.ts`) stays green,
  so a score is never read off a run that killed nothing.

## Phases

| Phase | Steps | Delivers |
| --- | --- | --- |
| 1. Fixes that need no packs | 1 to 5 | `skipExitCode`, `--config`, `baseline diff`, gating keys, the contract field list |
| 2. Runs that explain themselves | 6 to 9 | `origin`, one `--changed` base, `run` and `git`, `argv` |
| 3. An output directory | 10 to 11 | `--out` |
| 4. `init` writes the test layout and a config | 12 to 19 | the test layout spec, provenance feature 2, type-checked scaffold tests |
| 5. Pack groundwork | 20 to 23 | the invariance golden, packs, the launcher, `resources.ts`, with no behavior change (draft M1) |
| 6. Targets, bash and mise | 24 to 39, 75 | targets, tokens, locks, pins, `unclaimed`, the bash pack, `target add`, discovery (draft M2) |
| 7. Go and Rust | 40 to 47 | the go and rust packs, Go narrowing, `init --lang` (draft M3) |
| 8. Findings | 48 to 52, 76 | one parser per format, `checkride/findings`, the implicit pack, a Go baseline (draft M6) |
| 9. Consumer mode | 53 to 57 | `--defaults`, `--discover`, `--pins`, `--static-only`, the consumer guide |
| 10. Python | 58 to 61 | the python pack |
| 11. Terraform | 62 to 65 | the terraform pack |
| 12. The schema slot | 66 to 68 | `schema` and its bundled schemas (draft M5) |
| 13. The standalone binary | 69 to 72 | the SEA binary and its release pipeline (draft M4) |
| 14. Close-out | 73 to 74 | the pack and target docs, retiring the drafts, running the opt-in audit |

Every phase ends at a release point, and its last step runs the whole `pnpm test:e2e`
([D52 (e2e-cadence)](#d52)). Cutting a release is the maintainer's `/version` call, never a step.

## Steps

Step 17 moves this repo's loose `test/*.test.ts` files. Later steps name test files by their
0.13 paths; resolve each by name after the move.

<!-- markdownlint-disable MD029 -->
<!-- Step numbers run on across the phase headings, because plumbbob numbers each step for life. -->

### Phase 1: fixes that need no packs

1. [x] feat(config): let a custom check report a skip through its exit code, **done when:** a custom check exiting its `skipExitCode` records `skipped: true`, `ok: true`, `exit_code: null`, `duration_ms: 0` and a reason taken from its last stderr line followed by `(exit N)`; it's left out of `checks_run`; `--strict` exits 2 when every check skipped itself; the config schema accepts 1 to 255 and rejects 0 and non-integers; `fix` reports a match as skipped; unit tests cover each case (F23, F24)
   - seam: `src/config.ts`, `src/orchestrator/execute.ts`, `src/orchestrator/fix.ts`,
     `schema/checkride.config.schema.json`, `src/__tests__/config.test.ts`,
     `src/orchestrator/__tests__/orchestrator.test.ts`, `docs/tools.md`, `docs/contract.md`,
     `CHANGELOG.md`
   - model: sonnet (fully specified by the skip-exit-code decision)
2. [x] feat(cli): read the config from a path with --config, **done when:** `--config <path>` and `CHECKRIDE_CONFIG` replace `<cwd>/checkride.config.json` for run, `doctor`, `fix` and `baseline`; relative `extends` resolve against that file; a missing path exits 2 (F25); a run naming a config outside the repo never ratchets ([D22 (consumer-runs-write-nothing)](#d22)), while a run naming one inside the repo, and the `baseline` command, behave as they do without the flag ([D47 (consumer-trigger)](#d47)); the gate strips the consumer variables from the check it spawns, starting with this one; `flags.contract.test.ts` covers the flag and the variable
   - seam: `src/cli.ts`, `src/config.ts`, `src/orchestrator/run.ts`, `src/gate.ts`,
     `src/__tests__/cli.test.ts`, `test/contract/flags.contract.test.ts`, `docs/contract.md`,
     `docs/cheatsheet.md`, `CHANGELOG.md`
   - model: sonnet (a small flag with precise rules)
3. [x] feat(baseline): add baseline diff against a git ref, **done when:** `checkride baseline diff [<ref>] [--json]` reads `<ref>:checkride.baseline.json` through git (default `HEAD`), diffs it against the working-tree file with `diffBaselines`, and prints added and removed keys per check, or R7.3's JSON; a missing file on either side reads as empty (F30); a bad ref exits 2; `baseline.contract.test.ts` pins the JSON shape
   - seam: `src/baseline-command.ts`, `src/baseline/history.ts`, `src/cli.ts`,
     `src/__tests__/baseline.test.ts`, `test/contract/baseline.contract.test.ts`,
     `docs/contract.md`, `docs/tools.md`, `CHANGELOG.md`
   - model: sonnet (wiring of existing pieces)
4. [x] fix(baseline): key only the oxlint and ast-grep findings that can fail, **done when:** the oxlint extractor keys `error` diagnostics only unless argv carries `--deny-warnings` or `--max-warnings`, and ast-grep keys `error` matches only unless argv carries `--error`; tests mirror vale's "a new warning does not block masking" for both (F31) and prove `--deny-warnings` still keys warnings (F32); a test shows the next full run ratchets old warning keys away
   - seam: `src/baseline/fingerprint.ts`, `src/baseline-command.ts`, `src/orchestrator/run.ts`,
     `src/__tests__/baseline-fingerprint.test.ts`, `src/__tests__/fixtures/`, `CHANGELOG.md`
   - model: opus (gating depends on argv, and the false-green direction must stay closed)
5. [x] docs(contract): list every summary field and hold the list with a test, **done when:** `docs/contract.md` names every top-level and per-check field of `summary.json` with its presence rule, and `summary.contract.test.ts` fails when that list and the JSON Schema's properties differ; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
   - seam: `docs/contract.md`, `test/contract/summary.contract.test.ts`
   - model: sonnet (a doc plus one assertion)

### Phase 2: runs that explain themselves

6. [x] feat(report): record why each check runs as origin and detected_by, **done when:** resolution sets `origin` on every active check and `detected_by` on detected ones (the matched detect file, `package.json: <dep>` or `package.json: scripts.<name>`); the status line ends with `[config]`, `[detected: <file>]`, `[built-in]` or `[custom]`; `doctor` shows the same; the summary schema, contract doc and contract tests move together (S21)
   - seam: `src/config.ts`, `src/orchestrator/report.ts`, `src/orchestrator/types.ts`,
     `src/doctor.ts`, `schema/checkride.summary.schema.json`,
     `test/contract/summary.contract.test.ts`, `test/contract/streams.contract.test.ts`,
     `docs/contract.md`, `CHANGELOG.md`
   - model: sonnet (specified by the slot provenance draft's feature 1)
7. [x] feat(changed): resolve one base ref for --changed and pass it as {base}, **done when:** the base resolves in [D18 (one-base)](#d18)'s order; vitest and jest `changedArgs` use `{base}`; with no flag, variable or config and a resolvable `origin/main`, argv equals 0.13's; an explicit base that doesn't resolve exits 2, and a defaulted `origin/main` that doesn't resolve falls back to `HEAD` with a stderr warning (F26); `src/git.ts` now hosts the git runner that `baseline/history.ts` owned
   - seam: `src/git.ts`, `src/baseline/history.ts`, `src/adapters.ts`,
     `src/orchestrator/spawn.ts`, `src/orchestrator/context.ts`, `src/cli.ts`, `src/config.ts`,
     `schema/checkride.config.schema.json`, `test/contract/flags.contract.test.ts`,
     `docs/contract.md`, `CHANGELOG.md`
   - model: sonnet (a resolution chain and a placeholder)
8. [x] feat(summary): record the run's selection and git state, **done when:** every summary carries `run` (R8.1), with `partial` true exactly when the ratchet's partial-run test is, and carries `git` (`head`, `dirty`, and `base` under `--changed`) when the working directory is a git work tree; the git queries start with the run, so they add no wall-clock time in the common case; schema, contract doc and contract test move together
   - seam: `src/orchestrator/run.ts`, `src/orchestrator/types.ts`, `src/git.ts`,
     `schema/checkride.summary.schema.json`, `test/contract/summary.contract.test.ts`,
     `docs/contract.md`, `CHANGELOG.md`
   - model: sonnet
9. [x] feat(summary): record the argv each check spawned, **done when:** each check that spawned a process carries `argv` exactly as spawned, after package-manager translation, and built-ins and skipped checks carry none; schema, contract doc and contract test move together; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
   - seam: `src/orchestrator/spawn.ts`, `src/orchestrator/execute.ts`,
     `src/orchestrator/types.ts`, `schema/checkride.summary.schema.json`,
     `test/contract/summary.contract.test.ts`, `docs/contract.md`
   - model: sonnet

### Phase 3: an output directory

10. [x] refactor(artifacts): route every artifact path through one output dir, **done when:** one module under `src/artifacts/` owns the output directory, and the engine, digest, triage, qa and doctor read it from there; adapters say `{out}` where they said `.check` (`--outputFile={out}/test.json`); rule A5 forbids a `.check` literal in the engine modules; every test and example passes unchanged
    - seam: `src/artifacts/`, `src/orchestrator/run.ts`, `src/orchestrator/execute.ts`,
      `src/orchestrator/spawn.ts`, `src/adapters.ts`, `src/digest/digest.ts`, `src/doctor.ts`,
      `rules/`
    - model: sonnet (mechanical, and held by the existing suite)
11. [x] feat(cli): write artifacts to another directory with --out, **done when:** `--out <dir>` and `CHECKRIDE_OUT` move `summary.json`, the raw files and `digest.md` (R9); the summary records the directory as `run.out`, and its `docs/contract.md` row drops "no such flag yet" ([D55 (run-fields-ahead)](#d55)); `triage` and `qa` take `--out`; `doctor` probes that directory; every line that names an artifact names that directory ([D56 (out-labels)](#d56)); `snippets` and `smoke` keep scratch under `<repo>/.check/` and skip with a reason when it isn't writable (F29); an output directory outside the repo suppresses the ratchet (F27), though `baseline --out` still writes `checkride.baseline.json` ([D47 (consumer-trigger)](#d47)); the gate strips `CHECKRIDE_OUT` (F47); an e2e case runs two checks at once with different `--out` values in one fixture and finds both artifact sets intact (F28); the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `src/cli.ts`, `src/artifacts/`, `src/triage/cli.ts`, `src/qa/cli.ts`,
      `src/snippets.ts`, `src/smoke.ts`, `src/gate.ts`, `src/doctor.ts`,
      `test/contract/flags.contract.test.ts`, `test/e2e/`, `docs/contract.md`, `docs/ci.md`,
      `src/baseline-command.ts`, `src/orchestrator/run.ts`, `CHANGELOG.md`,
      `src/orchestrator/report.ts`, `src/digest/digest.ts`, `src/triage/render.ts`,
      `src/qa/render.ts`
    - model: opus (several readers, the scratch carve-out and a concurrency test)

### Phase 4: init writes the test layout and a config

Steps 12 to 17 are [the test layout spec](../../../docs/spec-test-layout.md)'s steps 1 to 6. Its decisions,
reference rules and porting trap apply as written there.

12. [x] feat(init): ship the six layout and barrel rules in new-project mode, **done when:** `init.test.ts` asserts the new-mode scaffold writes all ten rules, and the existing-mode assertions are unchanged
    - seam: `templates/shared/rules/`, `src/init.ts`, `src/__tests__/init.test.ts`
    - model: sonnet (port the reference rules with that spec's shape-agnostic globs)
13. [x] feat(init): make the starter files obey the rules they ship, **done when:** `shapes.e2e.test.ts` is green for flat, monorepo and hybrid, and `init.test.ts`'s expected file list names `src/<name>.ts` and `src/__tests__/<name>.test.ts`
    - seam: `src/init.ts`, `src/__tests__/init.test.ts`, `test/e2e/shapes.e2e.test.ts`
    - model: sonnet (fully specified by that spec's starter-file decision)
14. [x] feat(init): carve test/fixtures out of every scaffolded tool, **done when:** an e2e case scaffolds each shape, plants a broken `test/fixtures/probe/`, and checkride still exits 0; the probe holds malformed markdown, a dead link, a typo, a default export, an `it.only` and a loose test file; `fixtures` joins the `links` slot's built-in exclude set, and `docs/tools.md` records that a repo can't opt back in
    - seam: `templates/shared/`, `templates/flat/fallow.toml`, `templates/monorepo/fallow.toml`,
      `templates/hybrid/fallow.toml`, `src/links.ts`, `test/e2e/shapes.e2e.test.ts`,
      `docs/tools.md`
    - model: opus (seven tools, each with its own ignore syntax)
15. [x] test(init): verify the location rules by scanning a real tree, **done when:** for flat and monorepo paths, each location rule fires on a misplaced file and stays silent on sanctioned and fixture paths, in a scan of a temp tree built from `templates/shared/rules/`
    - seam: `test/e2e/layout-rules.e2e.test.ts`
    - model: sonnet (port keyframes' `test/integration/layout-rules.test.ts`)
16. [x] docs(init): describe the shipped layout and rules, **done when:** a test fails if a file in `templates/shared/rules/` goes unnamed in `docs/deep-modules.md`, and `getting-started.md` shows the test layout
    - seam: `docs/deep-modules.md`, `docs/getting-started.md`, `test/docs-currency.test.ts`,
      `CHANGELOG.md`
    - model: sonnet (docs plus one currency assertion)
17. [x] chore(test): adopt the test layout in this repo, **done when:** this repo's `rules/` carries the layout rules, its six loose `test/*.test.ts` files have moved to `test/integration/` (none locks a consumer surface, which is what `test/contract/` means here), no path outside `.plumbbob/`, `CHANGELOG.md` and the `docs/spec-*.md` drafts still cites their old location, `no-deep-sibling-import` skips imports into `test/` in both `rules/` and `templates/shared/rules/`, so `layout-rules.e2e.test.ts` passes a `src/**/__tests__/` file importing `test/helpers/` with no findings and flags `src/report/leak.ts` with `src-never-imports-test` alone, and `pnpm check` is green
    - seam: `rules/`, `test/`, `templates/shared/rules/no-deep-sibling-import.yml`, `docs/deep-modules.md`, `CHANGELOG.md`, `AGENTS.md`, `checkride.config.json`, `examples/README.md`, `.claude/skills/version/SKILL.md`
    - model: sonnet (moves plus import-path fixes, and a one-line rule exemption)
18. [x] feat(init): write a config naming every scaffolded slot in new mode, **done when:** `initNew` writes `checkride.config.json` with the `$schema` header and one entry per slot its scaffold enables; the follow-up run in `shapes.e2e.test.ts` shows `[config]` on every check line; existing mode is unchanged
    - seam: `src/init.ts`, `src/__tests__/init.test.ts`, `test/e2e/shapes.e2e.test.ts`,
      `docs/getting-started.md`, `CHANGELOG.md`
    - model: sonnet (specified by the slot provenance draft's feature 2)
19. [x] feat(init): type-check scaffolded tests outside src, **done when:** new-mode scaffolds ship `tsconfig.test.json` and a `typecheck-tests` custom check in the written config, and a type error planted in `test/integration/` fails that check in every shape (e2e); the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `templates/shared/`, `src/init.ts`, `test/e2e/shapes.e2e.test.ts`,
      `docs/getting-started.md`
    - model: sonnet (this repo's own `typecheck-tests` is the reference)

### Phase 5: pack groundwork, no behavior change

20. [x] test(invariance): pin 0.13's resolved checks, argv and summaries, **done when:** built first ([D51 (golden-placement)](#d51)), a contract golden records, for every example and each `init` shape, the resolved checks, their order, names, argv and output file names, computed with a fake spawner and no installs, and an e2e golden records each one's summary, with its volatile fields masked, and its exit code; both pass on the session's baseline tree, and the e2e golden names the additive fields R8 allows (S1)
    - seam: `test/contract/invariance.contract.test.ts`, `test/fixtures/invariance/`,
      `test/e2e/invariance.e2e.test.ts`
    - model: opus (what the golden masks decides what it can catch)
21. [x] refactor(packs): split the adapter registry into ts and repo packs, **done when:** `src/packs/` holds `ts` and `repo` as pure data; `SLOTS` gains `scope`; `ADAPTERS` stays exported as their union; `PACKS` and `TOOLS` are exported; the round-trip test (A1) passes; the invariance golden is unchanged
    - seam: `src/adapters.ts`, `src/packs/`, `src/index.ts`, `src/__tests__/adapters.test.ts`,
      `test/contract/exports.contract.test.ts`
    - model: sonnet
22. [x] refactor(launch): resolve tool argv through a pin-source launcher, **done when:** `src/launch/` builds every spawned argv through the `js-lockfile` source, which absorbs `src/pm/`'s behavior; rule A2 holds for `src/orchestrator/` and `src/launch/`; `pm.test.ts`, `pm-quartet.e2e.test.ts` and the invariance golden pass unchanged
    - seam: `src/launch/`, `src/pm/`, `src/orchestrator/spawn.ts`, `src/orchestrator/fix.ts`,
      `rules/`
    - model: opus (the package-manager quartet's edge cases move house)
23. [x] refactor(resources): read bundled files through one module, **done when:** `src/resources.ts` is the only module that reads `templates/`, `schema/` or `skills/` (rule A3); templates live under `templates/ts/` and `templates/repo/`; every shape e2e passes unchanged; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `src/resources.ts`, `src/init.ts`, `src/agent-setup/`, `templates/`, `rules/`,
      `package.json`
    - model: sonnet

### Phase 6: targets, the bash pack and mise

24. [x] chore(dev): pin every e2e toolchain in a dev mise.toml, **done when:** a root `mise.toml` pins Go, Rust, Python, uv, shellcheck, shfmt, golangci-lint, typos, rumdl, vale, ast-grep, OpenTofu, tflint and trivy at tested versions; `mise install` succeeds locally; CI's e2e job installs them with `jdx/mise-action` and sets `CHECKRIDE_REQUIRE_TOOLCHAINS=1`; a helper skips a pack's e2e cases when its tools are missing, unless that variable is set; this repo's own run is unchanged
    - seam: `mise.toml`, `.github/workflows/ci.yml`, `test/helpers/toolchains.ts`,
      `CONTRIBUTING.md`
    - model: sonnet (needs the network once, for `mise install`)
25. [x] feat(config): accept targets and packs blocks with their validation, **done when:** the config schema and loader accept `targets`, `packs`, `requirePins`, `changedBase` and `unclaimed`; V1 to V12 each exit 2 with their own message (S3), and V2 already reserves `schema` and `unclaimed` ([D53 (inactive-slots)](#d53)); implicit-mode configs resolve as before
    - seam: `src/config.ts`, `src/targets/resolve.ts`, `schema/checkride.config.schema.json`,
      `src/__tests__/config.test.ts`, `docs/contract.md`
    - model: opus (twelve rules, each with an exact message)
26. [x] feat(select): select checks with the target token grammar, **done when:** `--only`, `--skip`, `--include`, `gate.only` and `gate.skip` accept R5.2's grammar; an unknown token exits 2 and lists the valid ones; a table test covers every row (S2, F18)
    - seam: `src/targets/tokens.ts`, `src/orchestrator/select.ts`, `src/gate.ts`
    - model: sonnet
27. [x] feat(run): run target-scope slots once per target, **done when:** each target resolves its slots in [D10 (resolution-order)](#d10)'s order with the target root as working directory; checks are named `<target>:<slot>` and write under `<out>/<target>/`; a run deletes only the directories of targets the previous summary listed and the config dropped (R9), and a test proves an unrelated folder under `--out` survives; the summary carries `target`, `slot`, `pack`, `cwd` and the top-level `targets`, held by the schema and contract test; `checks` follows R8.4's order; `{out}` and scratch resolve per [D48 (out-per-target)](#d48), and a case with two ts targets finds both vitest reports where the summary says; target-scope baseline keys carry repo-root-relative paths ([D50 (key-rebasing)](#d50))
    - seam: `src/orchestrator/`, `src/config.ts`, `src/targets/`, `src/artifacts/`,
      `schema/checkride.summary.schema.json`, `test/contract/summary.contract.test.ts`,
      `docs/contract.md`, `src/baseline/fingerprint.ts`
    - model: opus (the core of multi-target mode)
75. [x] fix(artifacts): delete only checkride's own files from a dropped target's directory, **done when:** for a target the previous summary listed and the config dropped, a run deletes only the files that summary's checks of the target name (`<slot>.stdout.txt`, `<slot>.stderr.txt`, `<slot>.json` and each `output_file`), then the directory once nothing else is in it ([D57 (prune-own-files)](#d57)); a test shows a user's file in a folder under `--out` that a target of the same name wrote into survives that target being dropped, while checkride's files there are gone; a crafted slot or `output_file` never reaches outside the directory; `docs/contract.md` and `CHANGELOG.md` say so
    - seam: `src/artifacts/targets.ts`, `src/__tests__/artifacts.test.ts`,
      `test/contract/targets.contract.test.ts`, `docs/contract.md`, `CHANGELOG.md`
    - model: sonnet (a narrower delete, held by the existing prune tests)
28. [x] feat(run): never overlap checks that share a lock key, **done when:** checks whose resolved `lock` keys are equal never run at once, and a wait doesn't count against the timeout (F4 and F5, with a fake spawner that records intervals)
    - seam: `src/orchestrator/execute.ts`, `src/orchestrator/__tests__/orchestrator.test.ts`
    - model: sonnet
29. [x] feat(changed): skip unaffected targets under --changed, **done when:** changed paths come from the resolved base's merge base (R10.2); unaffected targets' checks skip with `no changes under <root>`; repo-scope checks still run; with no git or no base nothing is skipped and stderr warns (S10, F19)
    - seam: `src/targets/changed.ts`, `src/git.ts`, `src/orchestrator/select.ts`
    - model: sonnet
30. [x] feat(launch): resolve tools through mise and PATH and record the pin, **done when:** the launcher walks each pack's chain per R6.2, with mise's auto-install switched off; `requirePins` fails an unpinned tool with the `mise use` hint; every spawned check records `pin_source`, and `tool_version` when R6.3 finds one; F11 and F12 pass; `docs/packs.md` records each R6.4 variable name as verified against the pinned tool
    - seam: `src/launch/`, `src/orchestrator/spawn.ts`, `schema/checkride.summary.schema.json`,
      `test/contract/summary.contract.test.ts`, `docs/contract.md`, `docs/packs.md`
    - model: opus (no fall-through is the pin model's whole point)
31. [x] feat(packs): add the bash pack with file lists, **done when:** a `bash` target runs shellcheck (`lint`) and shfmt (opt-in `format`) over `{files}` built per R11.2; zero matches skip with `no files matched` (F10); an argv over 200,000 bytes exits 2
    - seam: `src/packs/bash.ts`, `src/targets/files.ts`, `src/launch/`
    - model: sonnet
32. [x] feat(packs): give repo-scope slots Node-free alternates, **done when:** outside implicit `ts` mode the repo pack's chain is `[js-lockfile, mise, path]`, so rumdl, typos and the vale and ast-grep binaries resolve through it; implicit `ts` mode still resolves `[js-lockfile]` only, and the invariance golden is unchanged
    - seam: `src/packs/repo.ts`, `src/packs/tools.ts`
    - model: sonnet
33. [x] feat(unclaimed): fail when a toolchain marker sits outside every target, **done when:** in multi-target mode `unclaimed` reports every R11.3 marker no target claims, writes `<out>/unclaimed.json` with a suggested target, honors `unclaimed.ignore`, and passes on a fully claimed repo (F9); outside multi-target mode `unclaimed` is absent from `checks`, and `--only unclaimed` records one skipped entry with its reason ([D53 (inactive-slots)](#d53))
    - seam: `src/targets/unclaimed.ts`, `src/packs/repo.ts`
    - model: sonnet
34. [x] feat(doctor): report the mode, targets, pin sources and unpinned tools, **done when:** `doctor` and `doctor --json` print the mode, a targets table, each tool's pin source, unpinned tools (warnings, or exit 1 under `requirePins`) and unclaimed markers; in implicit `ts` mode `doctor` hints at other packs' markers it sees
    - seam: `src/doctor.ts`, `src/__tests__/doctor.test.ts`
    - model: sonnet
35. [x] feat(entry): resolve the entry command for the stanza, hooks and skills, **done when:** the entry command resolves per R6.6, an `npm:checkride` or `github:robmclarty/checkride` key counting as declaring checkride ([D46 (checkride-pin)](#d46)); the AGENTS.md stanza, the generated hook scripts and the plugin skills use it; a fixture with no `package.json` gets `mise exec -- checkride` or `checkride`; `doctor` reports `harness unpinned` for the `PATH` case
    - seam: `src/launch/entry.ts`, `src/init.ts`, `src/agent-setup/`, `skills/`, `src/doctor.ts`
    - model: sonnet
36. [x] feat(cli): add target add to declare and convert targets, **done when:** `checkride target add` works per R7.4; converting an implicit repo names its target (default `app`), lifts top-level target-scope entries, rewrites baseline keys and prints each change (S11, F22); `--dry-run` writes nothing
    - seam: `src/targets/add.ts`, `src/cli.ts`, `src/baseline/store.ts`
    - model: opus (the conversion rewrites three files consistently)
37. [x] feat(init): discover targets in existing mode, **done when:** existing-mode `init` runs R11.4's discovery and, when it finds more than one pack or a marker below the root, prints the proposed `targets` block and writes it unless `--dry-run`; a single root pack stays implicit
    - seam: `src/targets/discover.ts`, `src/init.ts`
    - model: sonnet
38. [x] feat(readers): teach digest, triage and qa target directories and jsonl, **done when:** the digest, `triage` and `qa` read `<out>/<target>/` and `.jsonl` artifacts, and their reports name `<target>:<slot>` checks; the plugin readers' e2e passes
    - seam: `src/digest/`, `src/triage/`, `src/qa/`, `test/e2e/plugin-readers.e2e.test.ts`
    - model: sonnet
39. [x] test(examples): add polyglot-ts-bash with plants, **done when:** `examples/polyglot-ts-bash` (a TypeScript app and bash scripts as targets) is green, and each plant fails the expected check: an SC2086 fails `scripts:lint`, a type error fails `web:types`, and a new `tools/x/package.json` fails `unclaimed`; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `examples/polyglot-ts-bash/`, `test/e2e/examples.e2e.test.ts`, `docs/targets.md`
    - model: sonnet

### Phase 7: Go and Rust

40. [x] feat(capture): add jsonl capture and the failOnOutput verdict, **done when:** capture follows R11.1 (json, then jsonl, then text, with no bytes changed), a custom check without an `outputFile` that prints JSON lines still writes `<name>.stdout.txt` ([D45 (capture-gate)](#d45)), and a `failOnOutput` adapter that exits 0 with stdout is `ok: false` with `exit_code: 0` and a reason (S9, F13, F14)
    - seam: `src/orchestrator/execute.ts`, `src/tool-json.ts`, `src/artifacts/raw.ts`
    - model: sonnet
41. [x] feat(launch): pin Go tools by tool directive and harden the Go env, **done when:** the `go-mod-tool` source reads single-line and block `tool` directives and runs `go tool <bin>`; the go pack's environment applies R6.4, leaving `GOFLAGS` alone ([D54 (go-mod-readonly)](#d54)); F1 and F2 pass, and a vendored-module fixture passes with an empty module cache
    - seam: `src/launch/go-mod.ts`, `src/launch/env.ts`
    - model: sonnet
42. [x] feat(packs): add the go pack, **done when:** a `go` target runs `go-build`, `gofmt` (opt-in), `golangci-lint` or `staticcheck`, `deadcode`, `go-test` and `govulncheck` (opt-in) per R5.5, with `{go-packages}` expanding per `go.work`; golangci-lint runs never overlap; the Go plants in S4 fail as expected
    - seam: `src/packs/go.ts`, `src/packs/tools.ts`, `src/launch/`
    - model: opus (each tool's real flags and JSON must be verified at the pinned versions)
43. [x] feat(changed): narrow Go packages to affected workspace modules, **done when:** under `--changed`, `go-build` and `go-test` expand `{go-packages}` per R10.4 (changed modules plus transitive dependents, read offline); `deadcode` and `govulncheck` never narrow; a `go.work` or `go.mod` change, or an unreadable graph, expands fully; the check records `narrowed`; a six-module fixture covers a leaf change, a shared-module change and every fallback (F33, F34)
    - seam: `src/launch/go-mod.ts`, `src/targets/changed.ts`, `src/packs/go.ts`,
      `schema/checkride.summary.schema.json`, `docs/packs.md`
    - model: opus (transitive dependents and the fallbacks are where it goes wrong)
44. [x] feat(launch): pin Rust by rust-toolchain and harden the cargo env, **done when:** the `rust-toolchain` source declares rustfmt and clippy when `rust-toolchain.toml` or `rust-toolchain` exists at or above the root; the rust pack's environment applies R6.4; F3 passes
    - seam: `src/launch/`, `src/launch/env.ts`
    - model: sonnet
45. [x] feat(packs): add the rust pack, **done when:** a `rust` target runs every R5.6 adapter with `lock: cargo:{root}`, and S5's plants fail as expected
    - seam: `src/packs/rust.ts`, `src/packs/tools.ts`
    - model: sonnet
46. [x] feat(init): scaffold Go and Rust projects with init --lang, **done when:** `init --lang go --shape module|workspace` and `init --lang rust --shape crate|workspace` write R11.6's shapes with `mise.toml`, `requirePins: true`, a config naming every slot and the dialect rules; the written `mise.toml` pins `npm:checkride` at the package version, with `node` beside it ([D46 (checkride-pin)](#d46)); each shape is green out of the box (e2e); an invalid combination exits 2
    - seam: `src/init.ts`, `templates/go/`, `templates/rust/`, `templates/repo/`,
      `test/e2e/shapes.e2e.test.ts`
    - model: opus (four shapes and six dialect rules, each with fixtures)
47. [x] test(examples): add the Go, Rust and mixed-stack examples, **done when:** `examples/go-module`, `examples/go-workspace`, `examples/rust-workspace` and `examples/polyglot-stack` are green, and every plant in S4 (apart from the `schema` plants, which arrive in Phase 12) and S5 fails with the expected check name; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `examples/`, `test/e2e/examples.e2e.test.ts`
    - model: sonnet

### Phase 8: findings

48. [x] refactor(baseline): derive fingerprints from one parser per format, **done when:** `src/findings/parsers/` holds one parser per format, returning findings with their baseline key and declaring the stream it reads, which the baseline hands it ([D49 (text-findings)](#d49)); `fingerprint()` keys gating findings only; a golden test proves every key in every existing fixture is byte-identical, apart from step 4's deliberate change (F46), and a multi-target fixture's keys match step 27's ([D50 (key-rebasing)](#d50))
    - seam: `src/findings/`, `src/baseline/fingerprint.ts`, `src/baseline/fallow.ts`,
      `src/__tests__/baseline-fingerprint.test.ts`, `src/orchestrator/execute.ts`,
      `src/baseline-command.ts`
    - model: opus (byte-identical keys across a refactor)
49. [x] feat(findings): export parseFindings with severity, gates and slot, **done when:** `checkride/findings` exports R12.1's API, with `findingsFor` opening the check's own artifact from the run directory ([D49 (text-findings)](#d49)); findings carry 1-based lines, verbatim `severity`, `gates` per R12.3 and the slot; an unsupported adapter returns `null` (F45); `package.json` exports the subpath; rule A6 holds; `exports.contract.test.ts` and `docs/contract.md` cover it
    - seam: `src/findings/index.ts`, `package.json`, `test/contract/exports.contract.test.ts`,
      `docs/contract.md`, `CHANGELOG.md`
    - model: opus (a new public surface)
50. [x] feat(findings): parse Go, Rust and shell tool output with path rebasing, **done when:** golangci-lint, staticcheck, clippy, cargo-check and shellcheck parse real fixtures; paths rebase to repo-root-relative per R12.4; the lint parsers feed the baseline, and cargo-check doesn't
    - seam: `src/findings/parsers/`, `src/__tests__/fixtures/`
    - model: sonnet (one parser per format, against real fixtures)
51. [x] feat(findings): parse docs, spell and type-checker output, **done when:** markdownlint-cli2, rumdl, typos, tsc and `go build -json` parse real fixtures; the docs and spell parsers feed the baseline, and the type-checker parsers don't ([D31 (types-parse-only)](#d31), [D32 (docs-baselined)](#d32)); markdownlint-cli2's parser reads stderr, and a repo adopted with `init --baseline` grandfathers its markdown findings ([D49 (text-findings)](#d49))
    - seam: `src/findings/parsers/`, `src/__tests__/fixtures/`, `CHANGELOG.md`
    - model: sonnet
76. [x] feat(config): pick the implicit pack from the root's markers, **done when:** with no `targets` and no `--discover`, the implicit target's pack follows R2.1, in its order, among the packs that ship: a root `package.json` or `tsconfig.json` picks `ts` exactly as 0.13 did, held by the invariance golden ([C2 (legacy-invariance)](#c2)), a root `go.mod` or `go.work` picks `go` and a root `Cargo.toml` picks `rust`, and nothing picks `ts`; a root Go module with no config runs the go pack's checks under their bare slot names, and its summary records `pack` ([D66 (implicit-pack)](#d66)); `init` in a directory with no `package.json` but another shipped pack's root marker runs existing mode; `doctor` names the implicit pack; `docs/targets.md` and `CHANGELOG.md` say so
    - seam: `src/targets/resolve.ts`, `src/config.ts`, `src/init.ts`, `src/doctor.ts`,
      `docs/targets.md`
    - model: opus (0.13's invariance, and every caller that reads the implicit target)
52. [x] test(examples): adopt a Go repo with --baseline and ratchet it, **done when:** a Go version of `examples/existing-repo-baseline` adopts with `init --baseline`, masks its grandfathered findings, fails on a new one, and ratchets a fixed one away; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `examples/`, `test/e2e/existing.e2e.test.ts`
    - model: sonnet

### Phase 9: consumer mode

53. [x] feat(config): layer a defaults file below detection with --defaults, **done when:** `--defaults` and `CHECKRIDE_DEFAULTS` load a config per R13.1 that fills only the slots the repo's config and detection leave unresolved, with `origin: "defaults"` and a `[defaults]` suffix; a repo-detected adapter beats a default (F35); a defaults file with `targets` exits 2 (F36); the summary records the file as `run.defaults`, and its `docs/contract.md` row drops "no such flag yet" ([D55 (run-fields-ahead)](#d55)); the gate strips the variable
    - seam: `src/config.ts`, `src/cli.ts`, `src/orchestrator/report.ts`, `src/gate.ts`,
      `src/orchestrator/run.ts`, `schema/checkride.summary.schema.json`, `docs/contract.md`
    - model: opus (a new resolution layer)
54. [x] feat(run): discover targets at run time with --discover, **done when:** `--discover` applies R11.4's proposed targets in memory per R13.2, lifting top-level entries as `target add` does; it exits 2 when the config already declares `targets` (F37); summary `targets` entries carry `discovered: true`; the summary records `run.discover`, and its `docs/contract.md` row drops "no such flag yet" ([D55 (run-fields-ahead)](#d55)); discovery proposes go and rust targets by R11.4's rules, and a lone root target counts as implicit only when its pack is the root's R2.1 pack ([D68 (discover-go-rust)](#d68)); nothing is written
    - seam: `src/targets/discover.ts`, `src/targets/add.ts`, `src/cli.ts`,
      `src/orchestrator/run.ts`, `docs/contract.md`
    - model: sonnet (reuses discovery and the conversion)
55. [x] feat(launch): let an outside mise.toml override pins with --pins, **done when:** `--pins` and `CHECKRIDE_PINS` read the file's `[tools]` versions and put an `override` source first in every chain, run as `mise exec <id>@<version> -- <bin>` with auto-install off (R13.3); such checks record `pin_source: "override"`; the summary records the file as `run.pins`, and its `docs/contract.md` row drops "no such flag yet" ([D55 (run-fields-ahead)](#d55)); an uninstalled version fails naming the tool (F38); the gate strips the variable
    - seam: `src/launch/mise.ts`, `src/launch/resolve.ts`, `src/cli.ts`, `src/gate.ts`,
      `src/orchestrator/run.ts`, `docs/contract.md`
    - model: sonnet
56. [x] feat(select): keep only checks that need no install with --static-only, **done when:** adapters carry `static`, `nonStaticArgs`, `codeConfigs` and `codeKeys` per R13.4; `--static-only` keeps a check only per [D26 (static-only)](#d26) and skips the rest with a `static-only:` reason; the summary records `run.static_only`, and its `docs/contract.md` row drops "no such flag yet"; `--static-only` joins `isPartialRun`, so `run.partial` is true and the ratchet stands down, and the `partial` row says so ([D55 (run-fields-ahead)](#d55)); F39 and F40 pass; the docs call it a selector, not a sandbox
    - seam: `src/packs/`, `src/packs/static.ts`, `src/orchestrator/select.ts`, `src/cli.ts`,
      `src/orchestrator/run.ts`, `docs/contract.md`
    - model: opus (the sniffs decide what a pre-sandbox run touches)
57. [x] docs(consumers): document running checkride from outside a repo, **done when:** `docs/consumers.md` gives R13.6's recipes and the findings walk-through and says plainly that nothing in it is a sandbox; an e2e case runs the pre-sandbox recipe over an uninstalled `polyglot-stack` copy and the sandbox recipe over an installed one, and parses every finding with `findingsFor`, text-output checks included (S18); the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `docs/consumers.md`, `docs/README.md`, `test/e2e/consumers.e2e.test.ts`
    - model: sonnet
77. [x] test(mutation): let a full stryker run start from its sandbox, **done when:** an unscoped `pnpm mutation` passes its dry run and reports a score at or above `stryker.config.mjs`'s break threshold ([C12 (quality-floors)](#c12)), through a vitest config of stryker's own that leaves out the tests reading the repo's git state, which `pnpm check` still runs ([D72 (mutation-sandbox)](#d72)); the mutation canary stays green
    - seam: `stryker.config.mjs`, `vitest.stryker.config.ts`, `vitest.config.ts`
    - model: sonnet
78. [x] feat(run): let --discover stand down where the config declares targets, **done when:** `--discover` over a config that declares `targets`, run or `doctor`, checks those targets with one stderr note naming them as the reason, records `run.discover` with no target marked `discovered`, and never ratchets, in place of F37's exit 2 ([D73 (discover-stands-down)](#d73)); `docs/consumers.md`'s recipes pass `--discover` unconditionally, as R13.6 writes them, and `test/e2e/consumers.e2e.test.ts` drops its conditional and runs green; `docs/contract.md`, the cheatsheet and `CHANGELOG.md` say so
    - seam: `src/targets/discover.ts`, `src/orchestrator/run.ts`, `src/cli.ts`, `docs/contract.md`,
      `docs/consumers.md`, `test/e2e/consumers.e2e.test.ts`
    - model: sonnet

### Phase 10: Python

58. [x] feat(launch): resolve Python tools from uv.lock and the project venv, **done when:** the `uv-lock` source declares a tool that `uv.lock` lists and runs it from `<root>/.venv/bin/` (or `$UV_PROJECT_ENVIRONMENT/bin/`); a missing venv fails naming `uv sync` (F41); the python pack's environment applies R6.4
    - seam: `src/launch/uv.ts`, `src/launch/env.ts`
    - model: sonnet
59. [x] feat(packs): add the python pack, **done when:** a `python` target runs ruff (`lint`, opt-in `format`), mypy or basedpyright (`types`) and pytest (`test`) per R5.7, detected by config files, `[tool.*]` tables or pins; `unclaimed` and discovery know its markers; pytest's exit 5 fails the check (F44); `target add --lang python --add lint,types` scaffolds the blessed configs
    - seam: `src/packs/python.ts`, `src/packs/tools.ts`, `src/targets/`, `templates/python/`
    - model: opus (each tool's JSON flags must be verified at the pinned versions)
60. [x] feat(findings): parse ruff, mypy and basedpyright output, **done when:** all three parse real fixtures, ruff feeds the baseline, and the type checkers don't
    - seam: `src/findings/parsers/`, `src/__tests__/fixtures/`
    - model: sonnet
61. [ ] test(examples): move examples/polyglot onto the python pack, **done when:** `examples/python-project` (formerly `examples/polyglot`) runs on the python pack and keeps one custom check to show that route; plants for ruff, mypy and pytest fail as expected (S19); every link to the old path is updated; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `examples/polyglot/`, `examples/python-project/`, `test/e2e/examples.e2e.test.ts`,
      `README.md`, `docs/`
    - model: sonnet

### Phase 11: Terraform

62. [ ] feat(launch): pin terraform or tofu by version file and harden its env, **done when:** `.terraform-version` or `.opentofu-version` declares the CLI; an exact version is checked before the run, and a mismatch fails naming the required one; the terraform pack's environment applies R6.4
    - seam: `src/launch/terraform.ts`, `src/launch/env.ts`
    - model: sonnet
63. [ ] feat(packs): add the terraform pack, **done when:** a `terraform` target runs `terraform fmt` (opt-in), tflint, `terraform validate` and trivy config (opt-in) per R5.8; validate fails naming `terraform init -backend=false` when `.terraform/` is missing (F42) and skips where no lock file marks a root module; `.tf` files feed `unclaimed` (F43) and discovery
    - seam: `src/packs/terraform.ts`, `src/packs/tools.ts`, `src/targets/`,
      `templates/terraform/`
    - model: opus (tflint's and trivy's flags and exit codes must be verified at the pinned versions)
64. [ ] feat(findings): parse tflint, terraform validate and trivy output, **done when:** all three parse real fixtures; tflint feeds the baseline, and validate and trivy don't
    - seam: `src/findings/parsers/`, `src/__tests__/fixtures/`
    - model: sonnet
65. [ ] test(examples): add terraform-roots with plants, **done when:** `examples/terraform-roots` (two root modules and a shared `modules/` target, with providers its setup can fetch) is green, and an unformatted file, a tflint violation, an invalid reference and an unclaimed `.tf` directory each fail the expected check (S20); the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `examples/terraform-roots/`, `test/e2e/examples.e2e.test.ts`
    - model: sonnet

### Phase 12: the schema slot

66. [ ] feat(schema): validate data files against JSON Schemas, **done when:** the repo-scope `schema` slot runs per R11.5, with `ajv`, `yaml` and `jsonc-parser` exact-pinned and lazy-loaded; a rule matching zero files fails, and so does a remote `$ref`; `<out>/schema.json` carries the errors (F15, F16, F21); without `schemas` the slot is absent from `checks` ([D53 (inactive-slots)](#d53))
    - seam: `src/validate/`, `src/packs/repo.ts`, `package.json`,
      `schema/checkride.config.schema.json`
    - model: opus (three parsers and two schema drafts)
67. [ ] feat(schema): bundle the agent-skill and checkride-config schemas, **done when:** `checkride:agent-skill` enforces R11.5's rules, including the name-matches-directory check, with its source recorded in `$comment`; `checkride:checkride-config` validates config files; S4's `schema` plants fail as expected
    - seam: `src/validate/bundled.ts`, `schema/agent-skill.schema.json`,
      `examples/polyglot-stack/`
    - model: sonnet
68. [ ] feat(findings): parse the schema slot's report, **done when:** `schema` findings parse from `<out>/schema.json` and feed the baseline; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `src/findings/parsers/`
    - model: sonnet

### Phase 13: the standalone binary

69. [ ] build(sea): build a standalone binary with Node SEA, **done when:** `pnpm build:sea` bundles `dist/cli.js` with esbuild and embeds `templates/`, `schema/` and `skills/` as assets read through `src/resources.ts`; the host binary's `checkride doctor` prints `channel: binary`; an `extends` naming a package fails per F20
    - seam: `build/sea/`, `package.json`, `src/resources.ts`, `src/doctor.ts`, `src/config.ts`
    - model: opus (SEA asset plumbing)
70. [ ] test(e2e): run the e2e suite against the binary, **done when:** `CHECKRIDE_BIN=<binary> pnpm test:e2e` passes on the host, and CI runs it on linux-x64 and macOS arm64 (S12)
    - seam: `test/e2e/`, `.github/workflows/ci.yml`
    - model: sonnet
71. [ ] ci(release): publish binaries with checksums and attestations, **done when:** the release workflow builds R14.3's four tarballs on native runners, signs ad hoc on macOS, writes `SHA256SUMS`, attests provenance, and asserts that the npm version, the tag and the compiled version are equal; actionlint passes
    - seam: `.github/workflows/release.yaml`, `build/sea/`
    - model: sonnet
72. [ ] docs(distribution): document the binary, mise and Homebrew channels, **done when:** `docs/distribution.md` covers each channel (R14.2), mise's `github:` backend as the pin for repos without Node, and checking checksums, and it says the Homebrew tap and the first binary release are manual steps after this build; it describes the switch from `npm:checkride` to `github:robmclarty/checkride` for repos that want no Node ([D46 (checkride-pin)](#d46)); the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `docs/distribution.md`, `README.md`, `docs/getting-started.md`
    - model: sonnet

### Phase 14: close-out

73. [ ] docs: document packs and targets and fold in the contract, **done when:** `docs/packs.md` and `docs/targets.md` cover every pack, slot, pin source and environment variable; the README slot table gains a scope column; `docs/contract.md` names every surface this build added; docs-currency tests hold the pack tables against `PACKS`
    - seam: `docs/packs.md`, `docs/targets.md`, `docs/contract.md`, `README.md`,
      `test/docs-currency.test.ts`
    - model: sonnet
74. [ ] chore: retire the drafts and run the opt-in audit, **done when:** the slot provenance draft's status line points here as superseded; this spec's status reads implemented; `pnpm check --include security` has run and the build report records its result; the build report lists each request in #6 and #7 beside the step that shipped it, ready to paste as a closing comment; the whole `pnpm test:e2e` is green ([D52 (e2e-cadence)](#d52))
    - seam: `docs/spec-slot-provenance.md`, `docs/spec-polyglot.md`
    - model: sonnet

<!-- markdownlint-enable MD029 -->

## Build order

*(Step 20 builds first, per [D51 (golden-placement)](#d51), and the rest follow in document
order. `plumbbob order` maintains the line below; it isn't edited by hand.)*

77, 78, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74

## Ranges

*(Proposed 2026-10-16 at step 29's boundary, for the maintainer to approve or trim. Advice, the
way a `model:` line is, never a gate.)*

A range like `/plumbbob:build 31-39` is a bounded `--auto`. Each step lands on its own when the
check is green and the self-review finds no done-when, Decision or Constraint mismatch, and the
top step lands before the range hands back. It stops early on a red check, a mismatch, a bound
agent's `blocked` or `drift`, or a call the plan hasn't made. A seam stray doesn't stop it, and
neither does a phase end: the whole `pnpm test:e2e` that [D52 (e2e-cadence)](#d52) asks of a
phase's last step still runs inside the range.

Nothing caps a range's length. `/plumbbob:build 30-74` is legal and would stop by itself at the
first trouble. What makes a range useful is ending it where a human call is due, and only four
remain: the pin model at step 30, the calls parked for steps 30, 38, 45 and 53 (leans below),
[Q1 (scope-cut)](#q1)'s cut call after step 65, and step 70's CI clause, which no range can
prove without a push. With the leans approved, all 45 remaining steps run in one bare build and
five ranges:

| Run | Steps | Stops after | Why it stops there |
| --- | --- | --- | --- |
| `/plumbbob:build 30` | 1 | step 30, at the pause | every pack after it resolves tools through this chain ([D12 (pin-chain)](#d12)), and `pin_source` becomes a contract field, so read it before anything leans on it |
| `/plumbbob:build 31-39` | 9 | Phase 6 | a phase end and release point, with step 39's example proving step 30's chain through mise |
| `/plumbbob:build 40-47` | 8 | Phase 7 | a phase end and release point |
| `/plumbbob:build 48-57` | 10 | Phase 9 | the review agent's findings and consumer mode are whole, and step 57's e2e parses every finding through step 49's new surface; stop at 52 instead to release findings on their own |
| `/plumbbob:build 58-65` | 8 | Phase 11 | [Q1 (scope-cut)](#q1)'s cut call is due |
| `/plumbbob:build 66-74` | 9 | the plan's end | nothing; if Q1 cuts Phases 12 and 13, `/plumbbob:refine` the cut and run `73-74` instead |

What each range should watch for:

- **31 to 39.** Step 36 (opus) rewrites the config and the baseline keys together, and its S11
  and F22 tests hold it. Steps 35, 36 and 39 carry harvested tangents whose leans are already
  written (retiring `src/pm/`, reserving `doc-snippets`, the mise step in `publish.yaml`); they
  only add seam strays.
- **40 to 47.** Steps 42 and 46 check real flags and JSON at the pinned versions, and test setup
  downloads Go modules and crates, which [C4 (no-network)](#c4) allows, so keep the network up.
  Step 45 needs the `cargo:global` lean.
- **48 to 57.** Step 48's byte-identical golden holds the refactor. Step 53 needs both of its
  leans, and step 56 follows R13.4's table, so neither should have to stop to ask.
- **58 to 65.** `uv sync` and `tofu init` fetch wheels and providers in test setup, so keep the
  network up.
- **66 to 74.** Step 66 adds `ajv`, `yaml` and `jsonc-parser`. The global pnpm config on this
  machine refuses releases under 48 hours old, so exact-pin versions older than that, or the
  install fails and the range stops. If SEA fails step 69's e2e, [D39 (sea-binary)](#d39) already settles the switch to
  `bun build --compile`. Step 70 needs its CI clause read as below. Step 74's audit needs the
  network, and it records whatever the day's advisory feed says.

**Leans to settle before the ranges.** Each one is a call parked for a step in a range that
would otherwise stop there to ask. Once approved, each folds into Decisions as D67 onward and
amends its step, the way D55 to D57 did, so the building agent reads it where it reads every
other call.

- **Step 30, built-in helpers.** *Folded at step 30's harvest as
  [D60 (builtins-unpinned)](#d60).*
- **Step 30, `checkride fix`.** *Folded at step 30's harvest as [D58 (fix-same-chain)](#d58).*
- **Step 30, a target's own package manager.** *Folded at step 30's harvest as
  [D59 (nearest-pm)](#d59).*
- **Step 38, `qa` and `mutation.json`.** *Folded at step 39's harvest as
  [D63 (qa-mutation-path)](#d63).*
- **Step 45, `cargo:global`.** *Folded at step 47's harvest as
  [D64 (cargo-target-dir-lock)](#d64).*
- **Step 53, the file a config error names.** *Folded at step 57's harvest as
  [D69 (config-error-file)](#d69).*
- **Step 53, `packs` without targets.** *Folded at step 57's harvest as
  [D70 (implicit-top-over-packs)](#d70).*
- **Step 70, the CI clause.** Amend the done-when to read "`ci.yml` runs it on linux-x64 and
  macOS arm64 (S12), and actionlint passes"; the first green CI run on `main` after the build is
  the proof, *because* only a push can show CI green, a range can't push, and pushing stays your
  call.

**Between ranges.**

- Run `/plumbbob:harvest` once a range lands. No harvest runs between the steps inside a range,
  so parks pile up, and a blocker among them would otherwise reach the next range.
- When a range stops early, settle the step it stopped on, then rerun the range from the step
  after it, for example `/plumbbob:build 35-39`.
- Run every range on Opus. Each one holds at least one opus step, and the sonnet steps have been
  running on Opus already.

## Open questions

- <a id="q1"></a>**Q1 (scope-cut)**: should this build keep Phases 12 and 13, the `schema` slot and the standalone binary? *resolved:* 2026-10-09, keep them, last, and make the real cut call once Phase 11 ships
  - *plain:* the review agent needs neither soon (#6 says so). Together they add three runtime
    dependencies and a release pipeline that only CI can fully prove, and they're the last seven
    steps. Cutting them ships everything else sooner and leaves their design here for a later
    build.
  - *lean:* keep them, last. Every earlier phase is a release point, so stopping after Phase 11
    still leaves a complete polyglot checkride. Cut them at the plan pause if shipping sooner
    matters more.
- <a id="q2"></a>**Q2 (capture-gate)**: does R11.1's json and jsonl capture apply to every check, or only to a check that declares an `outputFile`, as JSON capture does today? *resolved:* 2026-10-09, on its lean, as [D45 (capture-gate)](#d45)
  - *plain:* today a check's stdout is saved as JSON only when the check declares an `outputFile`
    (`src/orchestrator/execute.ts:43`), and custom checks default to `null`
    (`src/config.ts:629`), so a custom check that prints JSON is saved as `<name>.stdout.txt` with
    `output_file: null`. R11.1 sniffs every check's stdout. Read literally, an existing custom
    check that prints JSON or JSON lines (a wrapped `go test -json`, the kind of check the review
    agent's repos run now) gets a new file name and a non-null `output_file` on upgrade. That
    breaks [C2 (legacy-invariance)](#c2) and the "`<slot>.stdout.txt` otherwise" promise in
    `docs/contract.md`, and the step 20 golden can't catch it, because every example's custom
    check prints plain text.
  - *lean:* keep the gate. Only a check that declares an `outputFile` gets json or jsonl capture,
    and the declared extension says which (`go-build` declares `types.jsonl`). A custom check
    without one keeps 0.13's text capture whatever it prints, and step 40's done-when gains that
    case.
- <a id="q3"></a>**Q3 (checkride-pin)**: which mise tool id pins checkride itself in a Go or Rust scaffold, when no binary release exists until Phase 13 and Phase 13 may be cut? *resolved:* 2026-10-09, on its lean, as [D46 (checkride-pin)](#d46)
  - *plain:* `init --lang go|rust` (step 46) writes a `mise.toml` that pins checkride (R7.5), and
    from then on the AGENTS.md stanza and the generated hooks run `mise exec -- checkride` (R6.6,
    step 35). The only backend the spec names is `github:robmclarty/checkride` (R14.2), which has
    nothing to install until Phase 13 and a manual release, and [Q1 (scope-cut)](#q1) keeps
    cutting Phase 13 on the table. The shapes e2e runs `node dist/cli.js` directly
    (`test/e2e/shapes.e2e.test.ts`), so a scaffold would test green while its own hooks call a pin
    that mise can't install.
  - *lean:* pin `npm:checkride`, with `node` pinned beside it in the same `mise.toml`, until a
    binary ships. Step 35's entry-command detection accepts either `npm:checkride` or
    `github:robmclarty/checkride` as declaring checkride, step 46's e2e asserts what the written
    `mise.toml` declares, and step 72 documents the switch to `github:` for repos that want no
    Node.
- <a id="q4"></a>**Q4 (consumer-trigger)**: does the `baseline` command write `checkride.baseline.json` when given `--config` or `--out`, and does a `--config` inside the repo make a consumer run? *resolved:* 2026-10-09, on its lean, as [D47 (consumer-trigger)](#d47)
  - *plain:* step 2 gives the `baseline` command `--config`, and R7.2 gives it `--out`, but
    [D22 (consumer-runs-write-nothing)](#d22) says a run naming `--config`, or an `--out` outside
    the repo, never writes `checkride.baseline.json`, and writing that file is all `baseline` does
    (`src/baseline-command.ts`). So the build's second step has to guess between writing anyway,
    refusing, and running without writing. Separately, a repo that keeps its config at another
    path and passes `--config` in its own `scripts.check` would turn its own gate into a consumer
    run that never ratchets.
  - *lean:* two clauses in D22. The `baseline` command is the repo's explicit write, so it writes
    whatever `--config` and `--out` it gets. And `--config` makes a consumer run only when the file
    sits outside the repo, the same test `--out` already uses.
- <a id="q5"></a>**Q5 (out-per-target)**: in multi-target mode, what do `{out}` and the scratch directory resolve to when a check runs from its target root? *resolved:* 2026-10-09, on its lean, as [D48 (out-per-target)](#d48)
  - *plain:* R9 expands `{out}` to `.check` by default, so 0.13's argv doesn't change, and keeps
    scratch at `<repo>/.check/`. Both assume the working directory is the repo root, but
    [D7 (scope)](#d7) runs a target-scope check from its target root. vitest and jest write
    `--outputFile=.check/test.json` today (`src/adapters.ts:324` and `:342`), so a `web` target's
    report would land in `<web root>/.check/test.json` while the summary points at
    `<out>/web/test.json`. An absolute `{out}` would instead have two ts targets overwrite one
    `test.json`. Scratch at `<repo>/.check/` would also resolve modules from the repo root, not
    from a nested target's own `node_modules`.
  - *lean:* `{out}` is the check's own artifact directory: `.check` in implicit mode, as today,
    and the absolute `<out>/<target>` for a target-scope check in multi-target mode, or `<out>`
    for a repo-scope one. Scratch moves to `<target root>/.check/`, which is still `<repo>/.check/`
    in implicit mode. Step 27's done-when gains a case with two ts targets whose vitest reports
    both land where the summary says.
- <a id="q6"></a>**Q6 (text-findings)**: how do the findings API and the baseline reach findings a tool prints as text, sometimes on stderr, when the summary never names a text artifact? *resolved:* 2026-10-09, on its lean, as [D49 (text-findings)](#d49)
  - *plain:* the baseline reads stdout only (`src/orchestrator/execute.ts:114`), and a text-output
    check's summary entry has `output_file: null`. markdownlint-cli2 prints its findings on stderr
    and only a banner on stdout (checked with the installed 0.23.3), so after step 51 a repo
    adopted with `init --baseline` would record `docs: []` and start red, the opposite of what
    [D32 (docs-baselined)](#d32) promises. R13.6's findings recipe skips every check without an
    `output_file`, so tsc, cspell and markdownlint findings never reach the review agent, and the
    Frame's "every finding parsed through `checkride/findings`" can't hold.
  - *lean:* each parser declares the stream it reads (the JSON artifact, stdout or stderr), and
    the baseline hands it that stream instead of always stdout. `findingsFor` takes the run
    directory instead of `raw` and opens the right artifact itself (`output_file`, else
    `<name>.stdout.txt` or `<name>.stderr.txt` in the check's directory), so the recipe drops its
    `output_file` guard. `parseFindings` keeps taking raw text for callers that already hold it.
- <a id="q7"></a>**Q7 (key-rebasing)**: should target-scope baseline keys be rebased to the repo root when targets arrive in Phase 6, rather than with the parsers in Phase 8? *resolved:* 2026-10-09, on its lean, as [D50 (key-rebasing)](#d50)
  - *plain:* baseline keys use each tool's path exactly as printed
    (`src/baseline/fingerprint.ts:76`). From Phase 6 a target-scope check runs from its target
    root, so its keys carry target-relative paths. R12.4 rebases paths to the repo root, but it
    arrives with the parsers in Phase 8. Every phase end is a release, so a repo that adopts
    targets and a baseline on a Phase 6 or 7 release would see its keys change on the Phase 8
    upgrade: every grandfathered finding in a target not rooted at `.` turns red, and the next
    full run prunes the old keys.
  - *lean:* rebase in step 27. The existing extractors join a target-scope check's root onto each
    path before keying, so multi-target keys are repo-root-relative from their first release.
    Step 48 then moves that join into the parsers, and its byte-identical golden gains a
    multi-target fixture.
- <a id="q8"></a>**Q8 (golden-placement)**: where does step 20's invariance golden run, given that its summaries need every example installed, and should it land before the steps that touch argv? *resolved:* 2026-10-09, on its lean, as [D51 (golden-placement)](#d51)
  - *plain:* the golden records each example's and each init shape's checks, argv, output files
    and a summary. Summaries need real tool runs, and an example only runs after `pnpm install` in
    a temp copy, which is why examples live in the e2e suite today
    (`test/e2e/examples.e2e.test.ts`). Step 20's seam puts the golden in `test/contract/`, which
    `pnpm check` runs on every step without installing anything. It also lands after steps 7 and
    10 change how argv is built and after Phase 4 changes what `init` writes, so it records
    whatever those steps left rather than 0.13's behavior.
  - *lean:* split it, and build it first with `plumbbob order 20`. The resolution half (checks,
    order, names, argv and output file names, computed with a fake spawner and no installs) goes
    in `test/contract/`, so `pnpm check` holds it on every step. The summary and exit-code half
    goes in `test/e2e/`, beside `examples.e2e.test.ts`. Phase 4's steps then update the init-shape
    entries on purpose, each in its own diff, and [C2 (legacy-invariance)](#c2) holds "from the
    first step on".
- <a id="q9"></a>**Q9 (e2e-cadence)**: when does the e2e suite run during the build, given that plumbbob's gate runs `pnpm check`, which leaves `test/e2e/` out? *resolved:* 2026-10-09, on its lean, as [D52 (e2e-cadence)](#d52)
  - *plain:* eighteen steps prove themselves with an e2e test or an example run (11, 13 to 15, 18,
    19, 22 to 24, 38, 39, 46, 47, 52, 57, 61, 65 and 70), but `pnpm check` excludes `test/e2e/`
    (`vitest.config.ts`), and this repo's rule is that e2e runs in CI and before any release
    (`vitest.e2e.config.ts`). [D1 (one-build)](#d1) makes every phase end a release point while
    promising only `pnpm check` there, so an e2e regression from step 26 could sit unnoticed until
    step 39, or until a release.
  - *lean:* a step whose done-when names an e2e test runs that file before its checkpoint, and
    each phase's last step runs the whole `pnpm test:e2e`, which a release needs anyway. The
    plumbbob gate stays `pnpm check`, so ordinary steps stay fast.
- <a id="q10"></a>**Q10 (inactive-slots)**: how do the `schema` and `unclaimed` slots appear in a run where they're inactive, and when do their names become reserved? *resolved:* 2026-10-09, on its lean, as [D53 (inactive-slots)](#d53)
  - *plain:* today a catalogue slot that isn't opt-in and finds nothing to run becomes a skipped
    entry in `summary.json`, with "no tool detected for slot" (`src/config.ts:541`). R5.1 adds
    both slots as not opt-in and says when each is active, but not what an inactive one looks
    like. If it's a skipped entry, every existing repo's summary gains two, which breaks
    [C2 (legacy-invariance)](#c2), and the golden would only flag it at step 33. Separately, V2
    forbids a target named after a slot, but `schema` joins `SLOTS` only at step 66, so a target
    named `schema` is valid in the Phase 6 to 11 releases and breaks on the Phase 12 upgrade.
  - *lean:* an inactive `schema` or `unclaimed` is absent from `checks`, the way an unselected
    opt-in slot is today. Both names stay valid tokens, so `--only schema` records one skipped
    entry with its reason instead of exiting 2. V2 reserves both names from step 25.
- <a id="q11"></a>**Q11 (go-mod-readonly)**: should the go pack's spawn environment add `-mod=readonly` to `GOFLAGS` at all? *resolved:* 2026-10-09, on its lean, as [D54 (go-mod-readonly)](#d54)
  - *plain:* since Go 1.16, build commands refuse to rewrite `go.mod`, as if `-mod=readonly` were
    set, unless a `vendor/` directory is present, in which case they default to `-mod=vendor`.
    Setting `-mod=readonly` explicitly changes nothing for a module without `vendor/`, but it
    makes Go ignore `vendor/` where there is one (the Go modules reference says so). A vendored
    module would then need the module cache, and with `GOPROXY=off` every Go check fails offline
    in a repo whose own build works offline today. [C8 (platforms)](#c8) already requires Go 1.24.
  - *lean:* drop the `GOFLAGS` row from R6.4, since Go 1.24's defaults already keep `go.mod`
    unchanged with or without `vendor/`. Step 41's done-when gains a vendored-module fixture that
    passes with an empty module cache.

## Verdicts

- 2026-10-09: [Q2 (capture-gate)](#q2) to [Q11 (go-mod-readonly)](#q11), the holes
  `/plumbbob:refine` found at the plan pause → settled on their leans as
  [D45 (capture-gate)](#d45) to [D54 (go-mod-readonly)](#d54); the decisions, steps and reference
  sections they touch were amended to match, and each amendment cites its Decision.
- 2026-10-09: [Q1 (scope-cut)](#q1) → kept Phases 12 and 13, last, because checkride has zero
  runtime dependencies today and those phases add three, the review agent doesn't need them
  soon, and every earlier phase is a release point; the real cut call comes once Phase 11 ships.
- 2026-10-09: 0.14.0 shipped before the build (tool bumps, the gate fix, the vale patch), so the
  build starts from a release; the spec's line references stay against 0.13.0.
- 2026-10-08: four inputs (the polyglot targets draft, issues #6 and #7, the maintainer's review
  and two queued drafts) → one spec and one build, because a build needs one source of truth
  ([D2 (one-source)](#d2)).

## Before the build

- Start from a clean tree: plumbbob's finish step can commit stray untracked files.
- `security` is opt-in in this repo for now ([C7 (house-style)](#c7)): `pnpm check`, CI and
  plumbbob skip it, and `pnpm check --include security` runs it.
- Install mise (`brew install mise`). Step 24 runs `mise install`, which needs the network once.
- E2e setup downloads Go modules, Python wheels and Terraform providers. Checks never do
  ([C4 (no-network)](#c4)).

All four held on 2026-10-09: the tree was clean, `security` was opt-in, and mise 2026.10 was
installed.

## Source

The source spec's reference sections, as written apart from heading depth and the amendments
that cite D45 to D54. Steps cite them by
number: R for a requirement, V for a validation rule, F for a failure mode, S for a test suite and
A for an architectural rule.

### R1. Vocabulary

| Term | Meaning | Status |
| --- | --- | --- |
| Slot | A role in the pipeline. Language-neutral. | exists |
| Adapter | A concrete tool that fills a slot. | exists |
| Pack | One language's adapters, plus its pin sources, spawn environment, root markers, templates and dialect rules. | new |
| Target | A named (pack, root) pair. Target-scope slots run once per target. | new |
| Scope | `target` or `repo`, declared per slot. | new |
| Pin source | Where a tool's version is declared in the repo. | new (generalizes `node_modules/.bin`) |
| Launcher | Turns an adapter's invocation into argv through a pin source. | new (generalizes `src/pm/`) |
| Entry command | How humans, hooks, the stanza and the skills run checkride in a repo. | new (generalizes `<pm> run check`) |
| Consumer run | A run shaped from outside the repo (R13.5). | new |
| Finding | One parsed diagnostic, served by `checkride/findings`. | new |

### R2. Modes and config

#### R2.1 Modes and the implicit pack

Implicit mode applies when no `targets` is configured and `--discover` is absent. The repo has
one unnamed target at its root, and its pack is the first match:

1. The root has `package.json` or `tsconfig.json`: `ts`. This is 0.13's behavior, including for
   repos that use custom checks for other languages.
2. The root has `go.mod` or `go.work`: `go`.
3. The root has `Cargo.toml`: `rust`.
4. The root has `pyproject.toml`, `setup.cfg` or `setup.py`: `python`.
5. The root has `.terraform.lock.hcl` or a `.tf` file: `terraform`.
6. Otherwise: `ts`, where every slot stands down as it does today.

Implicit mode never selects `bash`. Multi-target mode applies when `targets` is present or
`--discover` is given. Target-scope checks are named `<target>:<slot>`; repo-scope checks and
top-level custom checks keep bare names.

#### R2.2 Config additions

Additive to `CheckrideConfig` in `src/config.ts`:

```ts
type PackName = 'ts' | 'go' | 'rust' | 'bash' | 'python' | 'terraform';

type TargetConfig = Noted & {
  /** The language pack. */
  lang: PackName;
  /** Repo-relative directory. '.' allowed. No '..' segments, not absolute, must exist. */
  root: string;
  /** File-list packs only (bash): globs relative to root. Defaults in R11.2. */
  include?: string[];
  exclude?: string[];
  /** Slot config and target-scoped custom checks for this target. */
  checks?: Record<string, SlotConfig>;
};

/** Slot config applied to every target of one pack (D9). */
type PackConfig = Noted & { checks?: Record<string, SlotConfig> };

type SchemaRule = Noted & {
  files: string[];
  /** A repo-relative path to a JSON Schema file, or a bundled id such as 'checkride:agent-skill'. */
  schema: string;
  /** Default by extension: .json, .jsonc, .yml/.yaml, .md (frontmatter). */
  format?: 'json' | 'jsonc' | 'yaml' | 'frontmatter';
};

type CustomCheck = /* 0.13 fields */ {
  /** The exit code that means "could not run here" (1 to 255): the check records as skipped. */
  skipExitCode?: number;
  /** Defaults layer only: this check reads the repo as data, for --static-only. */
  static?: boolean;
};

type UseConfig = /* 0.13 fields */ {
  /** Defaults layer only, as on CustomCheck. */
  static?: boolean;
};

type CheckrideConfig = /* 0.13 fields */ {
  targets?: Record<string, TargetConfig>;
  packs?: Partial<Record<PackName, PackConfig>>;
  schemas?: SchemaRule[];
  /** When true, a tool resolved from PATH without a pin fails its check. Default false. */
  requirePins?: boolean;
  /** Base ref for --changed, below --base and CHECKRIDE_BASE (R10.1). */
  changedBase?: string;
  unclaimed?: { ignore?: string[] };
};
```

#### R2.3 Validation

Each failure is a config error: exit 2, `invalid checkride.config.json: <reason>` (or the
`--config`, `--defaults` or `--pins` path in place of the file name).

- **V1.** Target names match `^[a-z][a-z0-9-]{0,31}$`.
- **V2.** A target name must not equal a slot name, a top-level custom check name, or another
  target name. `schema` and `unclaimed` count as slot names from step 25 on, before either slot
  exists ([D53 (inactive-slots)](#d53)).
- **V3.** `root` is normalized, repo-relative, an existing directory, not absolute, and free of
  `..` segments.
- **V4.** Two targets of the same pack must not have roots where one is an ancestor of, or equal
  to, the other. Targets of different packs may nest.
- **V5.** `include` and `exclude` are accepted only for file-list packs (`bash`).
- **V6.** In multi-target mode, a top-level `checks` entry keyed by a target-scope slot must be
  `false`, or an object whose keys are limited to `optIn`, `timeout`, `order` and `note`. It
  applies to every target whose pack fills the slot, and `packs` and target entries override it.
  A string or `use` entry at the top level for a target-scope slot is an error whose message names
  `packs.<pack>.checks` and the targets where the entry belongs.
- **V7.** `extends` bases must not contain `targets`.
- **V8.** A `schema` value is a bundled `checkride:<id>` or a repo-relative path; `http://` and
  `https://` values are errors.
- **V9.** `targets: {}` is an error.
- **V10.** `packs` keys are pack names, and each entry names adapters of that pack. Its custom
  checks become target-scoped checks of every target of the pack.
- **V11.** A defaults file and its `extends` chain contain no `targets`.
- **V12.** `skipExitCode` is an integer from 1 to 255 on a `command` entry, and `static` appears
  only in the defaults layer.

### R3. Resolution order

For a target-scope slot S in target T of pack P:

1. `targets.T.checks.S`;
2. `packs.P.checks.S`;
3. top-level `checks.S` (limited by V6 in multi-target mode, unrestricted in implicit mode);
4. detection: P's adapters for S, by `detect`, `detectDeps`, `detectScript`, `detectPin` or
   `detectTable`, relative to T's root;
5. the defaults layer: its `packs.P.checks.S`, then its `checks.S`;
6. skip.

A repo-scope slot runs steps 3, 4, 5 and 6, relative to the repo root. Presets fold into the
repo's config before any of this, and `--config` replaces the file the repo's config comes from.
A custom check from the defaults layer joins only when the repo has no check with that name.
In a repo without `targets`, the top-level `checks` are the implicit target's own entries, so
step 3 ranks above step 2 there, ts roots included ([D70 (implicit-top-over-packs)](#d70)).

### R4. Pack registry

Pack registries are pure data, like `src/adapters.ts` today.

```ts
type Scope = 'target' | 'repo';

type Slot = { name: string; optIn?: boolean; order?: Order; scope: Scope };

type Invocation =
  | { kind: 'tool'; tool: string; args: string[] }      // resolved through the pin chain (R6)
  | { kind: 'go'; args: string[] }                      // the Go toolchain
  | { kind: 'cargo'; args: string[]; plugin?: string }  // cargo; `plugin` names a cargo-<plugin> binary
  | { kind: 'terraform'; args: string[] }               // terraform or tofu, per the version file
  | { kind: 'pm-run'; script: string }                  // ts `build`
  | { kind: 'builtin'; id: string };

type PackAdapter = {
  name: string;
  slot: string;
  description: string;
  detect: string[];                 // relative to the target root (the repo root for repo scope)
  detectDeps?: string[];            // ts and repo packs only
  detectScript?: string;            // ts pack only
  detectPin?: string;               // available when a pin source other than PATH declares this tool
  detectTable?: { file: string; table: string }; // a TOML table header, like [tool.ruff]
  invoke: Invocation;
  fix?: Invocation;
  changedArgs?: string[];           // may hold {base}; args may hold {out}, {files}, {go-packages}
  outputFile: string | null;
  timeout?: number;
  order?: Order;
  failOnOutput?: boolean;           // fail when the tool exits 0 but prints to stdout
  lock?: string;                    // equal resolved keys never overlap; {root} expands
  network?: boolean;                // skips the network-blocking variables (R6.4)
  narrowsUnderChanged?: boolean;    // {go-packages} narrows under --changed (R10.4)
  static: boolean;                  // R13.4
  nonStaticArgs?: string[];         // argv flags that need an install
  codeConfigs?: string[];           // config files that make this adapter run code
  codeKeys?: { file: string; keys: string[] }[]; // config keys that load code
  devDeps?: Record<string, string>; // ts pack only, unchanged
};

type Tool = {
  bin: string;      // executable name
  npm?: string;     // package that provides `bin` (js-lockfile)
  goTool?: string;  // module path for a go.mod `tool` directive
  pypi?: string;    // package name in uv.lock
  mise?: string[];  // accepted mise tool ids
  install: string;  // a human install hint for failure messages
};

type PinSourceName =
  | 'override' | 'js-lockfile' | 'go-mod-tool' | 'rust-toolchain' | 'uv-lock' | 'tf-version' | 'mise' | 'path';

type Pack = {
  name: PackName | 'repo';
  markers: string[];        // root markers; globs allowed ('*.tf')
  pins: PinSourceName[];    // resolution order, after any override
  env: Record<string, string>;
  adapters: readonly PackAdapter[];
  templates: string;        // templates/<pack>/
};
```

`src/packs/tools.ts` holds one `TOOLS` table that describes every external tool once. Adapters
reference tools by `bin`. The public `ADAPTERS` export keeps its 0.13 shape as the union of the
`ts` and `repo` packs.

### R5. Slots and packs

#### R5.1 The slot catalogue

`SLOTS` gains `scope` and two slots appended after `snippets`. Existing positions don't move.

| Slot | Scope | Opt-in | Notes |
| --- | --- | --- | --- |
| `types` `format` `lint` `dead` `dupes` `health` `test` `mutation` `security` `build` `publint` `attw` `pack` `smoke` `snippets` | target | as today | |
| `struct` `docs` `links` `spell` `prose` | repo | as today | |
| `schema` | repo | no | Active only when `schemas` is configured. Inactive, it's absent from `checks` but stays a valid token ([D53 (inactive-slots)](#d53)). |
| `unclaimed` | repo | no | Active only in multi-target mode. Inactive, it's absent from `checks` but stays a valid token ([D53 (inactive-slots)](#d53)). |

#### R5.2 Token grammar

```text
token := <slot> | <custom> | <target> | <target> ':' ( <slot> | <custom> )
```

| Token | Selects |
| --- | --- |
| `lint` (target-scope slot) | That slot in every target whose pack fills it. In implicit mode, the slot. |
| `links` (repo-scope slot) | The repo-scope check. |
| `api` (target name) | Every check of that target. |
| `api:lint` | One check. |
| `licenses` (top-level custom) | That custom check. |

V2 keeps the grammar unambiguous. An unknown token is a usage error (exit 2) that lists the valid
tokens.

#### R5.3 The ts pack

Today's target-scope adapters, unchanged: `tsc`; `prettier` and `biome-format`; `oxlint`, `biome`
and `eslint`; `fallow` and `knip`; `vitest` and `jest`; `stryker`; `pnpm-audit`; `build`;
`publint`; `attw`; `pack`; `smoke`; `snippets` and `snippets-dist`. Markers: `package.json`,
`tsconfig.json`. Pin chain: `[js-lockfile]`, which keeps 0.13's semantics exactly. Within a slot,
the first adapter listed is the blessed default and wins detection, as today, in every pack.

#### R5.4 The repo pack

| Slot | Adapter, blessed first | Detect | Notes |
| --- | --- | --- | --- |
| `struct` | `ast-grep` | `sgconfig.yml`, `sgconfig.yaml` | npm `@ast-grep/cli`, or the `ast-grep` binary. A scaffold for a non-ts pack adds `rules/<pack>/` to `ruleDirs`. |
| `docs` | `markdownlint-cli2`, then `rumdl` | today's markdownlint files; `.rumdl.toml`, `rumdl.toml` | rumdl is a single binary with markdownlint-compatible rule ids. |
| `links` | built-in | always | Unchanged. |
| `spell` | `cspell`, then `typos` | today's cspell files; `_typos.toml`, `typos.toml`, `.typos.toml` | typos matches the slot's "common typos, not unknown words" stance. |
| `prose` | `vale` | `.vale.ini`, `_vale.ini` | npm `@vvago/vale`, or the `vale` binary. |
| `schema` | built-in | `schemas` configured | R11.5. |
| `unclaimed` | built-in | multi-target mode | R11.3. |

Pin chain: `[js-lockfile, mise, path]`, except in implicit `ts` mode, where it's `[js-lockfile]`,
so 0.13 repos resolve exactly as before. When the root has no `package.json`, `init` scaffolds the
Node-free alternates (rumdl, typos, and the vale and ast-grep binaries).

#### R5.5 The go pack

Requires Go 1.24 or later, for the `tool` directive and `go build -json`. Markers: `go.mod`,
`go.work`. Pin chain: `[go-mod-tool, mise, path]`.

| Slot | Adapter | Invocation | Detect | Capture | Notes |
| --- | --- | --- | --- | --- | --- |
| `types` | `go-build` | `go build -o /dev/null -json {go-packages}` | `go.mod`, `go.work` | jsonl | Narrows under `--changed`. Test files compile under `test`. `-o /dev/null` discards the binary a single-main module would write ([D65 (verified-argv)](#d65)). |
| `format` (opt-in) | `gofmt` | `gofmt -l .`, `failOnOutput`; fix: `gofmt -w .` | `go.mod`, `go.work` | txt | Ships with the toolchain. |
| `lint` | `golangci-lint` | tool: `golangci-lint run --output.json.path=stdout --show-stats=false --allow-serial-runners {go-packages}`; fix: `run --fix --allow-serial-runners {go-packages}` | `.golangci.yml`, `.golangci.yaml`, `.golangci.toml`, `.golangci.json` | json | `lock: golangci-lint` across every target. v2 config. Pinned as a binary, not a `go tool`. `--show-stats=false` keeps the tally off stdout, and a `go.work` root's own `./...` misses every `use` module ([D65 (verified-argv)](#d65)). |
| `lint` (alt) | `staticcheck` | tool: `staticcheck -f json {go-packages}` | `detectPin: staticcheck` | jsonl | |
| `dead` | `deadcode` | tool: `deadcode -test {go-packages}`, `failOnOutput` | `detectPin: deadcode` | txt | Whole-program reachability, so it never narrows. |
| `test` | `go-test` | `go test -json {go-packages}` | `go.mod`, `go.work` | jsonl | Narrows under `--changed`. |
| `security` (opt-in) | `govulncheck` | tool: `govulncheck {go-packages}` | `detectPin: govulncheck` | txt | `network: true`. Never narrows. Text mode exits 3 on a called vulnerability; `-format json` exits 0 ([D65 (verified-argv)](#d65)). |

`{go-packages}` expands to `./...` for a module root, and to `./<dir>/...` for each `use`
directive at a `go.work` root. R10.4 narrows it.

#### R5.6 The rust pack

Requires stable Rust 1.85 or later. Marker: `Cargo.toml`. Pin chain:
`[rust-toolchain, mise, path]`. Every adapter that invokes cargo carries `lock: cargo:{root}`.

| Slot | Adapter | Invocation | Detect | Capture | Notes |
| --- | --- | --- | --- | --- | --- |
| `types` | `cargo-check` | `cargo check --workspace --all-targets --message-format=json` | `Cargo.toml` | jsonl | |
| `format` (opt-in) | `rustfmt` | `cargo fmt --all --check`; fix: `cargo fmt --all` | `Cargo.toml` | txt | |
| `lint` | `clippy` | `cargo clippy --workspace --all-targets --message-format=json -- -D warnings`; fix: `cargo clippy --fix --allow-dirty --allow-staged --workspace --all-targets` | `Cargo.toml` | jsonl | Warnings fail the check. |
| `dead` | `cargo-machete` | plugin `machete`: `cargo machete` | `detectPin: cargo-machete` | txt | Unused dependencies. Unused code is rustc's `dead_code` lint, which `lint` fails under `-D warnings`. |
| `test` | `nextest` | plugin `nextest`: `cargo nextest run --workspace --no-fail-fast` | `.config/nextest.toml` | txt | |
| `test` (alt) | `cargo-test` | `cargo test --workspace --no-fail-fast` | `Cargo.toml` | txt | |
| `snippets` (opt-in) | `cargo-doctest` | `cargo test --doc --workspace` | `Cargo.toml` | txt | nextest doesn't run doctests, so Rust scaffolds name this slot, which opts it in. |
| `security` (opt-in) | `cargo-deny` | plugin `deny`: `cargo deny --format json check` | `deny.toml` | txt | `network: true`. Its JSON lines go to stderr, so they land in `security.stderr.txt` ([D65 (verified-argv)](#d65)). |
| `mutation` (opt-in) | `cargo-mutants` | plugin `mutants`: `cargo mutants --output {out}` | `detectPin: cargo-mutants` | tool-written | Order `single`, as `stryker` is today. `--output` puts `mutants.out/` in the check's artifact directory, not the source tree ([D65 (verified-argv)](#d65)). |

#### R5.7 The python pack

Markers: `pyproject.toml`, `setup.cfg`, `setup.py`. Pin chain: `[uv-lock, mise, path]`. The table's
`[tool.*]` entries are `detectTable` lookups in `pyproject.toml`.

| Slot | Adapter | Invocation | Detect | Capture | Notes |
| --- | --- | --- | --- | --- | --- |
| `lint` | `ruff` | tool: `ruff check --output-format=json .`; fix: `ruff check --fix .` | `ruff.toml`, `.ruff.toml`, `[tool.ruff]`, or `detectPin: ruff` | json | |
| `format` (opt-in) | `ruff-format` | tool: `ruff format --check .`; fix: `ruff format .` | as `ruff` | txt | |
| `types` | `mypy` | tool: `mypy --output json .` | `mypy.ini`, `.mypy.ini`, `[tool.mypy]`, or `detectPin: mypy` | jsonl | Needs the synced venv. `--output json` needs mypy 1.11 or later. |
| `types` (alt) | `basedpyright` | tool: `basedpyright --outputjson` | `pyrightconfig.json`, `[tool.basedpyright]`, `[tool.pyright]`, or `detectPin: basedpyright` | json | Bundles its own Node. Never the PyPI `pyright` wrapper, which downloads Node on first run. |
| `test` | `pytest` | tool: `pytest -q` | `pytest.ini`, `[tool.pytest.ini_options]`, `conftest.py`, or `detectPin: pytest` | txt | Exit 5 (no tests collected) fails the check. |

#### R5.8 The terraform pack

Markers: `.terraform.lock.hcl` and every `*.tf` file. Pin chain: `[tf-version, mise, path]`. The
`terraform` invocation runs `tofu` when `.opentofu-version` exists or mise declares `opentofu`,
and `terraform` otherwise.

| Slot | Adapter | Invocation | Detect | Capture | Notes |
| --- | --- | --- | --- | --- | --- |
| `format` (opt-in) | `terraform-fmt` | `fmt -check -recursive -diff`; fix: `fmt -recursive` | none: always available in a terraform target | txt | |
| `lint` | `tflint` | tool: `tflint --recursive --format=json` | `.tflint.hcl`, or `detectPin: tflint` | json | Plugin rulesets need `tflint --init` beforehand. |
| `types` | `terraform-validate` | `validate -json` | `.terraform.lock.hcl` | json | Fails naming `terraform init -backend=false` when `.terraform/` is missing. Skipped where no lock file marks a root module. |
| `security` (opt-in) | `trivy-config` | tool: `trivy config --format json --exit-code 1 --skip-check-update .` | `detectPin: trivy` | json | Uses trivy's embedded checks, so it makes no network call. |

#### R5.9 The bash pack

No markers: bash targets are declared or discovered. Pin chain: `[mise, path]`. File list: R11.2.

| Slot | Adapter | Invocation | Detect | Capture |
| --- | --- | --- | --- | --- |
| `lint` | `shellcheck` | tool: `shellcheck -f json1 {files}` | `.shellcheckrc`, or `detectPin: shellcheck` | json |
| `format` (opt-in) | `shfmt` | tool: `shfmt -d {files}`; fix: `shfmt -w {files}` | `detectPin: shfmt` | txt |

### R6. Pins, launch and environment

#### R6.1 Pin sources

| Source | Declares a tool when | Runs it as |
| --- | --- | --- |
| `override` | the `--pins` file's `[tools]` has a key in `Tool.mise` | `mise exec <id>@<version> -- <bin>` |
| `js-lockfile` | `Tool.npm` is in the nearest `package.json` at or above the working directory, up to the repo root | 0.13's `<pm> exec`, `node_modules/.bin` lookup and Yarn PnP handling |
| `go-mod-tool` | the target's `go.mod` has a `tool` directive for `Tool.goTool`, or, at a `go.work` root with no `go.mod` up to the repo root, a module the workspace uses does ([D65 (verified-argv)](#d65)) | `go tool <bin>` |
| `rust-toolchain` | `rust-toolchain.toml` or `rust-toolchain` exists at or above the root (the rustup components only: `cargo`, rustfmt and clippy), and `rustup` is on `PATH`, else the check fails ([D65 (verified-argv)](#d65)) | `cargo`, `cargo fmt`, `cargo clippy` through rustup's `cargo` |
| `uv-lock` | `uv.lock` lists `Tool.pypi` | `<root>/.venv/bin/<bin>`, or `$UV_PROJECT_ENVIRONMENT/bin/<bin>` |
| `tf-version` | `.terraform-version` or `.opentofu-version` exists at or above the root (the CLI only) | `terraform` or `tofu` from `PATH`, version-checked |
| `mise` | a `mise.toml` or `.mise.toml` from the working directory up to the repo root has a `[tools]` key in `Tool.mise` | `mise exec -- <bin>` |
| `path` | nothing else declares it | `<bin>` from `PATH` |

Chains: `ts` is `[js-lockfile]`; `repo` is `[js-lockfile]` in implicit `ts` mode and
`[js-lockfile, mise, path]` otherwise; `bash` is `[mise, path]`; `go` is
`[go-mod-tool, mise, path]`; `rust` is `[rust-toolchain, mise, path]`; `python` is
`[uv-lock, mise, path]`; `terraform` is `[tf-version, mise, path]`. Under `--pins`, every chain
starts with `override`.

The mise scanner in `src/launch/mise.ts` reads keys only for repo pins, since mise owns version
resolution. For `--pins` it also reads versions: a string, or an inline table's `version`.

#### R6.2 Resolution

1. **Declared.** For each source in the chain, in order, check whether it declares the tool.
2. **The first declaring source wins, with no fall-through.** If that source can't run the tool
   (mise isn't installed, the npm binary is missing, the venv is missing), the check fails with
   exit 1, naming the source and `Tool.install`. A declared pin is an input to the verdict, and
   substituting another copy would make the verdict depend on the machine. Under
   `--static-only`, this case skips the check with `static-only: needs an install (<detail>)`
   instead.
3. **Undeclared, with `path` in the chain.** Look the binary up on `PATH`. If found, run it and
   record `pin_source: "path"`. Under `requirePins`, fail instead with
   `<tool> is not pinned; pin it with: mise use <id>@<version>`. If not found, fail with
   `Tool.install`, as 0.13 does for a missing tool.
4. **Toolchains** (`go`, `gofmt`, `cargo`, `terraform` or `tofu`) resolve their own executable
   the same way, walking their pack's chain: a toolchain file pins `cargo`, and when `mise.toml`
   declares the toolchain, argv is prefixed with `mise exec --`. Otherwise the toolchain comes
   from `PATH`, with R6.4's version enforcement, and isn't refused under `requirePins`
   ([D65 (verified-argv)](#d65)).

#### R6.3 Version recording

`tool_version` comes from a file read, never a spawn:

| Source | `tool_version` from |
| --- | --- |
| `override` | the version in the `--pins` file |
| `js-lockfile` | `node_modules/<Tool.npm>/package.json`, found by walking up from the working directory |
| `go-mod-tool` | the tool module's version in `go.mod`'s `require` |
| `rust-toolchain` | the channel, when it's an exact version |
| `uv-lock` | the matching `[[package]]` version in `uv.lock` |
| `tf-version` | the file's content, when it's an exact version |
| `mise`, `path` | absent: mise owns version resolution, and `doctor --json` probes versions |

#### R6.4 Spawn environment

A pack's variables apply to every spawned check of that pack, target-scoped custom checks
included, and override the user's environment for these variables only. Step 30 verifies each
name against the pinned tool and records the verified list in `docs/packs.md`.

| Applies to | Variable | Value | Purpose |
| --- | --- | --- | --- |
| go | `GOTOOLCHAIN` | `local` | Fail rather than download the toolchain `go.mod` asks for. |
| go | `GOPROXY` | `off` | Fail rather than download modules; users run `go mod download` first. |
| rust | `CARGO_NET_OFFLINE` | `true` | Fail rather than fetch crates; users run `cargo fetch` first. |
| rust | `RUSTUP_AUTO_INSTALL` | `0` | Fail rather than install the toolchain `rust-toolchain.toml` names. |
| rust | `CARGO_TERM_COLOR` | `never` | Keep captured text free of ANSI codes. |
| python | `PYTHONDONTWRITEBYTECODE` | `1` | No `__pycache__` writes in the checkout. |
| python | `PIP_NO_INDEX` | `1` | pip never reaches an index. |
| python | `UV_OFFLINE` | `1` | uv never reaches an index. |
| terraform | `CHECKPOINT_DISABLE` | `1` | No version check call to HashiCorp. |
| terraform | `TF_IN_AUTOMATION` | `1` | Automation-friendly output. |
| terraform | `TF_INPUT` | `0` | Never prompt. |
| terraform | `TFENV_AUTO_INSTALL`, `TOFUENV_AUTO_INSTALL` | `false` | The version manager never downloads a CLI. |
| terraform | `TRIVY_SKIP_CHECK_UPDATE` | `true` | trivy uses its embedded checks. |
| any check launched through mise | `MISE_EXEC_AUTO_INSTALL`, `MISE_NOT_FOUND_AUTO_INSTALL` | `false` | mise never installs a missing tool. |

No row touches `GOFLAGS`: Go 1.24 already refuses to rewrite `go.mod` during a build, and an
explicit `-mod=readonly` would make Go ignore `vendor/` ([D54 (go-mod-readonly)](#d54)).

Adapters with `network: true` receive none of the network-blocking variables (`GOPROXY`,
`CARGO_NET_OFFLINE`, `PIP_NO_INDEX`, `UV_OFFLINE`). They keep the ones that pin a toolchain or
switch off auto-install.

Where a `rust-toolchain.toml` or `rust-toolchain` pins the toolchain, every spawn of a check
whose chain reads `rust-toolchain` also sets `RUSTUP_TOOLCHAIN` empty, which rustup reads as
unset, so a version an outer shell exported, as mise does for its own Rust, can't override the
repo's pin. A tool these variables stop names the variable, not the way out, so a red check
prints one line after its status naming the step to run first: `go mod download`,
`rustup toolchain install <toolchain>` or `cargo fetch` ([D65 (verified-argv)](#d65)).

#### R6.5 Scheduling and locks

The wave model and effective-order resolution are unchanged. Two checks whose resolved `lock`
keys are equal never run at the same time. A check waiting on a lock isn't started, and its
timeout starts only when it spawns. Rust uses `cargo:<root>`; targets that share one
`CARGO_TARGET_DIR` serialize on cargo's own build-directory lock instead, and that wait counts
against their timeouts ([D64 (cargo-target-dir-lock)](#d64)). golangci-lint uses
`golangci-lint` across all targets, because its own run lock would otherwise fail a second
instance.

#### R6.6 Entry command

The entry command resolves in this order:

1. The root has a `package.json`: `<pm> run check` (0.13 behavior), whether or not it has
   `scripts.check` yet ([D62 (entry-package-json)](#d62)).
2. The root `mise.toml` declares checkride, as `npm:checkride` or `github:robmclarty/checkride`
   ([D46 (checkride-pin)](#d46)): `mise exec -- checkride`.
3. Otherwise, in a repo with no `package.json`, `checkride`, found on `PATH`, which `doctor`
   reports as `harness unpinned`.

The AGENTS.md stanza, the generated gate hook script and the plugin skills use the entry command.
The skills learn it from the stanza, which becomes the source of truth for "how do I run the gate
here".

### R7. Command line

#### R7.1 Run flags and variables

| Flag | Variable | Meaning |
| --- | --- | --- |
| `--config <path>` | `CHECKRIDE_CONFIG` | Use this config file instead of `<cwd>/checkride.config.json` ([D20 (config-path)](#d20)). |
| `--out <dir>` | `CHECKRIDE_OUT` | Write artifacts here instead of `<cwd>/.check` (R9). |
| `--base <ref>` | `CHECKRIDE_BASE` | The base for `--changed` (R10.1). |
| `--defaults <path>` | `CHECKRIDE_DEFAULTS` | A config layered below detection (R13.1). |
| `--pins <mise.toml>` | `CHECKRIDE_PINS` | An override pin source (R13.3). |
| `--discover` | none | Discover targets at run time (R13.2). |
| `--static-only` | none | Keep only static checks (R13.4). |

A flag beats its variable. `--discover` with configured `targets` checks those targets instead,
with a note on stderr ([D73 (discover-stands-down)](#d73)). The gate strips every
variable in this table from the check it spawns, and the hooks never pass them.

#### R7.2 Where each applies

| Command | `--config` | `--out` | `--base` | `--defaults`, `--pins`, `--discover`, `--static-only` |
| --- | --- | --- | --- | --- |
| run | yes | yes | yes | yes |
| `doctor` | yes | probes it | no | yes |
| `fix` | yes | no | no | no |
| `baseline` | yes | yes | no | no |
| `triage`, `qa` | no | yes (`triage` passes it to the run it starts) | no | no |
| `gate`, `hooks` | no | no | no | no |

#### R7.3 `baseline diff`

```text
checkride baseline diff [<ref>] [--json]
```

It reads `<ref>:checkride.baseline.json` through `git show` (default ref `HEAD`), compares it with
the working-tree file, and prints added and removed keys per check. A missing file on either side
reads as empty. It exits 0 when it ran, keys added or not, and 2 when the ref doesn't resolve, git
is missing, or a baseline can't be parsed. `--json` prints:

```json
{
  "ref": "origin/main",
  "sha": "4f2c1e0",
  "added": { "lint": ["src/a.ts:no-unused-vars:'x' is never used"] },
  "removed": { "struct": ["src/b.ts:no-class:no classes"] },
  "added_count": 1,
  "removed_count": 1
}
```

#### R7.4 `target add`

`checkride target add <name> --lang <pack> --root <dir> [--add <slots>] [--root-name <n>]
[--dry-run]` adds a target, and creates the config when it's absent. Converting an implicit-mode
repo does three things:

1. The implicit target becomes an explicit one named `--root-name` (default `app`), rooted at `.`.
2. Top-level target-scope entries in `checks` move into `targets.<root-name>.checks`.
3. Baseline keys are rewritten from `lint` to `app:lint`.

It prints each change, adopts tool configs that already exist under the new root, and scaffolds
blessed configs for the slots `--add` names.

#### R7.5 `init`

- **New mode** gains `--lang ts|go|rust` (default `ts`). `--shape` is per pack: `ts` takes
  `flat|monorepo|hybrid`, `go` takes `module|workspace`, and `rust` takes `crate|workspace`. An
  invalid combination is a usage error (exit 2). `--lang go|rust` writes no `package.json`. It
  writes `mise.toml` pinning checkride (as `npm:checkride` with `node` until a binary ships,
  [D46 (checkride-pin)](#d46)) and the pack's binary tools (R11.6), a config naming every
  slot with `requirePins: true`, and prints the remaining steps that need the network, such as
  `go get -tool` and `cargo fetch`.
- **Existing mode** runs discovery (R11.4). When discovery finds more than one pack, or a marker
  below the root, it prints a proposed `targets` block and writes it unless `--dry-run` is
  passed. With exactly one pack at the root, it stays in implicit mode.

### R8. `summary.json` additions

Every field here is additive under `schema_version: 1`.

#### R8.1 Top-level fields

| Field | Type | Present when |
| --- | --- | --- |
| `run` | object | always |
| `run.partial` | boolean | always: true when `--only`, `--skip`, `--changed`, `--static-only` or a `--bail` break narrowed the run |
| `run.only`, `run.skip`, `run.include` | string array | the flag was given |
| `run.all`, `run.changed`, `run.static_only`, `run.discover` | `true` | the flag was given |
| `run.config`, `run.defaults`, `run.pins`, `run.out` | string, an absolute path | the flag or its variable was given |
| `git` | object | the working directory is in a git work tree, and git answered within 5 seconds |
| `git.head` | string | with `git` |
| `git.dirty` | boolean | with `git`: true when `git status --porcelain` lists anything |
| `git.base` | `{ ref, sha }` | `--changed` |
| `targets` | `{ name, pack, root, discovered? }` array | multi-target mode, in config order, then discovery order |

#### R8.2 Per-check fields

| Field | Type | Present when |
| --- | --- | --- |
| `origin` | `config`, `detected`, `built-in`, `custom` or `defaults` | the check is active |
| `detected_by` | string | `origin` is `detected`: the matched detect file, `package.json: <dep>`, `package.json: scripts.<name>` or `<pin file>: <tool>` |
| `target` | string | a target-scope check in multi-target mode |
| `slot` | string | multi-target mode: the catalogue slot or custom check name |
| `pack` | pack name | multi-target mode, or implicit mode with a pack other than `ts` |
| `cwd` | string, repo-relative | the working directory isn't the repo root |
| `pin_source` | pin source name | the check spawned a tool through the launcher |
| `tool_version` | string | R6.3 found one |
| `argv` | string array | the check spawned a process |
| `narrowed` | `{ units, total }` | R10.4 narrowed the check |

`output_file` may now hold one directory segment (`api/lint.json`) and the extension `.jsonl`.

#### R8.3 New uses of `reason`

- `<adapter> exited 0 but reported findings on stdout` (`failOnOutput`).
- `<last stderr line> (exit N)` (a self-skip).
- `static-only: <cause>`.
- `no changes under <root>`, `no files matched` and `no Go module changed under <root>`.
- `needs a writable <root>/.check for scratch files`, where `<root>` is the target root
  ([D48 (out-per-target)](#d48)).

#### R8.4 Array order

`checks` is ordered by group sequence, then catalogue position, then scope (repo before target),
then target order, then custom checks in config-key order. It stays independent of finish order.

### R9. The output directory

- **Resolution.** `--out`, then `CHECKRIDE_OUT`, then `<cwd>/.check`. A relative path resolves
  against the working directory.
- **Written there.** `summary.json`, the raw files, `digest.md`, `unclaimed.json`, `schema.json`
  and the `<target>/` directories. `output_file` stays relative to it. A run first clears what it
  left for each target that the directory's previous `summary.json` listed and the config no
  longer has: the files that summary's checks of the target name, then the `<target>/` directory
  once nothing else is in it ([D57 (prune-own-files)](#d57)). checkride never deletes a directory
  it didn't write, so `--out` can point into a folder that holds other things.
- **`{out}`** is a check's own artifact directory ([D48 (out-per-target)](#d48)). In implicit
  mode it expands to `.check` for the default and to an absolute path otherwise, so default argv
  matches 0.13's. In multi-target mode it expands to the absolute `<out>/<target>` for a
  target-scope check and the absolute `<out>` for a repo-scope one.
- **Always at `<repo>/.check/`, whatever `--out` says:** the gate's `.dirty` marker.
- **Always at `<target root>/.check/`, whatever `--out` says:** scratch (`doc-snippets/`,
  `smoke-probe.mjs`), because generated files resolve modules from where they sit. In implicit
  mode that's `<repo>/.check/`. When that directory isn't writable, `snippets` and `smoke` skip
  with the scratch reason.
- **Outside the repo,** `--out` makes the run a consumer run (R13.5).
- **Limits.** Separate `--out` values keep artifacts apart. They don't keep tools apart: tsc build
  info, `.fallow/`, test caches and cargo's target directory are shared. Concurrent runs belong in
  separate worktrees.

### R10. `--changed`

#### R10.1 The base

The base resolves from `--base`, then `CHECKRIDE_BASE`, then config `changedBase`, then
`origin/main` when `git rev-parse --verify origin/main^{commit}` succeeds, then `HEAD`. An
explicit base (flag, variable or config) that doesn't resolve exits 2. A defaulted `origin/main`
that doesn't resolve falls back to `HEAD`, with a warning on stderr. The resolved ref and sha go
into `git.base`. Adapters receive the ref as `{base}` in `changedArgs`: vitest's
`--changed {base}` and jest's `--changedSince {base}`.

#### R10.2 Changed paths

1. `mb` is `git merge-base <base> HEAD`, or the base itself when there's no merge base.
2. Changed paths are `git diff --name-only <mb>` (committed, staged and unstaged changes), plus
   `git ls-files --others --exclude-standard`.
3. With no git, or no resolvable base, no target is skipped and stderr warns.

#### R10.3 Targets

A target is affected when any changed path lies under its root, and the checks of unaffected
targets are skipped with `no changes under <root>`. Repo-scope checks always run, with their
`changedArgs` as today, and affected targets' adapters receive theirs. The run stays partial for
the baseline ratchet, as `--changed` is today. Implicit mode only changes through R10.1.

#### R10.4 Go narrowing

1. It applies under `--changed` to adapters with `narrowsUnderChanged` (`go-build`, `go-test`),
   when the target root holds a `go.work`. A single-module target has nothing to narrow.
2. Read `go.work`'s `use` and `replace` directives, in single-line and block forms. For each used
   module, read its `go.mod`: the `module` path, `require` entries and `replace` entries with
   local paths.
3. Module A depends on module B when A's `go.mod` requires B's module path or replaces it with
   B's directory. Only edges between workspace modules count.
4. The changed set holds every used module that contains a changed path. When `use` directories
   nest, the deepest one wins.
5. The affected set is the changed set plus every module that depends on one of them,
   transitively.
6. Fall back to the full expansion when a changed path is `go.work`, `go.work.sum` or any
   `go.mod` in the workspace, when any file can't be parsed, or when the base can't be resolved.
   Changed paths outside every module are ignored.
7. Expand to `./<dir>/...` for each affected module, in `go.work` order. An empty affected set
   skips the check with `no Go module changed under <root>`.
8. Record `narrowed: { units, total }`, with the expanded patterns and the workspace's module
   count.

`docs/packs.md` recommends a persistent `GOCACHE` for sandboxes as well: `go test` caches
results per package, so a warm cache recovers much of the cost narrowing saves.

### R11. Capture, files, markers and scaffolds

#### R11.1 Capture

Json and jsonl capture apply only to a check that declares an `outputFile`, and the declared
extension says which, so `go-build` declares `types.jsonl`. A check without one, including every
custom check that doesn't declare one, keeps 0.13's text capture whatever it prints
([D45 (capture-gate)](#d45)). After the existing rule that drops up to ten leading non-JSON
launcher lines, the first matching case applies:

1. The check declares a `.json` file, and stdout parses as a single JSON value: write it.
2. The check declares a `.jsonl` file, stdout has at least one non-empty line, and every
   non-empty line parses as JSON: write it.
3. Otherwise: write `<name>.stdout.txt` and `<name>.stderr.txt`.

No bytes inside the tool's output change; `jsonl` is a capture format, not normalization. A
`failOnOutput` tool that exits 0 with non-whitespace stdout is `ok: false`, with the tool's
`exit_code: 0` and R8.3's reason. A custom check that exits its `skipExitCode` records as skipped
and writes no artifact.

#### R11.2 File lists

1. Candidates come from `git ls-files -z --cached --others --exclude-standard -- <root>`. Outside
   a git repo, checkride walks the tree, skipping `.git`, `node_modules`, `target` and `vendor`.
2. Candidates are filtered by the target's `include` and `exclude` globs, relative to its root.
   The default `include` is `["**/*.sh", "**/*.bash"]`, plus shebang sniffing: an extensionless
   file is included when its first line names `bash`, `sh`, `dash` or `ksh` as its interpreter,
   directly or through `env` ([D61 (shebang-sniff)](#d61)).
3. Globs support `**`, `*`, `?` and `{a,b}`, through a matcher in `src/targets/files.ts` with no
   dependency.
4. Zero matches skip the check with `no files matched`. Skipped is not failed.
5. A file list whose argv exceeds 200,000 bytes is a harness error (exit 2) asking the user to
   narrow `include`.

#### R11.3 `unclaimed`

Marker kinds: `package.json` and `tsconfig.json` are `ts`; `go.mod` and `go.work` are `go`;
`Cargo.toml` is `rust`; `pyproject.toml`, `setup.cfg` and `setup.py` are `python`;
`.terraform.lock.hcl` and every `*.tf` file are `terraform`. Bash has no marker.

1. List files as in R11.2, step 1, at the repo root.
2. Marker M, in directory D, is claimed when some target has a pack that recognizes M's kind and
   a root that is D or an ancestor of D. This claims Cargo workspace members, Go workspace
   modules, uv workspace members, pnpm workspace packages and a root module's nested `.tf`
   directories.
3. Never reported: paths matching `unclaimed.ignore`, and paths under `node_modules/`, `vendor/`,
   `target/`, `.venv/`, `.terraform/`, `.check/`, the output directory, any `testdata/` or any
   `test/fixtures/`.
4. Any unclaimed marker fails the check (exit 1). `<out>/unclaimed.json` is checkride's own
   format:

```json
{ "unclaimed": [ { "path": "tools/gen/go.mod", "kind": "go",
                   "suggest": { "name": "gen", "lang": "go", "root": "tools/gen" } } ] }
```

#### R11.4 Discovery

Discovery serves existing-mode `init` and `--discover`.

1. List markers as in R11.3.
2. Proposed targets:
   - Each `go.work` directory becomes a `go` target and claims its `use` modules. Each `go.mod`
     not already claimed becomes a `go` target.
   - Each `Cargo.toml` with `[workspace]` becomes a `rust` target. Each `[package]` manifest not
     already claimed becomes one too.
   - A root `package.json` or `pnpm-workspace.yaml` makes a root `ts` target that claims nested
     `package.json` files. Otherwise, each top-most `package.json` becomes a `ts` target.
   - Each top-most `pyproject.toml`, `setup.cfg` or `setup.py` directory becomes a `python`
     target, which claims the nested ones (uv workspace members).
   - Each `.terraform.lock.hcl` directory becomes a `terraform` target. Then each top-most
     directory holding `.tf` files that no `terraform` target claims becomes one more.
   - If shell files match R11.2's defaults outside every other target's root, one `bash` target
     is proposed at the deepest common ancestor of those files.
3. Names come from the root directory's basename, slugified: `.` becomes `app`, and a bash
   target becomes `scripts` when its root is `scripts`, and `shell` otherwise. Collisions get
   numeric suffixes.
4. One target at the root and nothing else means implicit mode: no `targets` block is written,
   and `--discover` changes nothing.

#### R11.5 The `schema` slot

1. For each rule, in order: list files as in R11.2 at the repo root, filtered by `files`; parse
   each by `format`; validate it against the schema.
2. **Parsers.** `json` is strict (`JSON.parse`). `jsonc` uses `jsonc-parser` with trailing commas
   allowed. `yaml` uses the `yaml` package's YAML 1.2 core schema and treats duplicate keys as
   errors. `frontmatter` requires the file to begin with `---` on its first line, reads YAML up
   to the next line that is `---`, and reports a missing block as an error.
3. **Validation.** `ajv`, with draft 2020-12 or draft-07 according to the schema's `$schema`.
   `format` keywords aren't asserted. A `$ref` to a remote URL is an error, because checks make
   no network calls.
4. **Rule hygiene.** A rule that matches zero files is an error: a config that points at nothing
   must not stay green, the precedent `prose.exemplars` already sets.
5. **Bundled schemas.** `checkride:agent-skill` requires frontmatter `name` (pattern
   `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters) and `description` (1 to 1024
   characters), allows additional properties, and adds one check JSON Schema can't express:
   `name` must equal the parent directory's name. The limits track the Agent Skills
   specification; the build verifies them against the current specification and records the
   source in the schema's `$comment`. `checkride:checkride-config` is checkride's own config
   schema.
6. **Output.** `<out>/schema.json` is checkride's own format:

```json
{ "rules": [ { "schema": "checkride:agent-skill", "files": 3 } ],
  "errors": [ { "file": "skills/pdf/SKILL.md", "rule": 0, "instancePath": "/name",
                "keyword": "pattern", "message": "must match pattern ..." } ] }
```

A repo that already has a custom check named `schema` sees it become a slot-filling entry: its
`detect` is ignored and it always runs. The release notes say so under **Contract**.

#### R11.6 Templates, scaffolds and dialect rules

```text
templates/
  ts/         shared/ + flat/ monorepo/ hybrid/      (moved from today's layout)
  repo/       shared/                                (markdownlint, rumdl, cspell, typos, vale, sgconfig)
  go/         shared/ + module/ workspace/
  rust/       shared/ + crate/ workspace/
  bash/       shared/
  python/     shared/                                (ruff, mypy, pytest configs; no shapes)
  terraform/  shared/                                (.tflint.hcl; no shapes)
```

Each pack's `shared/` holds its blessed tool configs, its `rules/<pack>/*.yml` dialect rules
(each with `language` set), and a `mise.toml` fragment that lists its binary tools at tested
versions. `init` and `target add` merge fragments into one root `mise.toml`: they create the file
or add missing keys, and never change a version already there. The release process bumps the
fragment versions, as it bumps `devDeps` today.

Shapes:

- **go/module:** `go.mod` (`--module <path>`, default `example.com/<name>`), `cmd/<name>/main.go`,
  `internal/greet/greet.go` with a test, a v2 `.golangci.yml`, `sgconfig.yml` and the go rules.
  Go's `internal/` directory is the deep-module boundary, and the compiler enforces it.
- **go/workspace:** `go.work` plus two modules.
- **rust/crate:** `Cargo.toml` (edition 2024, with `[lints.rust] unsafe_code = "forbid"` and
  `[lints.clippy] unwrap_used = "deny"`), `src/lib.rs`, `src/main.rs`, `rust-toolchain.toml` (a
  pinned channel with `rustfmt` and `clippy`), `rustfmt.toml`, `.config/nextest.toml`, and a
  config naming `snippets`.
- **rust/workspace:** a virtual manifest with `crates/core` and `crates/cli`.

Dialect rules, each with a passing and a failing fixture:

| Pack | Rule | Forbids |
| --- | --- | --- |
| ts | today's rules, plus the test layout's | unchanged |
| go | `go-no-dot-import` | `import . "pkg"` |
| go | `go-no-import-alias` | aliased imports other than `_` (an `ast-grep-ignore` comment covers a genuine collision) |
| go | `go-no-init-func` | `func init()` outside `package main` |
| rust | `rust-no-glob-reexport` | `pub use path::*;` |
| rust | `rust-no-glob-import` | `use path::*;`, other than `use super::*;` |
| bash | `bash-strict-mode` | a script without `set -euo pipefail`; if ast-grep can't express it, it becomes a built-in beside shellcheck |

Every generated shape is green out of the box, and the e2e suite holds each one.

### R12. The findings API

#### R12.1 Surface

```ts
// import { parseFindings, findingsFor, isParseable } from 'checkride/findings';

export type Finding = {
  adapter: string;
  slot: string;       // the check's slot; fallow derives dead, dupes or health from its report
  file: string;       // repo-root-relative, with forward slashes
  line?: number;      // 1-based
  column?: number;    // 1-based
  rule: string;       // the tool's rule id; '' when the tool names none
  message: string;
  severity?: string;  // the tool's own level string, verbatim
  gates?: boolean;    // can fail the check under the argv that ran; absent when unknown
};

export type ParseOptions = {
  slot?: string;               // defaults to the adapter's slot
  root?: string;               // the check's cwd, repo-relative ('' for the repo root)
  repoRoot?: string;           // absolute; relativizes tools that print absolute paths
  argv?: readonly string[];    // the argv that ran; defaults to the adapter's registry args
};

export function parseFindings(adapter: string, raw: string, options?: ParseOptions): Finding[] | null;
export function findingsFor(check: SummaryCheck, runDir: string, options: { repoRoot: string }): Finding[] | null;
export function isParseable(adapter: string): boolean;
```

`null` means no parser exists for the adapter, or its output can't be trusted (vale's runtime
error report). An empty array means parsed and clean. `findingsFor` takes the adapter, slot,
`cwd` and `argv` from the summary entry, and opens the check's artifact under `runDir` itself: its
`output_file`, else the `<name>.stdout.txt` or `<name>.stderr.txt` its parser declares
([D49 (text-findings)](#d49)). The set of parseable adapters only grows. The API is
npm-only; the binary doesn't carry it.

#### R12.2 Parsers and the baseline

| Adapter | Slot | Format | Feeds the baseline |
| --- | --- | --- | --- |
| `oxlint` | `lint` | json | yes |
| `ast-grep` | `struct` | json | yes |
| `cspell` | `spell` | text | yes |
| `vale` | `prose` | json | yes |
| `fallow` | `dead`, `dupes`, `health` | json | yes |
| `markdownlint-cli2` | `docs` | text | yes (new) |
| `rumdl` | `docs` | per the pinned version | yes |
| `typos` | `spell` | text (`--format brief`, [D67 (typos-brief)](#d67)) | yes |
| `golangci-lint` | `lint` | json | yes |
| `staticcheck` | `lint` | jsonl | yes |
| `clippy` | `lint` | jsonl | yes |
| `shellcheck` | `lint` | json1 | yes |
| `ruff` | `lint` | json | yes |
| `tflint` | `lint` | json | yes |
| `schema` | `schema` | json | yes |
| `tsc` | `types` | text | no |
| `go-build` | `types` | jsonl | no |
| `cargo-check` | `types` | jsonl | no |
| `mypy` | `types` | jsonl | no |
| `basedpyright` | `types` | json | no |
| `terraform-validate` | `types` | json | no |
| `trivy-config` | `security` | json | no |

Baseline keys keep the 0.13 form, `<file>:<rule>:<message>` (fallow keeps its own forms), built
from gating findings only ([D27 (gating-keys)](#d27)). Each parser declares the stream it reads,
the JSON artifact, stdout or stderr, and the baseline hands it that stream rather than always
stdout ([D49 (text-findings)](#d49)).

#### R12.3 Gating

| Adapter | A finding gates when |
| --- | --- |
| `oxlint` | its `severity` is `error`, or argv has `--deny-warnings` or `--max-warnings` |
| `ast-grep` | its `severity` is `error`, or argv has a bare `--error`, or `--error=<rule>` names its rule |
| `cspell`, `typos`, `ruff`, `golangci-lint`, `tsc`, `go-build`, `schema` | always |
| `vale` | its `Severity` is `error` |
| `markdownlint-cli2`, `rumdl` | the tool reports it at error level (verified at the pinned version) |
| `fallow` | `fallowVerdict` counts it |
| `staticcheck` | its `severity` isn't `ignored` |
| `clippy`, `cargo-check` | its `level` is `error` (`-D warnings` turns warnings into errors) |
| `shellcheck` | its `level` is at or above argv's `--severity`, which defaults to `style`: every finding |
| `mypy` | its `severity` is `error` |
| `basedpyright` | its `severity` is `error`, or `warning` when argv has `--warnings` |
| `tflint` | its rule severity is at or above `--minimum-failure-severity` (default verified at the pinned version) |
| `terraform-validate` | its `severity` is `error` |
| `trivy-config` | its `Severity` is in argv's `--severity` list, or always when that flag is absent |

When a rule depends on argv and none is given, the parser uses the adapter's registry args.
`gates` is absent only when a parser can't tell.

#### R12.4 Paths

1. A tool-relative path is joined to the check's `root`, its summary `cwd`.
2. An absolute path is made relative to `repoRoot`. Without `repoRoot`, it stays absolute.
3. Separators become `/`.

Baseline keys use the rebased path. In implicit mode the root is the repo root, so every
existing key is unchanged. Rebasing starts in step 27, when targets arrive, so a target's keys
don't change between releases ([D50 (key-rebasing)](#d50)).

### R13. Consumer mode

#### R13.1 The defaults layer

- `--defaults` or `CHECKRIDE_DEFAULTS` names the file, and its `extends` resolves against it.
- It may hold `checks`, `packs`, `extends`, `timeout`, `requirePins` and `schemas`; `targets` is
  an error (V11), and so is any other key ([D71 (consumer-calls)](#d71)). Every entry is held to
  resolution's rules as it loads, and every error names the file
  ([D69 (config-error-file)](#d69)); a top-level entry naming an adapter no pack has exits 2.
- It fills a slot only when the repo's config and detection leave it unresolved (R3). Its entries
  record `origin: "defaults"` and render `[defaults]`. A slot it fills keeps the opt-in status
  the repo gives it, and a defaults `false`, or a pick the check's pack has no adapter for,
  fills nothing ([D71 (consumer-calls)](#d71)).
- Its custom checks join the run only when the repo has no check by that name.
- Its other top-level keys (`timeout`, `requirePins`, `schemas`) apply only when the repo's config
  doesn't set them, and an array is never merged with the repo's.
- `static: true` on its entries is how a consumer vouches for its own checks under
  `--static-only`. The key is an error anywhere else (V12).

#### R13.2 `--discover`

- It runs R11.4 at run time and applies the proposed targets in memory, as if configured. A
  config that already declares `targets` keeps them, and the run says so on stderr
  ([D73 (discover-stands-down)](#d73)).
- Top-level target-scope entries are lifted the way `target add` lifts them: into the target at
  root `.` when discovery proposes one, and dropped with a stderr note when it doesn't.
- Baseline keys are aliased in memory (`lint` reads as `app:lint`), so masking keeps working.
  Nothing is written.
- The summary's `targets` entries carry `discovered: true`.

#### R13.3 `--pins`

- `--pins` or `CHECKRIDE_PINS` names a `mise.toml`. Its `[tools]` entries are read with their
  versions: a string, or an inline table's `version`. Anything else exits 2.
- The file becomes an `override` source at the head of every pack's chain. A tool it declares
  runs as `mise exec <id>@<version> -- <bin>`, with mise's auto-install off (R6.4) and offline
  (`MISE_OFFLINE=1`), and records `pin_source: "override"` and its `tool_version`. A toolchain
  it declares, such as `go`, runs that copy in any chain, and detection never reads the file
  ([D71 (consumer-calls)](#d71)).
- A version mise hasn't installed, as `mise where <id>@<version>` reports it, fails the check,
  naming the tool. Nothing downloads.

#### R13.4 Static classification

A check survives `--static-only` only when every condition holds:

1. Its adapter is `static: true` in the registry, or its entry comes from the defaults layer with
   `static: true`. A custom check from the repo never qualifies, and neither does an entry that
   swaps a static adapter's command ([D71 (consumer-calls)](#d71)).
2. Its argv carries none of the adapter's `nonStaticArgs`.
3. None of the adapter's `codeConfigs` exists under the check's working directory, at any depth.
4. None of its `codeKeys` appears in the config file it reads. This is a best-effort sniff of
   known keys, read as text and erring toward a skip: a `CodeKey` names its file by name at any
   depth or by path glob, and may carry a `value` regex a string the key holds must match
   ([D71 (consumer-calls)](#d71)).
5. Its tool resolves without an install (R6.2). Under the flag, the js-lockfile source
   pre-flights `node_modules/.bin` for every package manager but a PnP install
   ([D71 (consumer-calls)](#d71)).

Every other check is skipped with `static-only: <cause>`, and the summary records
`run.static_only` and `run.partial`.

| Adapter | Static | Code configs | Code keys sniffed |
| --- | --- | --- | --- |
| `ast-grep` | yes | none | `customLanguages` in `sgconfig.yml` |
| `markdownlint-cli2` | yes | `.markdownlint-cli2.cjs`, `.markdownlint-cli2.mjs`, `.markdownlint.cjs`, `.markdownlint.mjs` | `customRules`, `markdownItPlugins` |
| `cspell` | yes | `cspell.config.js`, `cspell.config.cjs`, `cspell.config.mjs` | `import` entries ending in `.js`, `.cjs` or `.mjs` |
| `vale` | yes | none | a style rule with `extends: script` |
| `prettier` | yes | `prettier.config.js`, `prettier.config.cjs`, `prettier.config.mjs`, `.prettierrc.js`, `.prettierrc.cjs`, `.prettierrc.mjs` | `plugins` |
| `oxlint` | yes, unless argv has `--type-aware` | none | `jsPlugins` |
| `tflint` | yes | none | a `plugin` block other than `terraform` in `.tflint.hcl` |
| `rumdl`, `typos`, `shellcheck`, `shfmt`, `gofmt`, `ruff`, `ruff-format`, `terraform-fmt`, `trivy-config`, `biome`, `biome-format` | yes | none | none |
| `links`, `schema`, `unclaimed` | yes | none | none |
| every other adapter, and every custom check from the repo | no | none | none |

The blessed oxlint invocation carries `--type-aware`, which needs installed dependencies, so a
repo's own oxlint check doesn't survive `--static-only`. The docs present this flag as a selector
for "runs with nothing installed", never a sandbox: a tool release can add a way to load code
that these sniffs don't know.

#### R13.5 Consumer runs write nothing in the repo

A consumer run is a run with a `--config` file outside the repo, `--defaults`, `--pins`,
`--discover`, `--static-only`, or an `--out` outside the repo. It never ratchets and never writes `checkride.baseline.json`, and
stderr says so once when a ratchet would otherwise have run. checkride's only writes in the repo
are the scratch files under `<target root>/.check/` (R9). Tools may still write caches in the tree.
The `baseline` command is the repo's explicit write, so it writes `checkride.baseline.json`
whatever `--config` or `--out` it's given ([D47 (consumer-trigger)](#d47)).

#### R13.6 Recipes

The pre-sandbox pass reads the repo as data, with the agent's own tools:

```bash
checkride --discover --defaults /agent/defaults.json --pins /agent/mise.toml \
  --static-only --changed --base "$BASE_SHA" --out "$RUN_DIR/static" --json
```

The sandbox pass runs after the repo's install, with the repo's own pins:

```bash
checkride --discover --defaults /agent/defaults.json \
  --changed --base "$BASE_SHA" --out "$RUN_DIR/full" --json
```

To compare the base branch's check config with the PR's, check the base out next to the PR, so
relative `extends` resolve against the base tree:

```bash
git worktree add --detach /tmp/base "$BASE_SHA"
checkride --config /tmp/base/checkride.config.json --out "$RUN_DIR/base-config" --json
checkride --out "$RUN_DIR/pr-config" --json
```

To count findings a PR grandfathers instead of fixing:

```bash
checkride baseline diff "$BASE_SHA" --json
```

To read findings:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findingsFor } from 'checkride/findings';

const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
for (const check of summary.checks) {
  // findingsFor opens the check's own artifact, text output on either stream included (D49).
  const findings = findingsFor(check, runDir, { repoRoot }) ?? [];
  // A finding with gates: true failed the check; key review comments on file and line.
}
```

None of this is a sandbox. Run untrusted PRs inside one.

### R14. Distribution

#### R14.1 The binary

1. `pnpm build:sea` runs `tsc --build`, then esbuild bundles `dist/cli.js`, the three schema
   dependencies included, into one ESM file.
2. A SEA config embeds every file under `templates/`, `schema/` and `skills/` as assets. The
   embedded Node is the Active LTS at release time. The binary is built with `node --build-sea`
   where the embedding Node supports it, and with the postject flow otherwise.
3. `src/resources.ts` exposes `readResource(relPath)` and `listResources(prefix)`. They read from
   the package directory in npm mode, and through `node:sea`'s `getAsset` in binary mode.
   Today's `TEMPLATES_DIR` constant goes away.
4. The CLI is identical to the npm CLI. `doctor` prints `channel: npm` or `channel: binary`, plus
   the embedded Node version for the binary. The programmatic API, `checkride/findings` and the
   plugin's `dist/` readers stay npm-only; binary users run `checkride triage` and `checkride qa`.
5. In binary mode, an `extends` naming a package fails with exit 2: `invalid
   checkride.config.json: package presets need the npm distribution; use a file path`.
6. CI builds on native runners for each platform, signs ad hoc on macOS, and runs the full e2e
   suite with `CHECKRIDE_BIN=<binary>`. If SEA fails it, the build switches to
   `bun build --compile` and records the verdict.

#### R14.2 Channels

npm, unchanged. GitHub Releases. mise, through the `github:robmclarty/checkride` backend: the
documented pin for repos without Node, with `mise.lock` recording checksums; until a binary ships, scaffolds pin `npm:checkride` with
`node` instead ([D46 (checkride-pin)](#d46)). A Homebrew tap, for
convenience only and never a pin. The tap repository and the first binary release are created by
hand after this build.

#### R14.3 Release artifacts

Each tag publishes the npm package and, from the same commit:

- `checkride-<version>-<os>-<arch>.tar.gz` for `darwin-arm64`, `darwin-x64`, `linux-x64` and
  `linux-arm64` (glibc), each holding `checkride` and `LICENSE`;
- `SHA256SUMS`;
- a GitHub build provenance attestation for every tarball.

The release workflow asserts that the npm version, the tag and the version string compiled into
each binary are equal.

### R15. Failure modes

| # | Scenario | Expected behavior | Test |
| --- | --- | --- | --- |
| F1 | A Go module is missing from the module cache. | `api:types` fails with exit 1 in under 30 seconds and makes no network call; the message names `go mod download`. | E2e fixture with an empty `GOMODCACHE`. |
| F2 | `go.mod` requires a newer Go than the installed one. | The check fails, naming the required version. No toolchain downloads. | Fixture with `go 1.99`. |
| F3 | The `rust-toolchain.toml` channel isn't installed. | The check fails, naming `rustup toolchain install <channel>`. Nothing installs. | Fixture with an uninstalled channel. |
| F4 | Two cargo checks for one target land in one wave. | They never overlap, and lock waits don't count against timeouts. | Fake spawner that records intervals. |
| F5 | Two go targets each run golangci-lint. | The runs never overlap. | Fake spawner. |
| F6 | A target root doesn't exist. | Exit 2, with a config error naming the target. | Config unit test. |
| F7 | A target name collides with a slot or a custom check. | Exit 2 (V2). | Config unit test. |
| F8 | Two targets of one pack have nested roots. | Exit 2 (V4). | Config unit test. |
| F9 | A new `tools/gen/go.mod` appears. | `unclaimed` fails with exit 1 and suggests a target. | Plant in `polyglot-stack`. |
| F10 | A bash `include` matches nothing. | The check is skipped with `no files matched`, not failed. | Fixture. |
| F11 | shellcheck is declared in `mise.toml`, but mise isn't on `PATH`. | `scripts:lint` fails naming mise, and never falls back to a `PATH` copy. | Fixture with a controlled `PATH`. |
| F12 | shellcheck is on `PATH` with no pin. | It runs and records `pin_source: "path"`. Under `requirePins` it fails with a `mise use` hint. | Fixture. |
| F13 | Stdout mixes JSON lines and text. | Captured as `.stdout.txt`, byte-identical to the tool's output. | Capture unit test. |
| F14 | `gofmt -l` lists files and exits 0. | `api:format` is `ok: false`, with `exit_code: 0` and a reason. | Plant. |
| F15 | A schema rule points at a missing schema, or one with a remote `$ref`. | `schema` fails with exit 1 and names the rule. | Fixture. |
| F16 | A schema rule matches zero files. | `schema` fails with exit 1 and names the rule. | Fixture. |
| F17 | A 0.13 repo upgrades without adding `targets`. | Checks, order, names, argv, output files and exit code match 0.13, and the summary differs only by R8's fields. | Invariance golden (S1). |
| F18 | `--only lint` in multi-target mode. | Every target's `lint` runs; `--only api` runs all of `api`; an unknown token exits 2. | Token table (S2). |
| F19 | `--changed` with no git repository. | No target is skipped, and stderr warns. | Fixture. |
| F20 | The binary meets `"extends": "@acme/preset"`. | Exit 2 with R14.1's message. | Binary e2e. |
| F21 | A repo already has a custom check named `schema`. | It becomes a slot-filling entry that always runs; the release notes say so. | Config unit test. |
| F22 | `target add` converts an implicit repo that has a baseline. | Keys are rewritten, the next full run's baselined counts match, and every change is printed. | S11. |
| F23 | A custom check exits its `skipExitCode`. | Skipped, with its reason, and left out of `checks_run`. | Orchestrator unit test. |
| F24 | Every check skips itself under `--strict`. | Exit 2. | Orchestrator unit test. |
| F25 | `--config` names a missing file. | Exit 2. | CLI test. |
| F26 | `--base` names a ref that doesn't resolve. | Exit 2. A defaulted `origin/main` that doesn't resolve falls back to `HEAD` with a warning, recorded in `git.base`. | Fixture. |
| F27 | A run with `--out` outside the repo could prune the baseline. | No ratchet, and `checkride.baseline.json` is untouched. | E2e. |
| F28 | Two runs in one checkout use different `--out` values at once. | Both artifact sets are complete and distinct. | E2e. |
| F29 | `<repo>/.check/` isn't writable during an `--out` run. | `snippets` and `smoke` skip with the scratch reason; nothing else changes. | Fixture with a read-only directory. |
| F30 | `baseline diff` names a ref with no baseline file. | Every current key is reported as added. | Unit test. |
| F31 | A new oxlint warning lands in a baselined slot that's red only from grandfathered errors. | The slot stays masked green, because the warning was never keyed. | Fingerprint unit test. |
| F32 | oxlint runs with `--deny-warnings`. | Warnings are keyed, and they gate. | Fingerprint unit test. |
| F33 | One leaf module changes in a six-module workspace. | `go-test` runs that module and its dependents, `deadcode` runs everything, and `narrowed` is recorded. | Narrowing fixture. |
| F34 | `go.work` changes. | Full expansion. | Narrowing fixture. |
| F35 | `--defaults` fills `lint` where the repo detects another adapter. | The repo's detected adapter runs, with `origin: "detected"`. | Config unit test. |
| F36 | A defaults file declares `targets`. | Exit 2 (V11). | Config unit test. |
| F37 | `--discover` meets a config with `targets`. | The config's targets run, with one stderr note, and `run.discover` is recorded ([D73 (discover-stands-down)](#d73)). | CLI test. |
| F38 | `--pins` names a version mise hasn't installed. | The check fails naming the tool, and nothing downloads. | Fixture with mise. |
| F39 | `--static-only` on an uninstalled TypeScript repo. | Only static checks run; each other check is skipped with a `static-only:` reason; `run.static_only` and `run.partial` are true. | E2e. |
| F40 | `.oxlintrc.json` declares `jsPlugins` under `--static-only`. | `lint` is skipped with the sniff's reason. | Unit test. |
| F41 | A python target has no `.venv`. | The check fails naming `uv sync`, and nothing downloads. | Fixture. |
| F42 | `terraform validate` runs before `init`. | It fails naming `terraform init -backend=false`, with no network call. | Fixture. |
| F43 | A `.tf` directory sits outside every terraform target. | `unclaimed` fails and suggests a target. | Plant in `terraform-roots`. |
| F44 | pytest collects no tests. | Its exit 5 fails the `test` check. | Fixture. |
| F45 | `parseFindings` meets an adapter with no parser. | It returns `null`. | Unit test. |
| F46 | The parser refactor meets every existing fixture. | Every baseline key is byte-identical, apart from step 4's change. | Golden test. |
| F47 | The gate runs with a consumer variable such as `CHECKRIDE_OUT` set. | The gate strips it and reads `<repo>/.check/`. | Gate unit test. |

### R16. Tests

#### R16.1 Suites

- **S1. Legacy invariance.** Every existing example and `init` shape matches step 20's golden:
  checks, order, names, argv, output files and exit codes. Summaries differ only by R8's fields.
  The contract half holds resolution on every `pnpm check`, and the e2e half holds summaries and
  exit codes ([D51 (golden-placement)](#d51)).
- **S2. Token grammar.** A table of token lists and the checks each selects, covering R5.2 and
  the unknown-token error.
- **S3. Validation.** V1 to V12 each produce exit 2 with their own message.
- **S4. `polyglot-stack` plants.** Each runs from a clean copy and expects exit 1 with the named
  failing check: a Go compile error fails `api:types`; an ignored error return fails `api:lint`;
  a failing Go test fails `api:test`; a TypeScript type error fails `web:types`; an SC2086 fails
  `scripts:lint`; a `SKILL.md` with `name: Foo` fails `schema`; a `SKILL.md` whose name doesn't
  match its directory fails `schema`; a `config/app.json` that violates its schema fails
  `schema`; a new `tools/gen/go.mod` fails `unclaimed`; a broken relative link in a skill fails
  `links`; a dot import in Go fails `struct`.
- **S5. `rust-workspace` plants.** A clippy warning fails `lint`; `pub use x::*;` fails
  `struct`; a failing doctest fails `snippets`; an unused dependency, with cargo-machete pinned,
  fails `dead`.
- **S6. Locks.** F4 and F5 with a fake spawner.
- **S7. Environment.** A unit test asserts each pack's spawn environment, the mise variables
  included. E2e covers F1 to F3, F38, F41 and F42.
- **S8. Pins.** F11 and F12, plus `go tool`, `uv.lock` and `--pins` fixtures.
- **S9. Capture.** Fixtures for json, jsonl, mixed output and `failOnOutput`.
- **S10. `--changed`.** A change only under `frontend/` skips `api:*` with its reason and runs
  `web:*` and the repo-scope checks; the base resolution cases; F33 and F34.
- **S11. `target add`.** F22 end to end.
- **S12. Binary.** The full e2e suite with `CHECKRIDE_BIN`.
- **S13. Contract.** The summary schema accepts every R8 field; exit codes are unchanged; exports
  are additive (`PACKS`, `TOOLS`, `checkride/findings`); `baseline diff --json` holds its shape;
  the contract doc's field list equals the schema's.
- **S14. Quality floors.** [C12 (quality-floors)](#c12).
- **S15. Skips.** F23 and F24.
- **S16. Output directory.** F27 to F29.
- **S17. Findings.** A golden per parser from real output; F45 and F46; each R12.3 row.
- **S18. Consumer mode.** F35 to F40, and R13.6's first two recipes over an uninstalled and an
  installed `polyglot-stack` copy.
- **S19. Python plants.** A ruff violation fails `lint`, a type error fails `types`, and a
  failing test fails `test`; F41 and F44.
- **S20. Terraform plants.** An unformatted file fails `format` (opted in), a tflint violation
  fails `lint`, and an invalid reference fails `types`; F42 and F43.
- **S21. Provenance.** Each resolution arm's `origin` and `detected_by`, and a snapshot of the
  rendered suffixes.

#### R16.2 Architectural rules

- **A1.** `PACKS` and `TOOLS` survive a JSON round trip unchanged.
- **A2.** An ast-grep rule forbids pack-name string literals (`'ts'`, `'go'`, `'rust'`, `'bash'`,
  `'python'`, `'terraform'`) in `src/orchestrator/` and `src/launch/`.
- **A3.** An ast-grep rule allows file reads under `templates/`, `schema/` and `skills/` only in
  `src/resources.ts`.
- **A4.** The existing convention rules (no class, no default export, deep-sibling imports) cover
  every new module.
- **A5.** An ast-grep rule forbids a `.check` string literal in `src/orchestrator/`,
  `src/packs/`, `src/launch/`, `src/digest/`, `src/triage/` and `src/qa/`.
- **A6.** `src/findings/` imports nothing from `src/orchestrator/`.

### R17. File structure

Changes only:

```text
src/
  adapters.ts       SLOTS (+scope, +schema, +unclaimed); ADAPTERS kept as the ts ∪ repo union
  git.ts            the git runner: head, dirty, base, merge base, changed paths
  resources.ts      the only reader of templates/, schema/ and skills/
  packs/
    index.ts        PACKS (name → Pack)
    types.ts        Pack, PackAdapter, Invocation, Tool, PinSourceName
    tools.ts        TOOLS
    static.ts       --static-only classification and sniffs
    ts.ts  repo.ts  bash.ts  go.ts  rust.ts  python.ts  terraform.ts
  targets/
    index.ts
    resolve.ts      mode selection (R2.1) and validation (R2.3)
    tokens.ts       the token grammar (R5.2)
    files.ts        git listing, globs, shebang sniffing
    unclaimed.ts
    changed.ts      affected targets, and the changed set for Go narrowing
    discover.ts     R11.4
    add.ts          target add, and the in-memory lift --discover reuses
  launch/
    index.ts
    resolve.ts      the pin chain (R6.2) and argv
    mise.ts         the [tools] scanner: keys for repo pins, versions for --pins
    go-mod.ts       tool directives, go.work use and replace, the module graph
    uv.ts           uv.lock lookup and the project venv
    terraform.ts    version files and the version check
    env.ts          R6.4
    entry.ts        R6.6
  findings/
    index.ts        parseFindings, findingsFor, isParseable (the checkride/findings subpath)
    types.ts        Finding, ParseOptions
    parsers/        one module per tool format
  validate/
    index.ts        the schema slot
    formats.ts      json, jsonc, yaml, frontmatter
    bundled.ts      checkride:agent-skill, checkride:checkride-config
  baseline/         fingerprint.ts derives keys from findings/parsers/
  pm/               folded into launch/ as the js-lockfile source
templates/          ts/ repo/ bash/ go/ rust/ python/ terraform/ (R11.6)
schema/
  checkride.config.schema.json    + targets, packs, schemas, requirePins, changedBase, unclaimed, skipExitCode, static
  checkride.summary.schema.json   + R8's fields
  agent-skill.schema.json         new, bundled
build/sea/          the SEA config and build script
examples/           polyglot-ts-bash/ go-module/ go-workspace/ rust-workspace/ polyglot-stack/
                    python-project/ terraform-roots/
docs/               packs.md targets.md consumers.md distribution.md
mise.toml           the dev toolchains for the e2e suite
```
