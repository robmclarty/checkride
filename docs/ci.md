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
      - uses: actions/checkout@v6

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
        uses: actions/upload-artifact@v4
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

## Legacy repos with a baseline

If the repo adopted checkride with `checkride baseline`, commit
`checkride.baseline.json` and CI needs nothing extra: grandfathered
diagnostics are masked, new ones fail, and a full green run prunes fixed
entries from the baseline. The prune edits the file in the CI workspace only —
it won't be committed unless you add a step that does; locally the next full
run performs the same prune and the developer commits it.

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
[Package managers](./tools.md#package-managers).

## Any other CI

Nothing above is GitHub-specific. On any CI that can run Node `>=22.18` —
GitLab, CircleCI, Buildkite, Jenkins, a bare shell — the job is the same three
steps: check out, install from the lockfile, run checkride with `--strict` and
gate on the exit code:

```bash
pnpm install --frozen-lockfile
pnpm exec checkride --strict   # or the npx / yarn / bunx form
```

If the platform supports build artifacts, archive `.check/` on failure the way
the GitHub recipe does — that is where humans and agents read the diagnostics.
