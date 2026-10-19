# Report: polyglot targets, language packs, and what a review agent needs

*(`/plumbbob:finish` wrote the first five sections. Step 74 wrote "The opt-in audit" and "Closing
#6 and #7", and step 86's outcome is added to the audit.)*

## What shipped

80 planned steps landed between 2026-10-10 and 2026-10-19, from `87cffc7` (the plan) to
`b742fa1` (step 86). Every one is unreleased since 0.14.0 and is filed under `[Unreleased]` in
`CHANGELOG.md`. The `## Log` in `build-log.md` has each step's story. In outline:

- **Runs that explain themselves (Phases 1 to 3).** `skipExitCode`, `--config`,
  `baseline diff`, baseline keys only for findings that can fail, a contract doc that lists
  every summary field, `origin` and `detected_by` on every check, one `--changed` base,
  `run` and `git` in the summary, each check's spawned `argv`, and `--out`.
- **`init` writes the test layout (Phase 4).** The six layout and barrel rules, starter files
  that obey them, `test/fixtures` carved out of every tool, a config naming every scaffolded
  slot, and type-checked tests outside `src`. This repo adopted the same layout.
- **Packs, targets and pins (Phases 5 and 6).** Behind an invariance golden that holds 0.13's
  checks, argv and summaries, the adapter registry split into packs, every argv started coming
  from a pin-source launcher, and targets arrived. That means per-target slots, the token
  grammar, lock keys, `--changed` skipping unaffected targets, the mise and PATH sources with
  the pin recorded, `unclaimed`, the bash pack, `target add`, and existing-mode discovery.
- **Go, Rust, Python and Terraform (Phases 7, 10 and 11).** Four packs, each with its pin
  source, a hardened spawn environment, adapters run against the real tool at a pinned
  version, parsers proven on captured output, and an example with plants. `init --lang go|rust`
  scaffolds the first two.
- **Findings and consumer mode (Phases 8 and 9).** One parser per format feeds both the baseline
  and the `checkride/findings` API (`parseFindings`, `findingsFor`, `isParseable`). The implicit
  pack follows the root's markers, and a Go repo adopts with `--baseline`. A review agent gets
  `--defaults`, `--discover`, `--pins` and `--static-only`, plus `docs/consumers.md`.
- **Hardening and close-out (Phases 11, 13 to 15).** `--static-only` fails closed against
  plugins, added arguments and parser-faithful config values. Also: a mise route that installs,
  untrusted `mise.toml` named as such, `--pins` run outside the repo's mise config, `doctor`
  reading every flag and pin source, the pack and target docs, retired drafts, the opt-in
  audit, and a patched braces with a `security` gate that honors a repo's ignores.

## Decisions and why

The build settled 86 decisions in `intent.md`. These shaped it most:

- **One build, one TypeScript codebase.**
  [D1 (one-build)](./intent.md#d1) ordered fourteen phases by what the review agent in #6 and
  #7 needed first. [D3 (stay-typescript)](./intent.md#d3) kept the engine, since spawning,
  capturing and gating on an exit code was already language-agnostic.
- **Slots stay neutral; packs carry the language.** [D5 (packs)](./intent.md#d5) moved adapters
  into packs so a slot means the same thing in every language. [D6 (targets)](./intent.md#d6)
  made multi-target mode opt-in, and [D7 (scope)](./intent.md#d7) split slots into
  target-scope and repo-scope. C2 (legacy-invariance), held by the golden from step 20
  ([D51 (golden-placement)](./intent.md#d51)), meant no 0.13 repo noticed.
- **A verdict traces to the copy that produced it.** [D12 (pin-chain)](./intent.md#d12) resolves
  each tool through one chain with no fall-through, [D13 (pin-recorded)](./intent.md#d13) records
  `pin_source` and a file-read `tool_version`, and [D14 (no-fetch)](./intent.md#d14) switches
  off every launcher's download path, so a check never fetches.
- **A run says what it covered.** [D17 (run-record)](./intent.md#d17) put the selection, the git
  state and each spawned argv in the summary. [D22 (consumer-runs-write-nothing)](./intent.md#d22)
  keeps an outside run from ratcheting the repo's baseline.
- **Findings and the baseline can't drift.** [D28 (one-parser)](./intent.md#d28) derives
  fingerprints from the same parser the API serves. [D30 (gates-not-level)](./intent.md#d30)
  reports whether a finding can fail its check instead of a coarse level, because a tool's
  severity isn't what fails it.
- **`--static-only` is a selector that fails closed, not a sandbox.**
  [D26 (static-only)](./intent.md#d26) set the rule, and three later steps closed the ways a
  repo could still make a static tool load code: [D78 (static-fail-closed)](./intent.md#d78),
  [D79 (static-args)](./intent.md#d79) and [D81 (static-values)](./intent.md#d81).
- **e2e at every release point.** [D52 (e2e-cadence)](./intent.md#d52) kept the plumbbob gate at
  `pnpm check` and ran the whole e2e suite at each phase end, toolchains required.
- **Two cuts.** [D80 (binary-deferred)](./intent.md#d80) moved the standalone binary to a later
  build and made the mise route the supported way to run without Node.
  [D85 (schema-deferred)](./intent.md#d85) did the same for the `schema` slot, so checkride still
  ships no runtime dependency.
- **The audit goes green honestly.** [D86 (braces-patched)](./intent.md#d86) patched braces
  rather than waiting on upstream, and made the `security` gate read the advisories map, since
  pnpm 11 counts an ignored advisory in its totals.

## Parked & harvested

85 ideas were parked across the build. The harvests recorded 92 calls, because a few items split
in two at confirmation and a few were found at a harvest with no park line: 25 blockers, 67
tangents, and no pivot signal. Each blocker folded into `intent.md` as a decision, most of D55
to D86, often with a new step of its own. Among them are the readings verified against the real
tools (D65, D74, D76), the `--static-only` hardening (D78, D79, D81), and the binary cut (D80).
The `schema` cut (D85) came from an open question instead. Most tangents rode into a later step
whose seam already held the file. The rest were killed with a reason. The `## Harvest` section in `build-log.md` has every call.

## Final status

Done. All 80 planned steps landed and every park is harvested, with no open questions.
`pnpm check --include security` is green (`b742fa1`), and the whole e2e suite last ran green at
step 86: 20 files, 169 tests, toolchains required. Steps 66 to 71 (the `schema` slot and the
binary) were cut by decision, not left undone, and wait under `## Deferred to a later build` in
`intent.md` with their design intact. Cutting the release is the maintainer's `/version` call.

## Deferred tangents

- **The `schema` slot (steps 66 to 68)** and **the standalone binary (steps 69 to 71)**, per
  [D85 (schema-deferred)](./intent.md#d85) and [D80 (binary-deferred)](./intent.md#d80). Two
  harvested notes ride with step 66: `schema` joins `SLOTS` after `unclaimed`, and it reads a
  defaults file's `schemas` when the repo sets none.
- **`links` built-in excludes.** Add `vendor`, `.venv` and `target` beside `node_modules` and
  `.terraform`. A Go repo that commits `vendor/` gets a false red today, never a false green;
  until then it names the directory in the `links` check's `exclude` option.
- **`doctor`'s `toolVersion` for `go-mod-tool`, `rust-toolchain` and `uv-lock` rows.** The
  launcher already holds the version, but `docs/contract.md` documents the field as
  override-only, so widening it is an additive contract change.
- **Mutation testing's cost and floor.** Two step 78 tangents deferred to step 74 were never
  settled there. A full run takes about 3 hours on 8 cores, about half of it on 1026 static
  mutants (`ignoreStatic` would cut that, but drop them from C12 (quality-floors)'s score). The
  score was 83.13% against a break of 68, and `stryker.config.mjs` still cites 73.2%. Whether
  to ratchet the break amends C12.
- **mise trust under `MISE_YES`.** An inherited `MISE_YES` lets checkride's own mise calls trust
  a repo's `mise.toml` unasked. The call was mise's documented behavior on the user's own
  machine, and the docs could still say that `exec` trusts.
- **fascicle's audit comment**, handed off as
  [robmclarty/fascicle#14](https://github.com/robmclarty/fascicle/issues/14). It goes stale once
  fascicle takes the release carrying step 86.

## The opt-in audit

`pnpm check --include security` ran on 2026-10-18 at `f4f91b6` (step 73's checkpoint). It ran 19
checks, and `security` was the one red: `pnpm audit --audit-level=high` reported one advisory at
or above the gate and one below it.

- **High, GHSA-vfj7-8cjw-p6xm.** `braces` <=3.0.3 can exhaust the stack on deeply nested
  patterns, and no patched release exists yet. It reaches this repo only through the dev
  dependency `markdownlint-cli2` 0.23.3, by way of `globby`, `fast-glob` and `micromatch`.
- **Low, GHSA-238p-pmpm-9mq7.** `katex` from 0.11.0 to below 0.18.2 can bypass its trust
  restrictions through existing prototype pollution. 0.18.2 fixes it, and it reaches the repo
  through `markdownlint-cli2`, `markdownlint` and `micromark-extension-math`, so a pnpm override
  could take the fix.

Neither ships: checkride's `dependencies` is empty
([C6 (runtime-deps)](./intent.md#c6)), so a consumer's install never pulls either package. Both
are parked for a step or a dependency bump of their own. This is why the slot stays opt-in in
this repo's config ([C7 (house-style)](./intent.md#c7)): the verdict follows the day's advisory
feed, not the build's code.

**Step 86 followed up** ([D86 (braces-patched)](./intent.md#d86), `b742fa1`). braces now carries
micromatch/braces#88 as a pnpm patch, and `auditConfig.ignoreGhsas` ignores its advisory. Since
pnpm 11.28.5 still counts an ignored advisory in `metadata.vulnerabilities`, the `security`
built-in now counts from the report's `advisories` map. `pnpm check --include security` is green
on 2026-10-19. katex's low stays below the gate, because its fix is outside
micromark-extension-math's range.

The whole `pnpm test:e2e` ran green the same day, under `mise exec` with
`CHECKRIDE_REQUIRE_TOOLCHAINS=1`: 20 files and 169 tests in 196 seconds, none skipped
([D52 (e2e-cadence)](./intent.md#d52)).

## Closing #6 and #7

Each request, beside the step that shipped it and its commit. Paste one block per issue. Where a
request shipped in a different shape from the one it proposed, the line says how and why.

### For #6

> Everything below is on `main`, unreleased until the next version. Step numbers are the build's,
> with their commits.
>
> 1. **Which pinned copy ran.** Every check that spawns a tool records `pin_source` (`override`,
>    `js-lockfile`, `go-mod-tool`, `rust-toolchain`, `uv-lock`, `tf-version`, `mise` or `path`)
>    and, where a file read finds it, `tool_version` (step 30, `675c429`, with each pack's own
>    source in steps 41, 44, 58 and 62). The summary gains `run` and `git` (`head`, `dirty`, and
>    `base` under `--changed`) (step 8, `c0b3912`), every check gains `origin` and `detected_by`
>    (step 6, `eda7f17`), and a spawned check records its exact `argv` (step 9, `b0b7ad0`).
>    `tool_version` is read from files, never by running the tool, so `mise` and `path` record
>    none.
> 2. **Narrow `{go-packages}` under `--changed`.** At a `go.work` root, `go build` and `go test`
>    run only the modules a change touched plus their in-workspace dependents, read offline from
>    each `go.mod`'s `require` and `replace` and the `go.work`'s `replace`, and the entry records
>    `narrowed: { units, total }` (step 43, `c3cb2ab`). A change to `go.work`, `go.work.sum` or any
>    `go.mod`, or a graph it can't read, runs every module. deadcode and govulncheck read the
>    whole program, so they never narrow.
> 3. **`--out <dir>`.** `--out` and `CHECKRIDE_OUT` move the summary, the raw files and
>    `digest.md`, and `triage`, `qa`, `baseline` and `doctor` take it too (steps 10 and 11,
>    `27013d3` and `335d077`). With targets, each target's checks write under `<out>/<target>/`
>    (step 27, `773811b`).
> 4. **A findings API that keeps line numbers.** The `checkride/findings` subpath exports
>    `parseFindings(adapter, raw, options?)`, `findingsFor(check, runDir, { repoRoot })` and
>    `isParseable(adapter)` (step 49, `78a1cdd`). Each finding carries `file` from the repo root,
>    1-based `line` and `column`, `rule`, `message`, `severity` and `slot`. The baseline's
>    fingerprints and the API share one parser per format (step 48, `ecc4918`), so they can't
>    drift. Parsers now cover 21 adapters across the ts, repo, bash, go, rust, python and
>    terraform packs (steps 50, 51, 60 and 64).
> 5. **Custom checks can say "skipped".** `skipExitCode` on a custom check records
>    `skipped: true`, with `reason` its last stderr line and the exit code (step 1, `94ce4e3`).
> 6. **A baseline diff.** `checkride baseline diff [<ref>] [--json]` prints the keys added and
>    removed per check against `<ref>`'s committed baseline, `HEAD` by default (step 3,
>    `df795b6`).
>
> **On ordering:** the go pack (steps 41 to 47) and the extractors (steps 48 to 51) shipped in
> this build. The standalone binary and the `schema` slot moved to a later one.
>
> `docs/consumers.md` walks a review agent through all of it (step 57, `8e6db2c`).

### For #7

> Everything below is on `main`, unreleased until the next version. Step numbers are the build's,
> with their commits.
>
> 1. **A `python` pack.** Steps 58 to 61 (`7e20b45`, `46be7e6`, `f81d980`, `fdab7a6`) add it:
>    markers `pyproject.toml`, `setup.cfg` and `setup.py`, and tools resolved from `uv.lock` into
>    the project's `.venv`, then `mise`, then `PATH`, with pip's and uv's downloads switched off.
>    Its adapters are ruff for `lint` and the opt-in `format`, mypy or basedpyright for `types`,
>    and pytest for `test`. Two changes from the proposal: `requirements*.txt` isn't a marker,
>    since it's too common outside Python projects to mark one, and basedpyright stands in for
>    pyright, because its wheel bundles Node where the PyPI `pyright` wrapper downloads Node on
>    first run. vulture and import-linter stay out for now.
> 2. **A `terraform` pack.** Steps 62 to 65 (`c10173b`, `bafc979`, `00202d4`, `7385146`) add it:
>    markers `.terraform.lock.hcl` and `*.tf`, the CLI (`terraform` or `tofu`) pinned by
>    `.terraform-version` or `.opentofu-version`, then `mise`, then `PATH`, and adapters
>    terraform fmt (opt-in `format`), tflint (`lint`), terraform validate (`types`) and
>    `trivy config` (opt-in `security`). validate doesn't take the network: a check never runs
>    `init`, so where `.terraform/` is missing it fails naming `init -backend=false`, and it runs
>    only where a `.terraform.lock.hcl` marks a root module. checkov stays out.
> 3. **A defaults layer and outside pins.** `--defaults` and `CHECKRIDE_DEFAULTS` layer a config
>    under the repo's own, filling only what the repo and detection leave empty (step 53,
>    `7c47b8c`). `--pins <mise.toml>` and `CHECKRIDE_PINS` put your toolbelt at the head of every
>    pin chain as the `override` source (step 55, `d030bda`), reading no config file inside the
>    repo (step 84, `5b8323c`). `--discover` checks the targets the repo's files propose, writing
>    nothing (steps 54 and 78, `75bfd64` and `899b004`). `doctor` reads all three (step 81,
>    `18a31a5`).
> 4. **A static-only run.** `--static-only` keeps only checks that read the repo as data and skips
>    the rest with a `static-only: <cause>` reason, so the run is partial and never reads as a
>    full green (step 56, `e821065`). In place of one `runsRepoCode` flag, an adapter carries
>    `static`, plus the arguments, config files and config keys that make it load code
>    (`nonStaticArgs`, `codeArgs`, `codeConfigs` and `codeKeys`), since one flag can't say which
>    `.cjs` config or which `plugins` key flips a static tool. Three later steps close ways a
>    repo could still make a static tool load code: a tflint plugin (step 79, `86f81a2`), an
>    argument the repo's config adds, or a key hidden by YAML escapes or a flow mapping (step 80,
>    `4958cb1`), and a key's value read the way the tool's parser reads it (step 82, `6d6aec6`).
>    A custom check never qualifies. It's a best-effort selector, not a sandbox: a tool release
>    can add a way to load code these checks don't know.
> 5. **Severity in the parse API.** Each finding carries `severity`, the tool's own level verbatim,
>    and `slot` (step 49, `78a1cdd`). In place of a coarse `level`, it carries `gates`, where it
>    can be told: whether the finding can fail its check under the argv that ran. A tool's
>    severity isn't what fails a check (shellcheck fails on `info` findings, and golangci-lint on
>    every issue), so a coarse level would have called gate-failing findings advice.
>
> **On `--out` for two runs per PR:** `--config` and `CHECKRIDE_CONFIG` name a config file
> outside the repo (step 2, `cd1821f`), and `--out` keeps the two runs' artifacts apart (step 11,
> `335d077`).
>
> **On the follow-up comment:** `docs/contract.md` now lists every summary field, `adapter`
> included, and a contract test holds the list to the JSON Schema (step 5, `2a11104`).

## Checkpoints

- baseline dacfb84384771f8bb36c8aaba461e784957a9844
- plan 87cffc7a38557bf34f6ce5fba4214889ef1313ca
- step 20 d98f993295709601421725ce93e21538e26e7ee7
- step 1 94ce4e39013b1b95648d6c354caa0b7758b93d93
- step 2 cd1821f156eaa73726599da21410c882d82e01d9
- step 3 df795b68dbb5c26a0deb214a9cffadeedf10d512
- step 4 8c364ea5101fed9a0e897eda8d584403c8b67f40
- step 5 2a111046671d003eaffff681e25af27a770cec18
- step 6 eda7f176b43ac8c0d6e8882873fe35560c4dd643
- step 7 3376c858bfafac815b201d0ca4ed9e6dd9c60cb2
- step 8 c0b39120cb60affdcf000cdf277f46b3c2a59e5b
- step 9 b0b7ad01bae8ce2d32f4d30bf103900120c77198
- step 10 27013d39012b3255450f2b4f350e385a768f23d4
- step 11 335d07732e6e5228aa4fd15653d5ac469b0adef5
- step 12 64aafcd6fca6c337179274fa8037418fa39626ed
- step 13 8a10a26b5a6b67a2f123d11e384b9d6dc207830e
- step 14 c94445aa8a21a820ddddee0295b3c20501cef999
- step 15 515dd7261183be02dfe7d19b1d187821afe70719
- step 16 81b60a2fdef28c62f13e9e7121f489463d83e05c
- step 17 bb5f61066df6ac2083957ff9ff8196d6184ec74b
- step 18 71eef9f999b496dd9d67bb1282bf078e8e34521b
- step 19 cee9f51ce15314fcea5cf3c419fa11d248b209c8
- step 21 00b7e42376b8d98315aef4d002f7e90ec9172515
- step 22 65a6c27b103373d99332a738ed2cf37c62341025
- step 23 bee26afc36470a34be7aee0dcacaf034963a8476
- step 24 598f510d5bc0c93ef25ac78f9dcf876129327f55
- step 25 1d7103f24aa9073883beec5114a14ee1bbcdb180
- step 26 7ece7e05ba3258c2b55edb7dabeeaae179c7674f
- step 27 773811b6c25d9d7ee3485e8fe1f5b96b3d4c742b
- step 75 e75ff9be22ce5347f908f14b7997d3756ca3bd2b
- step 28 d1cf4a1fb28bca2bd32d23f737b1f1bf16376a16
- step 29 aed4967bc08ba9237154d769b5a0cd52c5fc231e
- step 30 675c4296f8c9ae046c5b0e880ac071e1202eac2d
- step 31 46f9504f75c62dc71d492b1d328dce064cfe3d48
- step 32 b547c5ed6323fec1e5fd926b05751b11dc164c6e
- step 33 fdae8024474725542569cf43c458ac8ab898bcab
- step 34 78349fa7b3baecf8391a53f0ae57cd4a2cb2336b
- step 35 7f3431d2414c7ae13289e72cc80fc39c86a3782a
- step 36 06db9e1f27239b2592cc3e7225839ba23dbb972b
- step 37 b5007f1f8db2d6ed49c3a933c90c5f8f53855fa1
- step 38 b52e5da3afc7f60b308fc35fd676aa2c6cca84a4
- step 39 4132d492154d915d41df3454f092ae43bdb919ca
- step 40 20593aa80179709d78816ed249d96dc89de073cb
- step 41 6e8630e90cb401b771388acd594249882ea1f183
- step 42 72ca9ea4ff89b33e13695de16e29e7774be44c6c
- step 43 c3cb2ab6b70758188a813cbf0003edf953fba690
- step 44 c7ce1a7d29c9b4ede6f839077ad41f0a29b22ba0
- step 45 a5ef832df7e94069fc90a496a8bb291fcff9f1b7
- step 46 7439cea268313eb4c11f1adcf5ebe8b8ab539628
- step 47 35668889e1e726c42bb0cbedc95370df793fa3a0
- step 48 ecc491814350c3315cb2c8071247008af0d4a835
- step 49 78a1cddfcc7beb6def5ea6de85da0a0fb3019cf1
- step 50 3153cdcb4ed9704046441996b18f90e31114179a
- step 51 74b793769a41696ff0ad1559ccfd6f949f209c8f
- step 76 2e0ffdf47326be1d4a609ced6ce987dc68d8cdf7
- step 52 fe986916e8ac3aa5cda04e66a9f291b553b94794
- step 53 7c47b8c458bd66eb53c9c9c193762eba9ceeeccb
- step 54 75bfd64eb8df90376596bce49de26f9f9aff8820
- step 55 d030bda477eceacd65f1e8dca598a2641aad219a
- step 56 e8210652455cc8e95dc70c2f46a43956db0d357e
- step 57 8e6db2c6b5e0214303d4e32ba1a1be892b2f3bb6
- step 77 a029ea8adc91eb03b19134dab37ab560d0df780a
- step 78 899b0043564078f870de8f6ea2f291e90e06b901
- step 58 7e20b452b2217bce16aaa16d8d9f7c80f5716cb2
- step 59 46be7e6ac414845ab39b11cac881ad07f0a8d07a
- step 60 f81d980f07ef92d62c9e409843730f37ef76e66e
- step 61 fdab7a645f01e0f17dd312a209f38871fc9a3580
- step 62 c10173b4c159f001dcdf082036715182d9b88c62
- step 63 bafc979c5b5cf13ef6eceb62a5ac9c5bd660f94a
- step 64 00202d44c5473afcb22579ef577a469ef83f7019
- step 65 73851466507b8c42cfa065d1f6ec25044a63ab63
- step 79 86f81a21937f495cbb386fe301332982dbce402e
- step 80 4958cb158b6bab09ab27afbbee51d4c9eef8d0a0
- step 82 6d6aec6f33e1e56e9d859642486b3d5ac70e6d81
- step 72 7f7dcf3871637c45ad202acf88f9cf705b5194d8
- step 83 07adc93b4b169dc3971b8b1d83174a78d65ec062
- step 84 5b8323c2d95c4903dcba38e2118fc0ae3fdb950a
- step 81 18a31a58e1ba4a822c0f97f5b84a1c211a1c5b15
- step 85 36d2de5afb3867c78cffba0fe97d36f941d648fe
- step 73 f4f91b6c2887debb055e945f59873a7125a8cf83
- step 74 ea333e47428b20fe8c80fe3f08ecb80fc831a984
- step 86 b742fa13102fc85729afe787119daecea7f94436

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
| ---- | ---------- | -------------- | ------- | ---------- |
| 1 | 0 | 0 | 0 | 8m |
| 2 | 0 | 1 | 0 | 19m |
| 3 | 0 | 1 | 0 | 33m |
| 4 | 0 | 1 | 0 | 13m |
| 5 | 0 | 0 | 0 | 7m |
| 6 | 0 | 1 | 0 | 11m |
| 7 | 0 | 1 | 0 | 7019m |
| 8 | 0 | 1 | 0 | 12m |
| 9 | 0 | 1 | 0 | 26m |
| 10 | 0 | 1 | 0 | 13m |
| 11 | 0 | 1 | 0 | 23m |
| 12 | 0 | 0 | 0 | 6m |
| 13 | 0 | 1 | 0 | 90m |
| 14 | 0 | 1 | 0 | 15m |
| 15 | 0 | 0 | 0 | 9m |
| 16 | 0 | 0 | 0 | 9m |
| 17 | 0 | 0 | 0 | 15m |
| 18 | 0 | 0 | 0 | 24m |
| 19 | 0 | 1 | 0 | 34m |
| 20 | 0 | 0 | 0 | 18m |
| 21 | 0 | 1 | 0 | 26m |
| 22 | 0 | 1 | 0 | 20m |
| 23 | 0 | 1 | 0 | 19m |
| 24 | 0 | 1 | 0 | 114m |
| 25 | 0 | 1 | 0 | 51m |
| 26 | 0 | 1 | 0 | 27m |
| 27 | 0 | 1 | 0 | 43m |
| 28 | 0 | 1 | 0 | 26m |
| 29 | 0 | 1 | 0 | 14m |
| 30 | 0 | 1 | 0 | 86m |
| 31 | 0 | 1 | 0 | 19m |
| 32 | 0 | 1 | 0 | 6m |
| 33 | 0 | 1 | 0 | 17m |
| 34 | 0 | 1 | 0 | 8m |
| 35 | 0 | 1 | 0 | 11m |
| 36 | 0 | 1 | 0 | 8m |
| 37 | 0 | 1 | 0 | 7m |
| 38 | 0 | 1 | 0 | 7m |
| 39 | 0 | 1 | 0 | 10m |
| 40 | 0 | 1 | 0 | 10m |
| 41 | 0 | 1 | 0 | 17m |
| 42 | 0 | 1 | 0 | 13m |
| 43 | 0 | 1 | 0 | 6m |
| 44 | 0 | 1 | 0 | 8m |
| 45 | 0 | 1 | 0 | 9m |
| 46 | 0 | 1 | 0 | 14m |
| 47 | 0 | 1 | 0 | 9m |
| 48 | 0 | 1 | 0 | 20m |
| 49 | 0 | 1 | 0 | 12m |
| 50 | 0 | 1 | 0 | 15m |
| 51 | 0 | 1 | 0 | 11m |
| 52 | 0 | 1 | 0 | 147m |
| 53 | 0 | 1 | 0 | 59m |
| 54 | 0 | 1 | 0 | 12m |
| 55 | 0 | 1 | 0 | 13m |
| 56 | 0 | 1 | 0 | 15m |
| 57 | 0 | 1 | 0 | 10m |
| 58 | 0 | 1 | 0 | 39m |
| 59 | 0 | 1 | 0 | 26m |
| 60 | 0 | 1 | 0 | 7m |
| 61 | 0 | 1 | 0 | 15m |
| 62 | 0 | 1 | 0 | 17m |
| 63 | 0 | 1 | 0 | 18m |
| 64 | 0 | 1 | 0 | 10m |
| 65 | 0 | 1 | 0 | 8m |
| 72 | 0 | 1 | 0 | 40m |
| 73 | 0 | 1 | 0 | 18m |
| 74 | 0 | 1 | 0 | 11m |
| 75 | 0 | 0 | 0 | 7m |
| 76 | 0 | 1 | 0 | 531m |
| 77 | 0 | 1 | 0 | 329m |
| 78 | 0 | 1 | 0 | 3m |
| 79 | 0 | 1 | 0 | 455m |
| 80 | 0 | 1 | 0 | 18m |
| 81 | 0 | 1 | 0 | 580m |
| 82 | 0 | 1 | 0 | 47m |
| 83 | 0 | 1 | 0 | 17m |
| 84 | 0 | 1 | 0 | 13m |
| 85 | 0 | 1 | 0 | 39m |
| 86 | 0 | 1 | 0 | 28m |
| **total** | 0 | 71 | 0 | 10599m |
