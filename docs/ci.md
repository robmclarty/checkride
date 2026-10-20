# Running checkride in CI

One job, one command, exit 0 = done. The recipe below is copy-paste for a
pnpm repo on GitHub Actions; the npm/yarn/bun variants follow.

```yaml
name: check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: pnpm/action-setup@v6 # reads the version from packageManager

      - uses: actions/setup-node@v6
        with:
          node-version: 24 # or 22 — checkride supports >=22.18
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # --strict: zero checks actually running is exit 2, never a silent pass.
      # A gate should always run strict.
      - run: pnpm exec checkride --strict

      # On failure, keep the raw diagnostics for humans and agents.
      - if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: check-report
          path: .check/
```

Notes:

- **Always pass `--strict` in CI.** Without it, a repo where no tool is
  detected (say, a misplaced config) exits 0 having verified nothing. With it,
  that run exits 2 and the job fails. See
  [the contract](./contract.md#vacuous-green).
- **Exit codes:** `0` pass, `1` a check failed, `2` the harness broke or was
  misused — a CI gate can treat 1 as "red build" and 2 as "fix the pipeline".
- If the repo uses `--changed` locally, still run the **full** (default) set in
  CI: CI is the place the whole pipeline gets observed, which is also what
  lets a committed baseline [ratchet](../README.md#baseline).
- **Wave concurrency depends on the runner's core count.** The default pool
  width is `min(4, cores)` when `CI` is set (every provider sets it) and
  `min(4, cores − 1)` locally, where a core is reserved to keep the machine
  responsive. A standard GitHub-hosted `ubuntu-latest` runner reports 2 CPUs,
  so its pool is 2; larger runners widen it up to the cap of 4, and
  `--concurrency <n>` overrides either way. To see whether your waves
  actually overlap, compare `total_duration_ms` in `.check/summary.json`
  against the sum of the per-check `duration_ms` values — equal numbers mean
  a fully serialized run. (Before 0.9.0 the local reservation also applied on
  CI, which collapsed a 2-core runner's pool to 1 and silently serialized
  every wave.)

## Writing artifacts somewhere else

`--out <dir>` (or `CHECKRIDE_OUT`) writes the summary, the raw output and the
digest to `<dir>` instead of `.check/`, and every line that points at an
artifact names `<dir>`. Use it when one job runs checkride more than once over
the same checkout, say once with the base branch's config and once with the
PR's, so each run keeps its own artifacts:

```bash
pnpm exec checkride --strict --config base.json --out "$RUNNER_TEMP/base"
pnpm exec checkride --strict --out "$RUNNER_TEMP/pr"
```

A directory outside the repo makes the run a consumer run: it never ratchets
`checkride.baseline.json`. `snippets` and `smoke` still generate their scratch
files under the repo's `.check/`, and skip when it can't be written. Separate
`--out` values keep artifacts apart but not the tools' own caches (tsc build
info, test caches, `.fallow/`), so runs that would fight over those belong in
separate worktrees. Archive `<dir>` on failure in place of `.check/`.

## Legacy repos with a baseline

If the repo adopted checkride with `checkride baseline`, commit
`checkride.baseline.json` and CI needs nothing extra: grandfathered
diagnostics are masked, new ones fail, and a full green run prunes fixed
entries from the baseline. The prune edits the file in the CI workspace only —
it won't be committed unless you add a step that does; locally the next full
run performs the same prune and the developer commits it.

One failure mode worth knowing: a merge — often an agent resolving a conflict
by deleting the "problem" lines — can silently drop baseline entries, and the
next CI run becomes a wall of "new, not in baseline" findings. The run
diagnoses this when it can: a red run whose new findings were grandfathered
until a recent commit prints a `hint:` line naming that commit, and
`checkride recover` restores the entries from git history additively. Both
need that history to exist in the clone — `actions/checkout` defaults to
`fetch-depth: 1`, which sees only the merged state — so run the recovery
locally (where full history lives), or give the checkout more depth.

## Other package managers

Replace the pnpm steps; the checkride invocation is identical.

```yaml
# npm
- uses: actions/setup-node@v6
  with: { node-version: 24, cache: npm }
- run: npm ci
- run: npx checkride --strict
```

```yaml
# yarn
- run: corepack enable
- uses: actions/setup-node@v6
  with: { node-version: 24, cache: yarn }
- run: yarn install --immutable
- run: yarn checkride --strict
```

```yaml
# bun
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
- run: bunx checkride --strict
```

The `security` slot (`pnpm audit`) is pnpm-specific and reports itself
unavailable under the others — see
[Package managers](./tools.md#package-managers). That's the ts pack's
`security`. The go, rust and terraform packs fill the slot with their own
tools, tied to no package manager: govulncheck for a go target, cargo-deny for
a rust one, and trivy's config scan for a terraform one. Each is opt-in.
govulncheck and cargo-deny read their advisory databases over the network, as
`pnpm audit` does, while trivy's scan runs offline on the checks it ships with.

## A repo without Node

A Go, Rust, Python or Terraform repo with no `package.json` pins checkride in
its `mise.toml` (`init --lang go` and `--lang rust` write it), so CI installs
it with mise rather than a package manager. Checks never download, so fetch
dependencies first:

```yaml
name: check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    env:
      # mise loads no mise.toml it hasn't trusted; this one is the repo's own.
      MISE_TRUSTED_CONFIG_PATHS: ${{ github.workspace }}
    steps:
      - uses: actions/checkout@v7

      # Installs every tool mise.toml pins: checkride and its Node, and the
      # language's own tools, such as go and golangci-lint.
      - uses: jdx/mise-action@v5

      # One per pack the repo uses: checks run offline, so a missing module,
      # crate, package or provider fails rather than downloads.
      - run: go mod download # cargo fetch, uv sync, terraform init -backend=false

      - run: mise exec -- checkride --strict

      - if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: check-report
          path: .check/
```

`MISE_TRUSTED_CONFIG_PATHS` trusts the repo's `mise.toml`, which mise won't
load untrusted while checkride's own pin there sets a tool option. mise already
trusts every config file when it detects a CI run, as on GitHub Actions; the
variable says so explicitly, and keeps the job working on a runner mise
doesn't recognize as CI. See [Installing checkride](./distribution.md) for the
pin itself.

## A repo with targets in other languages

A repo with a `package.json` and targets of other packs keeps the pnpm recipe
above, checkride still a devDependency, and adds what those targets need: the
step that puts their tools on `PATH`, and each pack's fetch, run from its
target's root:

```yaml
      - run: pnpm install --frozen-lockfile
      - uses: jdx/mise-action@v5 # go, golangci-lint, shellcheck, as mise.toml pins them
      - run: go mod download
        working-directory: services/api
      - run: pnpm exec checkride --strict
```

[A polyglot repo, end to end](./polyglot.md#in-ci) has the whole job for a
repo with TypeScript, Go and OpenTofu targets.

## Any other CI

Nothing above is GitHub-specific. On any CI that can run Node `>=22.18` —
GitLab, CircleCI, Buildkite, Jenkins, a bare shell — the job is the same three
steps: check out, install from the lockfile, run checkride with `--strict` and
gate on the exit code:

```bash
pnpm install --frozen-lockfile
pnpm exec checkride --strict   # or the npx / yarn / bunx form
```

A repo on the mise route runs `mise install` instead, with `mise trust` first
where mise doesn't detect CI, fetches its dependencies, and runs
`mise exec -- checkride --strict`.

If the platform supports build artifacts, archive `.check/` on failure the way
the GitHub recipe does — that is where humans and agents read the diagnostics.
