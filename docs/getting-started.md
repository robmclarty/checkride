# Getting started

A practical walk-through for getting checkride running — and for getting back up
to speed if it has been a while. The whole tool reduces to one rule:

> `pnpm check` is the definition of done. **Exit 0 means complete. Anything else
> means it is not.**

## Prerequisites

checkride spawns your project's tools; it does not bundle them. Three things
must exist on your machine *outside* the project:

| Tool | Minimum | Install |
| ---- | ------- | ------- |
| Node | `>=22.18` | <https://nodejs.org> or `nvm install 22 && nvm use 22` (24 works too) |
| pnpm | `>=9` | `corepack enable && corepack prepare pnpm@latest --activate` |
| git  | any | <https://git-scm.com/downloads> |

Everything else (oxlint, ast-grep, fallow, vitest, …) is a project
`devDependency` and is restored by `pnpm install`. See
[Tools and installation](./tools.md) for the full list and how to add a missing
one.

Verify the environment at any time:

```bash
pnpm exec checkride doctor
```

`doctor` is read-only. It checks Node/pnpm/git versions, that the project is
installed, and reports every slot's status (installed, opt-in, disabled, or no
tool detected). Exit `0` means you are ready to run.

## Add checkride to a project

`init` auto-detects whether the current directory is a new or existing project
by looking for a `package.json`.

### An existing repository

```bash
pnpm add -D checkride
pnpm exec checkride init
```

`init` is additive here. It inventories the tools you already have, writes only
what is missing (a `checkride.config.json`, a `check` script alias, an AGENTS.md
stanza), and never overwrites an existing tool config. Any adopted check that
fails on the first run is recorded as disabled so the initial `pnpm check` is
green — re-enable each slot as you fix it.

To scaffold a tool you do not have yet, name its slot with `--add`:

```bash
pnpm exec checkride init --add struct,dead
pnpm add -D @ast-grep/cli fallow
```

`--add` writes the config files (for example `sgconfig.yml` plus the rule set,
and `fallow.toml`); the follow-up `pnpm add -D` installs the tools themselves.

### A new project

From an empty directory:

```bash
pnpm dlx checkride init --shape flat --name my-app
pnpm install
pnpm check
```

`init` generates a complete, green-out-of-the-box repo. Pick a shape:

- **flat** — a single package using the deep-modules layout under `src/`.
- **monorepo** — a pnpm workspace of `apps/*` and `libs/*`.
- **hybrid** — a root app in `src/` plus internal `packages/*`.

Preview without writing anything using `--dry-run`.

## The daily loop

Once set up, daily usage is one command regardless of the tool's name, because
`init` writes a `check` script alias:

```bash
pnpm check
```

That runs the full pipeline — types, lint, structure, dead code, tests, docs,
links, spelling — cheapest checks first. Exit `0` and you are done.

While iterating, narrow the loop so feedback is fast:

```bash
pnpm check --bail            # stop at the first failing check
pnpm check --only types,lint # run just the named slots
pnpm check --changed         # affected-only (incremental types, changed tests)
```

Run the full `pnpm check` once at the end to confirm green.

## When a check fails

Every run writes machine-readable output to `.check/`. To debug a failure:

1. Read **`.check/summary.json`** — the aggregate report. Find the check whose
   `ok` is `false`.
2. Read that slot's raw output — **`.check/<slot>.json`** (for example
   `.check/lint.json`), or `.check/<slot>.stdout.txt` when the tool's output is
   not JSON.
3. Fix the root cause, not the symptom.
4. Re-run `pnpm check`.

Some failures have a one-shot fix. `checkride fix` runs every active adapter's
fix command (`oxlint --fix`, `markdownlint-cli2 --fix`, and so on):

```bash
pnpm exec checkride fix
```

Never claim a task is finished while `pnpm check` is red.

## Working with agents

checkride is an agent harness, so the goal of `init` is that a coding agent
adopts the "exit 0 = done" rule on its own.

### How agents pick it up

`init` writes the contract into two files:

