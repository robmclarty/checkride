# Cheat sheet

One-screen reference. New here, or need the full walk-through? See
[Getting started](./getting-started.md).

## Commands

```text
checkride              Run the default checks. Exit 0 pass / 1 fail / 2 error.
checkride init         Set up a project (new or existing — auto-detected).
checkride doctor       Verify environment + every slot's status (read-only).
checkride fix          Run every active adapter's fix command (oxlint --fix, …).
checkride baseline     Record current diagnostics as a committed baseline.
checkride agent-setup  Add the "check" alias, AGENTS.md stanza + agent hooks to a repo.
checkride hooks        Install/remove agent hooks only — never touches AGENTS.md.
checkride triage       Triage a red gate into one root cause (what /checkride:check runs).
checkride qa           Read the quality artifacts a previous run left.
```

Invoke as `pnpm check` (the alias `init` or `agent-setup` writes), or directly with
`pnpm exec checkride <command>` / `pnpm dlx checkride <command>`.

## Run flags

| Flag | Effect |
| ---- | ------ |
| `--bail` | Stop at the first failing check (runs sequentially; overrides `--concurrency`). |
| `--concurrency <n>` | Max checks running at once within a wave (`1` = sequential; default is a conservative cap from the CPU count). |
| `--only <a,b>` | Run only the named slots. |
| `--skip <a,b>` | Run everything except the named slots. |
| `--include <a,b>` | Add opt-in slots (`format`, `dupes`, `health`, `mutation`, `security`, `publint`, `attw`, `build`, `pack`, `smoke`, `snippets`) to the default run. |
| `--all` | Run every slot, including opt-in ones. |
| `--changed` | Affected-only mode (incremental types, changed-file tests). |
| `--json` | Write machine-readable output to stdout. |
| `--digest` | Write a token-bounded excerpt of the failing slots to `.check/digest.md` (empty run → removed). |
| `--strict` | Zero checks actually running is an error (exit 2), not a vacuous pass. Use it wherever checkride gates (CI, hooks). |

Output streams: human-readable progress goes to **stderr**; **stdout** carries
machine output only (the `--json` summary, mirroring `.check/summary.json`). In
the default mode stdout is empty — clean and pipe-friendly by design.

## init flags

| Flag | Effect |
| ---- | ------ |
| `--shape flat\|monorepo\|hybrid` | Project layout for a new repo. |
| `--name <n>` | Package name. |
| `--scope <@s>` | npm scope. |
| `--license <id>` | License identifier (default `MIT`). |
| `--author <a>` | Package author. |
| `--add <a,b>` | Scaffold config for the named empty slots. |
| `--baseline` | (existing repo) Grandfather current debt instead of disabling failing slots. |
| `--hook <a,b>` | Write only these hooks: `gate`, `dirty`, `protect` (also on `agent-setup`). |
| `--no-hook` | Skip writing the agent hooks (also honored by `agent-setup`). |
| `--remove-hook <a,b>` | Remove installed hooks — entry + generated script. With `--no-hook`, remove only. |
| `--harness <a,b>` | Write hooks for these harnesses: `claude`, `cursor`. Default: `claude`, plus `cursor` when `.cursor/` exists. |
| `--dry-run` | Print what would be written; change nothing. |

## `checkride hooks`

Hook management on its own. Unlike `agent-setup`, it never reads or writes
AGENTS.md — so an edited stanza cannot block it, and removing a hook cannot
rewrite your contract file.

| Command | Does |
| --- | --- |
| `checkride hooks add [a,b]` | Install the named hooks (default: all). |
| `checkride hooks remove <a,b>` | Tear out the named hooks — entry + generated script. An explicit list is required. |

Both take `--harness <a,b>` and `--dry-run`, and both are idempotent.

## npm-script aliases

`init` writes these into `package.json`:

| Script | Runs |
| ------ | ---- |
| `pnpm check` | `checkride` |
| `pnpm check:all` | `checkride --all` |
| `pnpm check:json` | `checkride --json` |
| `pnpm check:bail` | `checkride --bail` |
| `pnpm check:changed` | `checkride --changed` |
| `pnpm check:fix` | `checkride fix` |
| `pnpm doctor` | `checkride doctor` |

## The pipeline

