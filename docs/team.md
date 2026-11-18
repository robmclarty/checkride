# checkride on a team that merges agent-written code

This page is for a team whose pull requests are written, in part or whole, by
coding agents, and who merge them through branch protection and a merge
queue. It walks one repo, [`examples/local-targets`](../examples/local-targets/),
from the config each team owns to the workflow that gates the merge, and ends
on what a green gate still leaves a reviewer to read.

## The repo

Two teams share the repo. The web team owns `web/`, a TypeScript app, and the
API team owns `services/api/`, a Go service. The root config names their roots
and nothing else:

```json
{
  "targets": {
    "web": { "root": "web", "local": true },
    "api": { "root": "services/api", "local": true }
  },
  "unclaimed": { "ignore": ["package.json"] }
}
```

`"local": true` hands the rest of each target to the `checkride.config.json`
at its root: the web team picks its checks and adds `web:greeting` in
`web/checkride.config.json`, and the API team adds `api:vet` in
`services/api/checkride.config.json`. Neither edits the other's file or the
root one. Each target's grandfathered findings sit beside its config, in
`web/checkride.baseline.json` and `services/api/checkride.baseline.json`, so a
fix in `web/` prunes the web team's file and no other.
[Targets](./targets.md#local-targets) has the rules for what a local file may
hold.

It's still one run. `pnpm check` from the root, or from anywhere inside
`web/`, writes one summary and one exit code, and a developer in `web/` gets
the web team's checks alone without asking for them.

## One required check

Branch protection requires one status check, the workflow's `check` job, and
the merge queue requires the same one. It runs `checkride --strict`. Without
`--strict`, a run in which no check ran, such as one whose tools never
installed, exits 0 having verified nothing; with it, that run exits 2 and the
job fails. Exit 1 is a red change, and exit 2 is a broken pipeline, so the job
log already says which kind of failure it is.

## Changed on each push, everything in the queue

An agent pushes often. On each push to a pull request, the job passes
`--changed`, which skips every target the change didn't touch: a push that
edits only `web/` runs no Go tool. `CHECKRIDE_BASE` names the pull request's
base, and the checkout's `fetch-depth: 0` lets the run reach it.

The merge queue runs the full set on the commit that will land, and so does a
push to `main`. That full run is what proves the merged result, which no
single branch ever checked.

## Findings where the reviewer reads

Two flags put the verdict on the pull request's pages:

- `--annotate github` writes each finding of a red check as an annotation, so
  it shows on the changed line in the diff.
- `--summary github` appends a table to the run's page: each check, its status
  and time, its new findings, and the baseline keys the change added and
  removed against the base.

Neither changes the exit code. [Running in CI](./ci.md) covers both in full.

## Guard the baseline

A green check can still hide a grandfathered finding. An agent told to make
the gate green can run `checkride baseline`, which writes today's findings
into the baseline file, and the run is green again. The guard hook refuses an
agent's direct edit to a baseline file in a Claude Code or Cursor session, but
a pull request can still carry a grown baseline, however it was written.

`checkride baseline diff --fail-on-added` catches it in CI. The workflow runs
it as a job of its own, `baseline-guard`, against the merge base:

```bash
checkride baseline diff "$(git merge-base origin/main HEAD)" --fail-on-added
```

It exits 1 when the change grandfathers a key the merge base lacks, in any of
the three baseline files, and diffing against the merge base rather than the
tip of `main` keeps a key `main` pruned since from reading as added.

The guard is not a required check. Some changes grow a baseline honestly: the
pull request that adopts checkride, one that turns on a check over old code,
or a tool upgrade that reports more. The flag has no override, because an
override in the tool would be the loophole it closes. Instead the guard stays
outside the required set, and a person who owns the file reads the red job
and merges over it on purpose.

## Who owns the record

`CODEOWNERS` names that person. One line covers every config and baseline file
checkride reads, and a team's own lines hand it its own:

```text
checkride*.json                  @example-org/platform
/web/checkride*.json             @example-org/web
/services/api/checkride*.json    @example-org/api
```

GitHub applies the last line that matches, so a change to
`web/checkride.baseline.json` asks the web team, and a change to the root
config asks the platform team. With "require review from code owners" on, a
pull request that grandfathers web findings waits for a web reviewer even
though its `check` is green.

## The workflow

This is `examples/local-targets/.github/workflows/check.yaml`, whole:

```yaml
name: check

on:
  pull_request:
  merge_group:
  push:
    branches: [main]

jobs:
  # The required status check. Branch protection and the merge queue both
  # name it, so a pull request merges only on its green.
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # --changed and the step summary read main's history

      - uses: pnpm/action-setup@v6
        with:
          version: 11

      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm

      - uses: actions/setup-go@v6
        with:
          go-version-file: services/api/go.mod

      - run: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0

      - run: pnpm install --frozen-lockfile

      - run: go mod download
        working-directory: services/api

      # Each push to a pull request checks the targets it touched.
      - if: github.event_name == 'pull_request'
        run: pnpm exec checkride --strict --changed --annotate github --summary github
        env:
          CHECKRIDE_BASE: ${{ github.event.pull_request.base.sha }}

      # The merge queue and main check everything.
      - if: github.event_name != 'pull_request'
        run: pnpm exec checkride --strict --annotate github --summary github
        env:
          CHECKRIDE_BASE: ${{ github.event.merge_group.base_sha || github.event.before }}

      - if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: check-report
          path: .check/

  # Not a required check. A red guard means the change grandfathers findings,
  # and a code owner of the baseline file merges over it on purpose.
  baseline-guard:
    if: github.event_name != 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the merge base needs main's history

      - uses: pnpm/action-setup@v6
        with:
          version: 11

      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm exec checkride baseline diff "$(git merge-base origin/main HEAD)" --fail-on-added
```

## What a green gate leaves for a reviewer

A green `check` says every check the repo has passed on the commit that will
land, and the guard says no finding was grandfathered on the way. It doesn't
say the change does what was asked, that its tests test the right thing, or
that its design will hold. Those are still the reviewer's to read.

runciter, which runs agent work in parallel lanes, measured the gap: in five
of seven lane reviews, a fresh reviewer found a blocking defect in a change
whose check was green. The gate doesn't replace that review. It changes where the review
starts: a reviewer opens a change that already builds, type-checks, lints and
passes its tests, and spends the time on whether it's right.
