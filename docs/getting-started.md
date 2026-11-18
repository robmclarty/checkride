# Getting started

The ten minutes after the [README](../README.md): installing checkride in the
repo you have, what `init` wrote, your first run, reading a red one, and the
loop you'll use from then on. The whole tool reduces to one rule:

> `pnpm check` is the definition of done. **Exit 0 means complete. Anything else
> means it is not.**

## Before you start

checkride runs your project's tools; it doesn't bundle them. Three things must
exist on your machine outside the project:

| Tool | Minimum | Install |
| ---- | ------- | ------- |
| Node | `>=22.18` | <https://nodejs.org> or `nvm install 22 && nvm use 22` (24 and 26 work too) |
| a package manager | pnpm `>=9` (default) / npm / yarn / bun | pnpm: `corepack enable && corepack prepare pnpm@latest --activate` |
| git  | any | <https://git-scm.com/downloads> |

A repo with no `package.json`, such as a Go or Rust project, needs
[mise](https://mise.jdx.dev) in place of the first two rows. Everything else,
oxlint, vitest and the rest, is the project's own, a devDependency or a pin in
the repo, and checkride runs the copy the repo has.

## Install it

In a repo with a `package.json`:

```bash
pnpm add -D checkride
pnpm exec checkride init
```

The same two steps under another package manager. `init` detects it and
spells the alias and stanza (and the stop gate, if you opt in) for it (see
[Package managers](./tools.md#package-managers)):

```bash
npm install -D checkride && npx checkride init
yarn add -D checkride && yarn checkride init
bun add -d checkride && bunx checkride init
```

The rest of this page uses pnpm's forms. In a repo with no `package.json`,
mise pins checkride and runs it:

```bash
mise use github:robmclarty/checkride@<version>
mise install
mise exec -- checkride init
```

From then on the command is `mise exec -- checkride` wherever this page says
`pnpm check`. [Installing checkride](./distribution.md) covers that route, the
standalone binary, and
[starting a new project](./distribution.md#starting-a-new-project) from an
empty directory.

## What `init` wrote

`init` is additive in a repo that exists. It inventories the tools you already
have and writes only what's missing:

- **`checkride.config.json`**, naming each check it set up and the tool that
  runs it. [Configuration](./configuration.md) covers every key.
- **A `check` script** in `package.json`, so the gate is `pnpm check`.
- **An AGENTS.md stanza** saying exit 0 means done, and an `@AGENTS.md` line in
  CLAUDE.md, so Claude Code loads it.
- **A guard hook** that refuses an agent's edit to the baseline and `.check/`.

It never overwrites a tool's own config. A check that fails on the first run is
written off in the config, `"lint": false`, so the first run is green, and the
summary names why each one failed; re-enable each as you fix it. A check that
can't run yet, such as a tool `package.json` declares and nothing installed,
is left on and named with what it needs, such as a `pnpm install`.
For a repo
with real debt, prefer `pnpm exec checkride init --baseline`: it keeps the
failing checks on and grandfathers today's findings into a committed
`checkride.baseline.json`, so only a new finding fails.
[The baseline](./baseline.md) has the details.

When the repo holds more than one project, such as a `go.mod` in
`services/api/` beside the app, `init` proposes a [target](./targets.md) for
each and writes them to the config. `--dry-run` previews any of this.

## Your first run

Check the environment, then run the gate:

```bash
pnpm exec checkride doctor
pnpm check
```

`doctor` is read-only. It checks Node, the package manager and git, names how
the repo is checked, and reports each slot's status (installed, opt-in,
disabled, or no tool detected) with where its tool comes from. Exit `0` means
you're ready.

`pnpm check` runs every check, cheapest first. Each status line ends with a
tag that says why the check ran: `[config]` when `checkride.config.json` names
it, `[detected: <file>]` when detection found its tool, as in
`[detected: .golangci.yml]`, and `[built-in]` or `[custom]` otherwise. A check
you didn't expect names the file that brought it in, and `"<slot>": false` in
the config turns it off.

## When a check fails

Every run writes its output to `.check/`, and a red check says why in the
terminal. Beneath its ✘ line it prints a short excerpt of the cause, then the
file that holds the rest:

```text
  ✘ lint         40ms  Oxlint, type-aware with oxlint-tsgolint  [detected: .oxlintrc.json]
           src/a.ts:3:7  Variable 'x' is declared but never used.  [eslint(no-unused-vars)]
           full output: .check/lint.json
```

For a tool checkride parses, the excerpt is up to five findings. For vitest
it's the tests that failed, each with its error. For any
other check, a custom `command` among them, it's the last eight lines the
check printed, from stdout and stderr both when both hold any. That's often
enough to fix it. When it isn't:

1. Read **`.check/summary.json`** — the aggregate report. Find the check whose
   `ok` is `false`.
2. Read that slot's raw output, the file its `full output:` line names — **`.check/<slot>.json`** (for example
   `.check/lint.json`), or `.check/<slot>.stdout.txt` when the tool's output is
   not JSON. In a repo with targets, a target's check writes under
   `.check/<target>/` instead, as `.check/web/lint.json`. A check refused
   before it ran, for a tool that isn't installed or a setup step that hasn't
   run, prints why under its ✘, records it as the check's `reason` in the
   summary, and keeps the full text in `.check/<slot>.stderr.txt`.
3. Fix the root cause, not the symptom.
4. Re-run `pnpm check`.

Some failures have a one-shot fix. `checkride fix` runs every active adapter's
fix command (`oxlint --fix`, `markdownlint-cli2 --fix`, and so on):

```bash
pnpm exec checkride fix
```

Never claim a task is finished while `pnpm check` is red.

## The daily loop

While iterating, narrow the loop so feedback is fast:

```bash
pnpm check --bail            # stop at the first failing check
pnpm check --only types,lint # run just the named slots
pnpm check --only api        # one target's checks, where the config declares targets
pnpm check --changed         # affected-only (incremental types, changed tests, untouched targets skipped)
```

Run the full `pnpm check` once at the end to confirm green.

## Let an agent loop

A coding agent reads the AGENTS.md stanza at the start of a session and runs
`pnpm check` because the stanza tells it to; that's usually enough. To make it
mechanical, opt in to the stop gate, which runs the check when the agent tries
to finish and sends it back while the run is red:

```bash
pnpm exec checkride hooks add
```

[Working with agents](./agents.md) covers the stanza, each hook, what the gate
costs and how to narrow it, and [Cursor](./cursor.md) where Cursor differs.

## Where to go next

[The docs index](./README.md) lists every page by the job it does. From here,
most readers want one of these:

- [Running in CI](./ci.md): the same gate on every pull request.
- [checkride on a team](./team.md): a repo several teams merge agent-written
  code into.
- [Cheat sheet](./cheatsheet.md): every command and flag at a glance.