- **`AGENTS.md`** — a stanza, between `<!-- checkride:begin -->` and
  `<!-- checkride:end -->` markers, stating that `pnpm check` is the definition
  of done, how to read `.check/` when it fails, the module-boundary conventions,
  and the tight-loop commands.
- **`CLAUDE.md`** — a short pointer to `AGENTS.md` (written only if you do not
  already have one).

Claude Code (and Codex, Cursor, Amp, …) load these instruction files into
context at the start of a session. That is the whole integration: the agent runs
`pnpm check` because it read the instruction, not because checkride hooks into
the tool. It is guidance, not enforcement — the model has to follow it.

`init` rewrites the stanza in place on every run, so keep any edits of your own
*outside* the `checkride:begin`/`checkride:end` markers, or the next `init` will
overwrite them.

### Make it a hard gate

To turn "exit 0 = done" from advice into a mechanical gate, checkride writes a
Claude Code **Stop hook** to `.claude/settings.json`. It fires when the agent
tries to finish; exiting `2` blocks the stop and feeds the message back, so the
agent keeps working until the pipeline is green.

`init` writes the hook automatically (both new and existing projects). To add it
to a repo you have already set up — without re-running the full `init` — use:

```bash
checkride agent-setup    # AGENTS.md stanza + Stop hook, nothing else
```

Both commands are idempotent (re-running is a no-op) and opt out with
`--no-hook`. The generated hook uses your **detected package manager** —
`pnpm run check`, `npm run check`, `yarn run check`, or `bun run check` — so it
works in any repo, not only pnpm ones:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pnpm run check || { echo 'checkride: the gate is red — read .check/summary.json, fix the failing slot, then finish (do not stop while checkride is red).' >&2; exit 2; }"
          }
        ]
      }
    ]
  }
}
```

The `|| { …; exit 2; }` wrapper matters: a plain `run check` exits `1` on
failure, which Claude Code treats as a non-blocking error and lets the agent
stop anyway. Exit `2` is the code that blocks. The hook input also carries a
`stop_hook_active` flag — check it if you want to break out of a fix loop that
is not converging. CI running `pnpm check` on every pull request is the other,
more important, hard backstop: the hook helps the agent locally, CI protects the
branch.

### Avoiding duplicate runs

A Stop hook and the AGENTS.md stanza both want `pnpm check`, so the agent can run
the full pipeline itself and then the hook runs it again. To head that off, the
generated stanza already tells the agent that *if a Stop hook is configured* it
owns the final full run — so iterate with the narrow commands and let the hook
run the authoritative pipeline once at the end. That is the "simplest fix" below,
applied by default.

Do **not** delete the AGENTS.md block to dodge the duplicate. The block does two
jobs — it tells the agent to run the gate, *and* it teaches the agent how to read
`.check/summary.json`, what the module conventions are, and which narrow commands
to iterate with. A Stop hook only replaces the first job; deleting the whole
block makes every agent worse at *fixing* what the hook flags, and it strands
non-Claude agents, since the hook is Claude Code only.

Whether the duplicate matters depends on your suite — pick by how expensive a run
is:

- **Fast suite (seconds):** accept the duplicate. The second run is cheap and
  guarantees the gate saw the final tree, whatever the agent did.
- **Slow suite (minutes), simplest fix:** rely on the stanza note above — the
  agent runs only cheap, narrowed checks during the loop, and the hook runs the
  one authoritative pipeline at the end.
- **Slow suite, most robust fix:** make the hook *verify the artifact instead of
  recomputing*. `.check/summary.json` records every slot that ran and whether it
  passed, so the hook can accept a complete, green summary that is newer than
  your sources and only run `pnpm check` when it is missing or stale. That
  removes the duplicate deterministically — it does not depend on the agent
  choosing not to run — at the cost of a slightly more involved hook.

## Where to go next

- [Cheat sheet](./cheatsheet.md) — every command and flag at a glance.
- [Tools and installation](./tools.md) — installing a missing tool, slot by slot.
- [README](../README.md) — the slot/adapter model and the `.check/` contract.
- [AGENTS.md](../AGENTS.md) — the contract for coding agents.
