# Report: polyglot targets, language packs, and what a review agent needs

*(Step 74 wrote the two sections below. `/plumbbob:finish` adds the rest.)*

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
