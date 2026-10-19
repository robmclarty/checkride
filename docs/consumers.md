# Running checkride from outside a repo

A pull-request reviewer, a CI job or an agent often runs checkride over a
checkout it didn't write, with its own config, defaults, pins and output
directory, and reads `summary.json` and the raw artifacts as evidence. This
page is for that consumer. The repo's own gate is unchanged by any of it.

**Nothing on this page is a sandbox.** checkride runs the tools a check names,
and those tools can run the code they read. `--static-only` picks the checks
that read the repo as data, judged by names and known config keys, and a tool
release can add a way to load code that judgment doesn't know. Run untrusted
pull requests inside a real sandbox, and treat each pass here as a way to
choose what runs there, never as protection.

## The flags a consumer uses

| Flag | Variable | What it does |
| --- | --- | --- |
| `--out <dir>` | `CHECKRIDE_OUT` | Writes the summary, the raw output and the digest to `<dir>` instead of `./.check`, so two runs over one checkout keep separate artifacts. |
| `--config <path>` | `CHECKRIDE_CONFIG` | Reads that config in place of `./checkride.config.json`. Its relative `extends` resolve against the file. |
| `--defaults <path>` | `CHECKRIDE_DEFAULTS` | Fills only the slots the repo's config and detection leave empty, from a config of yours. A check it fills records `origin: "defaults"`. |
| `--pins <mise.toml>` | `CHECKRIDE_PINS` | Runs each tool your `mise.toml` pins as that version, `mise exec <id>@<version>`, ahead of the repo's own pins. It never installs. |
| `--discover` | none | Checks the targets the repo's files propose, as `init` would declare them, without writing them. Where the repo's config declares targets, those run instead. |
| `--static-only` | none | Keeps only the checks that read the repo as data, and skips the rest with a `static-only:` reason. |
| `--base <ref>` | `CHECKRIDE_BASE` | The ref `--changed` measures from. |

[The contract](./contract.md) holds the exact rules each keeps.

A consumer run never rewrites the repo's files. A run with `--defaults`,
`--pins`, `--discover` or `--static-only`, a `--config` file outside the repo,
or an `--out` outside it never ratchets and never writes
`checkride.baseline.json`; stderr says so when a ratchet would have pruned
keys. checkride's only writes in the repo are the scratch files under a target
root's `.check/`, which the `snippets` and `smoke` checks use, and the tools it
runs may still write their own caches. The stop gate strips every one of these
variables from the check it spawns, so a consumer's environment never leaks
into the repo's own verdict.

## A defaults file

The defaults file is a config of yours that sits below the repo's: a slot the
repo names, or one detection fills, keeps the repo's tool, and yours fills only
the gap. It holds `checks`, `packs`, `extends`, `timeout`, `requirePins` and
`schemas`, never `targets`, which only the repo knows:

```json
{
  "checks": { "spell": "typos", "docs": "rumdl" },
  "packs": { "go": { "checks": { "lint": "golangci-lint" } } }
}
```

A top-level entry lands only on a check whose pack has the adapter it names,
so one file serves a TypeScript repo and a Go one. A slot the file fills keeps
its opt-in status: name an opt-in slot such as `format` and it still needs
`--include format`. A check of yours that reads the repo as data says so with
`static: true`, which only a defaults file may set, so `--static-only` keeps
it. An entry that hands a static tool an argument its own invocation doesn't
carry needs `static: true` too, since such an argument can load code: without
it, `--static-only` skips the entry, as it skips the same entry in the repo's
config.

## The two passes

The first pass runs before the repo is installed or sandboxed. It reads the
repo as data, with your own tools:

```bash
checkride --discover --defaults /agent/defaults.json --pins /agent/mise.toml \
  --static-only --changed --base "$BASE_SHA" --out "$RUN_DIR/static" --json
```

The second runs after the repo's install, inside the sandbox, with the repo's
own pins:

