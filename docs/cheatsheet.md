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
checkride baseline diff [<ref>]  Keys the working tree's baseline adds, drops or recounts against <ref>'s (default HEAD); --json for JSON.
checkride target add   Declare a target (<name> --lang <pack> --root <dir>); a repo without targets converts.
checkride recover      Restore checkride.baseline.json from git history (--pick applies).
checkride agent-setup  Add the "check" alias, AGENTS.md stanza + agent hooks to a repo.
checkride hooks        Install/remove agent hooks only — never touches AGENTS.md.
checkride triage       Triage a red gate into one root cause (what /checkride:check runs).
checkride qa           Read the quality artifacts a previous run left.
```

Invoke as `pnpm check` (the alias `init` or `agent-setup` writes), or directly with
`pnpm exec checkride <command>` / `pnpm dlx checkride <command>`. In a repo
without Node whose `mise.toml` pins checkride, run `mise exec -- checkride
<command>`.

## Run flags

| Flag | Effect |
| ---- | ------ |
| `--bail` | Stop at the first failing check (runs sequentially; overrides `--concurrency`). |
| `--concurrency <n>` | Max checks running at once within a wave (`1` = sequential; default is a conservative cap from the CPU count). |
| `--only <a,b>` | Run only the named checks, each a token: a slot, a custom check, a target, or `<target>:<slot>`. An unknown token exits 2. |
| `--skip <a,b>` | Run everything except the named checks, named the same way. It narrows `--only` too. |
| `--include <a,b>` | Add opt-in slots (`format`, `dupes`, `health`, `prose`, `mutation`, `security`, `publint`, `attw`, `build`, `pack`, `smoke`, `snippets`) to the default run. |
| `--all` | Run every slot, including opt-in ones. |
| `--changed` | Affected-only mode (incremental types, changed-file tests). With `targets`, skips each target nothing changed under, and a Go workspace's build and tests narrow to the modules a change touched and the ones that depend on them. |
| `--base <ref>` | The ref `--changed` measures from (or set `CHECKRIDE_BASE`, or `changedBase` in the config; the flag wins). Default `origin/main`, else `HEAD` with a warning. A named ref that doesn't resolve exits 2. |
| `--config <path>` | Read this config file instead of `./checkride.config.json` (or set `CHECKRIDE_CONFIG`; the flag wins). Also on `doctor`, `fix` and `baseline`. A file outside the repo never ratchets the baseline. |
| `--out <dir>` | Write the summary, raw output and digest to `<dir>` instead of `./.check` (or set `CHECKRIDE_OUT`; the flag wins). Also on `baseline`, `triage` and `qa`; `doctor` probes it. A directory outside the repo never ratchets the baseline. |
| `--pins <mise.toml>` | Run each tool this file's `[tools]` pins as that version, `mise exec <id>@<version>`, ahead of the repo's pins (or set `CHECKRIDE_PINS`; the flag wins). Never installs: a version mise lacks fails the check. Also on `doctor`, which reports the version mise has for each. Never ratchets the baseline. |
| `--static-only` | Keep only the checks that read the repo as data, skipping each that would run its code or need its install with a `static-only:` reason. A selector for a pass before the install, not a sandbox. Also on `doctor`. Never ratchets the baseline. |
| `--discover` | Check the targets the repo's files propose, as `init` would declare them, without writing anything. Where the config declares `targets`, those run instead, with a note on stderr. Also on `doctor`. Never ratchets the baseline. |
| `--defaults <path>` | Fill the slots the repo's config and detection leave empty from this config file, marked `[defaults]` (or set `CHECKRIDE_DEFAULTS`; the flag wins). It never beats a detected tool, and can't declare `targets`. Also on `doctor`. A run with it never ratchets the baseline. |
| `--json` | Write machine-readable output to stdout. |
| `--digest` | Write a token-bounded excerpt of the failing slots to `digest.md` beside the summary, which carries it as `digest`, and print it on stderr below the report; a green run removes any stale one. |
| `--strict` | Zero checks actually running is an error (exit 2), not a vacuous pass. Use it wherever checkride gates (CI, hooks). |

Output streams: human-readable progress goes to **stderr**; **stdout** carries
machine output only (the `--json` summary, mirroring `.check/summary.json`). In
the default mode stdout is empty — clean and pipe-friendly by design.

## init flags

| Flag | Effect |
| ---- | ------ |
| `--lang ts\|go\|rust` | Language of a new repo (default `ts`). Go and Rust write no `package.json`. |
| `--shape <s>` | Project layout for a new repo: `flat\|monorepo\|hybrid` for ts, `module\|workspace` for go, `crate\|workspace` for rust. |
| `--module <path>` | (go) The module path (default `example.com/<name>`). |
| `--name <n>` | Package name. |
| `--scope <@s>` | npm scope. |
| `--license <id>` | License identifier (default `MIT`). |
| `--author <a>` | Package author. |
| `--add <a,b>` | Scaffold config for the named empty slots. |
| `--baseline` | (existing repo) Grandfather current debt instead of disabling failing slots. |
| `--force` | Overwrite existing files (new repo), or refresh an AGENTS.md stanza carrying local edits (existing repo), instead of refusing. |
| `--hook <a,b>` | Write only these hooks: `gate`, `dirty`, `protect` (also on `agent-setup`). |
| `--no-hook` | Skip writing the agent hooks (also honored by `agent-setup`). |
| `--remove-hook <a,b>` | Remove installed hooks — entry + generated script. With `--no-hook`, remove only. |
| `--harness <a,b>` | Write hooks for these harnesses: `claude`, `cursor`. Default: `claude`, plus `cursor` when `.cursor/` exists. |
| `--dry-run` | Print what would be written; change nothing. |

## `checkride target add`

`checkride target add <name> --lang <pack> --root <dir>` declares a target in
`checkride.config.json`, naming each tool its root already configures. In a
repo with no targets yet, the implicit project becomes a target of its pack
named `app` at `.`, its top-level entries and baseline keys moving with it.

| Flag | Effect |
| ---- | ------ |
| `--lang <pack>` | The target's pack: `ts`, `bash`, `go`, `rust`, `python` or `terraform`. |
| `--root <dir>` | Its directory, relative to the repo root (`.` for the root). |
| `--add <a,b>` | Name the blessed tool for these slots; a ts, python or terraform target also gets its config scaffolded under the root. |
| `--root-name <n>` | The name a converted repo's implicit target takes (default `app`). |
| `--dry-run` | Print the changes; write nothing. |

## `checkride hooks`

Hook management on its own. Unlike `agent-setup`, it never reads or writes
AGENTS.md — so an edited stanza cannot block it, and removing a hook cannot
rewrite your contract file.

| Command | Does |
| --- | --- |
| `checkride hooks add [a,b]` | Install the named hooks (default: all). |
| `checkride hooks remove <a,b>` | Tear out the named hooks — entry + generated script. An explicit list is required. |

Both take `--harness <a,b>` and `--dry-run`, and both are idempotent.

## `checkride recover`

Restore `checkride.baseline.json` from git history after a merge dropped or
mangled entries (missing entries fail closed — that's the wall of red). Bare
`recover` lists up to five distinct committed states plus their union, with
`+restored/−absent` deltas against the current file; picking one writes an
ordinary working-tree edit to review and commit — never a `git checkout`.

| Flag | Effect |
| ---- | ------ |
| `--pick <n\|sha\|union>` | Apply a listed candidate — the additive union with the current file (the sha is the stable handle for scripts). |
| `--exact` | Write the picked snapshot verbatim instead of the union. Refused while the file has uncommitted changes. |
| `--dry-run` | Preview the per-slot delta; write nothing. |
| `--depth <n>` | Commits of file history to walk (default 25). |
| `--json` | Machine listing / apply result on stdout. |

## npm-script aliases

A new project's `package.json` carries these. In an existing repo, `init` and
`agent-setup` add `check` alone, and a repo without a `package.json` runs
`mise exec -- checkride <args>` instead:

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
| `dupes` | Code duplication | `fallow` | opt-in |
| `health` | Complexity / maintainability | `fallow` | opt-in |
| `test` | Tests + coverage | `vitest` | yes |
| `docs` | Markdown lint | `markdownlint-cli2` | yes |
| `links` | Relative markdown links resolve | built-in | yes |
| `spell` | Spelling | `cspell` | yes |
| `prose` | Writing style | `vale` | opt-in |
| `mutation` | Mutation testing | `stryker` | opt-in |
| `security` | Dependency audit | `pnpm audit` | opt-in |
| `publint` | Package publishing lint | `publint` | opt-in |
| `attw` | Type resolution across module systems | `attw --pack` | opt-in |
| `build` | Runs the consumer's build script | `<pm> run build` | opt-in |
| `pack` | Tarball ships the right files | built-in | opt-in |
| `smoke` | Built package imports cleanly | built-in | opt-in |
| `snippets` | Tagged doc fences type-check | built-in (`tsc`) | opt-in |
| `unclaimed` | Every toolchain marker sits in a target | built-in | with `targets` |

`build`, `publint`, `attw`, `pack`, `smoke` and `snippets` are the
**publish-ready bundle** — opt-in library slots that check the shipped artifact
(see [Tools](./tools.md#the-publish-ready-bundle)). `build` is wave 10 so it
runs before `pack`, `smoke`, `publint` and `attw` in wave 20; `snippets` checks
your source in any wave, and `snippets-dist`, which checks the built `.d.ts`,
joins wave 20. The other packs fill these slots with their own tools: see
[Packs and pins](./packs.md).

A slot only runs when `checkride.config.json` names its tool, detection finds
one (its config file, a dependency, or for another pack a pin or the root's own
marker, such as `go.mod`), or its tool is built-in. See
[Tools and installation](./tools.md) for the detect file and install command
per slot.

## The `.check/` output

Every run writes here. Treat it as a stable API for agents.

| File | Contents |
| ---- | -------- |
| `summary.json` | Aggregate report: the flags the run was given and the commit it read (`run`, `git`), and per check `ok`, `exit_code`, `duration_ms`, why it runs, the argv and pin it ran with, and the `reason` it was refused or skipped. |
| `<slot>.json` / `<slot>.jsonl` | Raw tool JSON, or JSON lines, when the check declares that file and its stdout takes that form. |
| `<slot>.stdout.txt` / `<slot>.stderr.txt` | Raw streams otherwise. A check refused before it ran prints why under its ✘ and keeps the full text in its `.stderr.txt`. |
| `<target>/` | With `targets`, each target's checks write the same files under their target's directory, as `web/lint.json`. |
| `digest.md` | `--digest` only: capped Markdown excerpt of the failing slots, each linking its raw file, and the text of the summary's `digest`. Absent on a green run. |

To debug: start beneath each red ✘. A check says why it failed when it says,
then lists the findings a baseline didn't grandfather, or a `go test` run's
failing tests, or else names its first finding, with how many more
(`src/a.ts:3:7 Variable 'x' is declared but never used. (+4 more)`), for a
check whose tool checkride parses. Then read `summary.json` for the failing
slot, and that slot's raw output for structured diagnostics. On a big repo,
`--digest` prints a capped excerpt below the report, and keeps it in
`digest.md`, to start from.

## When something is off

| Symptom | Do this |
| ------- | ------- |
| Not sure the environment is ready | `pnpm exec checkride doctor` |
| `doctor` says a tool is not installed | `pnpm install`, or `pnpm add -D <pkg>`; `mise install` for a tool `mise.toml` pins; otherwise the command its hint names, such as `uv sync` |
| A check runs that your config never named | Its status line's tag names why, as `[detected: <file>]`; set `"<slot>": false` to stop it |
| Checks fail naming `mise trust` | mise won't read a `mise.toml` it hasn't trusted: review the file, then `mise trust` |
| `unclaimed` fails | A toolchain marker sits outside every target: `checkride target add <name> --lang <pack> --root <dir>`, or add a glob for its path to `unclaimed.ignore` |
| Fixable lint/format/markdown errors | `pnpm exec checkride fix` |
| A check is irrelevant to this repo | set `"<slot>": false` in `checkride.config.json` |
| Share one config across repos | set `"extends": "<path-or-pkg>"` in `checkride.config.json` (local keys win) |
| Want a hard gate for a coding agent | `checkride agent-setup` (or `init`) writes the hooks (gate + edit marker + baseline guard) for Claude Code and Cursor |
| Slow inner loop | `pnpm check --bail --only types,lint` or `--changed` |
| Red gate, want one root cause instead of the whole `.check/` | `checkride triage`, or `/checkride:check` — the [bundled plugin](./plugin.md) |
| Wall of "new, not in baseline" right after a merge (or a `hint:` line names a commit) | `checkride recover` lists restorable baseline states; `--pick <sha>` restores additively — not `checkride baseline`, which would grandfather new debt too |
| Gate says "could not run", not red | Nothing ran; it is the environment, not the code. Usually the hook's Node: harnesses run hooks in a non-login shell. See [Node pins and hook context](./tools.md#node-pins-and-hook-context) |
| The hook's Node is not the one your shell has | Add a `.nvmrc` and checkride aligns the gate to it, or set `CHECKRIDE_NODE_BIN=<bin dir>` (`off` disables) |
| "Do the tests actually test anything?" | `checkride qa`, or `/checkride:qa` — same reader, reads the quality artifacts |
| Using Cursor rather than Claude Code | same `agent-setup`; see [Cursor](./cursor.md) |
