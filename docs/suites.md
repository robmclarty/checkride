# Suites

A repo can keep more than one checkride suite. The **default suite** is the
one every repo has: `checkride.config.json`, `checkride.baseline.json` and
`.check/`. A **named suite** is a second set of checks beside it, with its own
config, its own baseline and its own output directory, run by name:

```bash
checkride --suite evals
```

A suite's name fixes its three paths, each at the repo root:

| Suite | Config | Baseline | Output directory |
| --- | --- | --- | --- |
| default | `checkride.config.json` | `checkride.baseline.json` | `.check/` |
| `evals` | `checkride.evals.config.json` | `checkride.evals.baseline.json` | `.check/suites/evals/` |

A name starts with a lowercase letter and holds only lowercase letters, digits
and hyphens. `config` and `baseline` are refused, since their files would read
as the default suite's. Setting `CHECKRIDE_SUITE=evals` does what the flag
does; the flag wins, and an empty variable counts as unset.

Commit the config and the baseline. The output directory sits under `.check/`,
so it's already ignored by git and by every tool that skips `.check/`.

## When a suite is worth having

The default suite gates the code: types, lint, tests, docs. Some projects have
a second kind of check that reads something else, and shouldn't ride along
with every code change. The case that prompted the feature is an application
that saves the records of its eval runs. Some of what those records show is a
plain pass or fail:

- no false answer on a case that should have been refused,
- no policy block,
- no code identifier in an answer a user reads,
- every label file beside the eval cases is well formed,
- the hash of the case pool is the one the last baseline recorded,
- no answer key is older than the index it's read against.

Each of these is cheap and deterministic, and each reads a saved run. They fit
checkride well: a summary, `triage`, and a baseline for the debt already
there. They don't belong in the code gate, which would then turn red for a
reason no code edit clears.

## An evals suite

A suite's config has the shape of any checkride config. Each check here is a
plain `command`: a script of the repo's own that reads the saved records and
exits 0 when they pass.

```json
{
  "checks": {
    "refusals": {
      "command": "node",
      "args": ["evals/checks/refusals.mjs", "evals/runs/latest.json"],
      "description": "No false answer on a case that should be refused"
    },
    "policy-blocks": {
      "command": "node",
      "args": ["evals/checks/policy-blocks.mjs", "evals/runs/latest.json"],
      "description": "No policy block in the run"
    },
    "identifier-leaks": {
      "command": "node",
      "args": ["evals/checks/identifier-leaks.mjs", "evals/runs/latest.json"],
      "description": "No code identifier in a user-facing answer"
    },
    "labels": {
      "command": "node",
      "args": ["evals/checks/labels.mjs", "evals/cases"],
      "description": "Every label file is well formed"
    },
    "case-pool": {
      "command": "node",
      "args": ["evals/checks/case-pool-hash.mjs", "evals/cases", "evals/pool.sha256"],
      "description": "The case pool is the one the last baseline recorded"
    },
    "answer-keys": {
      "command": "node",
      "args": ["evals/checks/answer-keys.mjs", "evals/keys", "evals/index.json"],
      "description": "No answer key is older than its index"
    }
  }
}
```

Save it as `checkride.evals.config.json` and run it:

```text
$ checkride --suite evals

Running 6 check(s) of suite evals...

  ✔ refusals          41ms  No false answer on a case that should be refused  [custom]
  ...

✔ all checks passed in 212ms
report: .check/suites/evals/summary.json
```

The summary carries `"suite": "evals"`, so a reader of the file knows which
suite wrote it. A run of the default suite carries no such field.

## A suite runs what its config declares

In the default suite, checkride detects the tools a repo has and fills each
slot it can. A named suite doesn't. It runs exactly the checks its config
declares: each custom check, and each slot the config names an adapter for.

```json
{
  "checks": {
    "docs": "markdownlint-cli2",
    "labels": { "command": "node", "args": ["evals/checks/labels.mjs", "evals/cases"] }
  }
}
```

That suite runs two checks. It doesn't run `lint` because the repo has an
oxlint config, and it doesn't run the `links` built-in, which every default
run does. An entry that only tunes a slot, such as `"lint": { "timeout": 30 }`,
is a config error in a suite, because no detected tool is left to take the
tuning. That holds on every machine, whether or not the repo has a linter.

`extends`, `order`, `timeout`, `optIn` and `targets` work as they do in the
default suite. A suite with `targets` runs, for each target, the checks its
blocks declare.

## What doesn't belong in a suite

A check is one exit code. Two kinds of result don't fit that, and are better
kept out:

- **Counts and trends.** "Three cases improved, none got worse" is a direction,
  not a pass or a fail. Folding it into an exit code throws away what it says.
  Write it to a report.
- **Anything that calls a model.** It's slow, it costs money, and it gives a
  different answer each time. A suite should read the records a model run
  left, not start one.

## The commands that take `--suite`