Checks run in **waves**. Every slot carries an effective `order`: a number names
a wave — waves run in ascending order, and checks sharing a wave run
concurrently — or one of the words `first`, `last`, `middle`, `single`, `any`.
An omitted `order` is `any`: no ordering promise, run alongside the main group.
`--bail` runs everything sequentially and stops at the first failure (for the
default slots, still cheapest-first). The default run is everything except the
opt-in slots.

Numbering your own waves? Use gaps — `10`, `20`, `30` — leaving room to drop a
check between two later without shifting the others.

| Slot | Role | Default tool | Default run? |
| ---- | ---- | ------------ | ------------ |
| `types` | Type checking | `tsc --build` | yes |
| `format` | Formatting | `prettier` | opt-in |
| `lint` | Linting | `oxlint` | yes |
| `struct` | Structural rules | `ast-grep` | yes |
| `dead` | Dead code, deps, cycles, boundaries | `fallow` | yes |
| `test` | Tests + coverage | `vitest` | yes |
| `docs` | Markdown lint | `markdownlint-cli2` | yes |
| `links` | Relative markdown links resolve | built-in | yes |
| `spell` | Spelling | `cspell` | yes |
| `mutation` | Mutation testing | `stryker` | opt-in |
| `security` | Dependency audit | `pnpm audit` | opt-in |
| `publint` | Package publishing lint | `publint` | opt-in |
| `attw` | Type resolution across module systems | `attw --pack` | opt-in |
| `build` | Runs the consumer's build script | `<pm> run build` | opt-in |
| `pack` | Tarball ships the right files | built-in | opt-in |
| `smoke` | Built package imports cleanly | built-in | opt-in |
| `snippets` | Tagged doc fences type-check | built-in (`tsc`) | opt-in |

The last four are the **publish-ready bundle** — opt-in library slots that check
the shipped artifact (see [Tools](./tools.md#the-publish-ready-bundle)). `build`
is wave 10 so it runs before `pack`/`smoke`/`snippets`/`publint`/`attw` in wave 20.

A slot only runs if its config file is detected (or its tool is built-in). See
[Tools and installation](./tools.md) for the detect file and install command
per slot.

## The `.check/` output

Every run writes here. Treat it as a stable API for agents.

| File | Contents |
| ---- | -------- |
| `summary.json` | Aggregate report: per-check `ok`, `exit_code`, `duration_ms`. |
| `<slot>.json` | Raw tool JSON when stdout parses as JSON. |
| `<slot>.stdout.txt` / `<slot>.stderr.txt` | Raw streams when output is not JSON. |
| `digest.md` | `--digest` only: capped Markdown excerpt of the failing slots, each linking its raw file. Absent on a green run. |

To debug: read `summary.json` for the failing slot, then read that slot's raw
output for structured diagnostics. On a big repo, `--digest` writes a capped
`digest.md` to start from.

## When something is off

| Symptom | Do this |
| ------- | ------- |
| Not sure the environment is ready | `pnpm exec checkride doctor` |
| `doctor` says a tool is not installed | `pnpm install`, or `pnpm add -D <pkg>` |
| Fixable lint/format/markdown errors | `pnpm exec checkride fix` |
| A check is irrelevant to this repo | set `"<slot>": false` in `checkride.config.json` |
| Share one config across repos | set `"extends": "<path-or-pkg>"` in `checkride.config.json` (local keys win) |
| Want a hard gate for a coding agent | `checkride agent-setup` (or `init`) writes the hooks (gate + edit marker + baseline guard) for Claude Code and Cursor |
| Slow inner loop | `pnpm check --bail --only types,lint` or `--changed` |
| Red gate, want one root cause instead of the whole `.check/` | `checkride triage`, or `/checkride:check` — the [bundled plugin](./plugin.md) |
| Gate says "could not run", not red | Nothing ran; it is the environment, not the code. Usually the hook's Node: harnesses run hooks in a non-login shell. See [Node pins and hook context](./tools.md#node-pins-and-hook-context) |
| The hook's Node is not the one your shell has | Add a `.nvmrc` and checkride aligns the gate to it, or set `CHECKRIDE_NODE_BIN=<bin dir>` (`off` disables) |
| "Do the tests actually test anything?" | `checkride qa`, or `/checkride:qa` — same reader, reads the quality artifacts |
| Using Cursor rather than Claude Code | same `agent-setup`; see [Cursor](./cursor.md) |