```bash
checkride --discover --defaults /agent/defaults.json \
  --changed --base "$BASE_SHA" --out "$RUN_DIR/full" --json
```

`--discover` is safe to pass to every repo. Where the repo's config declares
targets, the run checks those, as it would without the flag, and stderr says
once that they stand in for discovery: the repo's own targets are better
evidence than a guess from its files. Its summary still records
`run.discover`, and no target carries `discovered`.

In the first pass, each check that might run the repo's code or need its
install skips, and its reason says why:

```text
static-only: tsc isn't a static check
static-only: oxlint runs with --type-aware, which needs the install
static-only: .oxlintrc.json sets jsPlugins, which loads code
static-only: needs an install (the `docs` slot needs `markdownlint-cli2`, which is not installed in this project)
```

The checks that remain run your pinned copies wherever your `mise.toml` names
the tool: each records `pin_source: "override"` and the version it ran. Both
passes are consumer runs, so neither touches the repo's baseline.

`doctor` takes the same flags and runs no check. Before the first pass, it
lists each check that pass would skip, with the same reason, and for each tool
your `mise.toml` pins, the version mise has installed, or the `mise install` a
version it lacks needs:

```bash
checkride doctor --discover --defaults /agent/defaults.json \
  --pins /agent/mise.toml --static-only
```

mise reads no config file inside the repo for a tool your pins run. checkride
adds the repo root to `MISE_IGNORED_CONFIG_PATHS`, after any paths your
environment already names, both for the `mise where` that confirms the version
is installed and for the `mise exec` that runs it. A fresh clone whose
`mise.toml` mise hasn't trusted neither fails those checks nor gets trusted,
and the repo's `[env]` never reaches them. mise still reads a config file
above the checkout, so a refusal names `mise trust` only for a file there.

## Comparing the base branch's config with the pull request's

Check the base out next to the pull request, so the base config's relative
`extends` resolve against the base tree:

```bash
git worktree add --detach /tmp/base "$BASE_SHA"
checkride --config /tmp/base/checkride.config.json --out "$RUN_DIR/base-config" --json
checkride --out "$RUN_DIR/pr-config" --json
```

## Findings a pull request grandfathers

A pull request that adds keys to `checkride.baseline.json` hides findings
instead of fixing them. `baseline diff` lists what changed:

```bash
checkride baseline diff "$BASE_SHA" --json
```

## Reading the findings

`summary.json` says which checks failed. `checkride/findings` turns each
check's artifact into findings with a file, a line, a rule and whether it can
fail the check, using the same parsers the baseline keys with. `findingsFor`
opens the check's own artifact itself: its JSON `output_file`, or the text it
printed on stdout or stderr, so tsc, typos and markdownlint-cli2 findings arrive
the same way as oxlint's.

<!-- snippet: check -->
```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Summary } from 'checkride';
import { findingsFor, type Finding } from 'checkride/findings';

const repoRoot = process.cwd();
const runDir = join(repoRoot, '..', 'run', 'full');
const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) as Summary;
const comments: string[] = [];
for (const check of summary.checks) {
  const findings: Finding[] = findingsFor(check, runDir, { repoRoot }) ?? [];
  for (const finding of findings.filter((f) => f.gates === true)) {
    comments.push(`${finding.file}:${finding.line ?? 1} ${check.name} ${finding.rule}: ${finding.message}`);
  }
}
```

A finding with `gates: true` failed its check; key a review comment on its
`file` and `line`, which are named from the repo root. `findingsFor` returns
`null` for a check it has no parser for, one that was skipped, or one whose
output it can't trust, so the raw artifact stays the authority and the check's
`ok` stays the verdict. Each entry also says why it ran (`origin`, and
`detected_by` when detection chose its tool), which copy ran (`pin_source`,
`tool_version`) and exactly what it spawned (`argv`), and the summary's `run`
and `git` say what the run covered and which commit it read.