| Command | With `--suite evals` |
| --- | --- |
| `checkride` | Runs the suite's checks and writes `.check/suites/evals/` |
| `checkride fix` | Runs the fixers of the suite's checks |
| `checkride doctor` | Reports the suite's checks, baseline and output directory |
| `checkride baseline` | Captures into `checkride.evals.baseline.json` |
| `checkride baseline --versions` | Re-records the copies in that file |
| `checkride baseline diff` | Diffs that file against a ref |
| `checkride recover` | Restores that file from its own git history |
| `checkride gate` | Gates the suite, for a script that wants its verdict |
| `checkride triage` | Runs the suite and reads its output directory |
| `checkride qa` | Reads the suite's output directory |

`checkride doctor` without the flag lists the suites it finds on one `suites`
row. `init`, `agent-setup`, `hooks` and `target add` work on the default suite
only and don't take the flag.

Every hint one of these prints under `--suite` names a command with the flag
on it. A mangled suite baseline sends you to `checkride recover --suite
evals`, never to the bare command, which would act on the default suite's
file.

A suite that has no config file is a usage error, exit 2. The message names
the file it looked for and the suites the repo does hold:

```text
checkride: --suite names 'eval', which has no config: /repo/checkride.eval.config.json is missing; the suites here are evals
```

## Flags beside `--suite`

- `--config` is refused, since a suite's name already names its config.
- `--defaults` is refused, since a suite runs only what its config declares.
- `--discover` is refused for the same reason, on the run and on `doctor`:
  the targets it proposes come with detected checks, and a suite detects
  none.
- `--out <dir>` is allowed, and it wins for the directory. A directory outside
  the repo makes the run a consumer run, which never ratchets, as it does for
  the default suite.
- `--only`, `--skip`, `--include`, `--all`, `--changed`, `--bail`, `--json`,
  `--digest` and `--strict` work as they do in the default suite.

## Baselines

A suite keeps its own baseline, and no suite reads or writes another's.
`checkride baseline --suite evals` captures the suite's current findings into
`checkride.evals.baseline.json`. A full run of the suite prunes the findings
fixed since, under the rules a default run follows: a run narrowed by `--only`,
`--skip`, `--changed` or `--bail` never prunes. A full run of the default
suite leaves every suite's baseline as it is.

The `snippets` and `smoke` built-ins keep scratch files. A suite's go under
`.check/suites/<name>/`, apart from the default suite's, so a suite's run and
a default run never clear each other's.

The `protect` hook denies an agent's edits to any
`checkride.<name>.baseline.json`, as it does to `checkride.baseline.json`.

A baseline holds findings a parser can key. A custom `command` check has none,
so its failures aren't grandfathered. Suites that name adapters, such as
`"docs": "markdownlint-cli2"`, get the baseline in full.

## The stop gate stays on the default suite

The generated stop-gate hook runs `checkride gate`, which gates the default
suite and nothing else. That's on purpose. The hook blocks an agent's turn
until the code is green, and a red eval record isn't something the agent's
edit caused or can clear.

The gate also ignores `CHECKRIDE_SUITE`. A shell that exports the variable
still gets the default suite's verdict from the hook. Only the flag selects
another suite: `checkride gate --suite evals` runs the suite's check, reads
the `gate` profile in the suite's config, and reports on
`.check/suites/evals/`. It leaves the hook's edit marker alone, so the default
suite's gate still runs for the turn. A name it can't gate, such as a suite
with no config, isn't a usage error there. The gate blocks and gives the
reason in the hook's own protocol, so a hook that passes a wrong name says
what's wrong.

### What the check script needs

`gate --suite evals` and `triage --suite evals` don't run checkride directly.
They run the repo's `check` script, as the default gate does, and add
`--suite evals` after it. So the script has to pass its trailing arguments on
to checkride, and it can't fix a config of its own:

| `check` script | With `--suite evals` added |
| --- | --- |
| `checkride` | Works |
| `tsc --build && checkride` | Works: the flag lands on `checkride` |
| `checkride --config ci.json` | Exit 2: a suite can't be combined with `--config` |
| `checkride; echo done` | Runs the default suite: the flag lands on `echo` |
| `./scripts/check.sh` | Works only if the script passes `"$@"` to checkride |

`triage --suite` checks the script for `--config`, `--defaults` and
`--discover` before it starts, and says so. Neither command can tell whether
a wrapper script drops its arguments. If a suite's gate reports that the run
wrote no summary, look there first. A bare `checkride --suite evals` has none
of these limits, and is the form to run in CI.

Run a suite where its inputs change: after an eval run, in a CI job of its
own, or by hand.

```yaml
- run: pnpm exec checkride --suite evals --strict
```

## The `suites` name is taken

A target's artifacts land in `.check/<target>/`, so a target can't be named
`suites`. A config that declares one is a config error, and `checkride target
add suites` refuses the name.
