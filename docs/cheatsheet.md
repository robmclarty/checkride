# Cheat sheet

One-screen reference. New here, or need the full walk-through? See
[Getting started](./getting-started.md).

## Commands

```text
checkride            Run the default checks. Exit 0 pass / 1 fail / 2 error.
checkride init       Set up a project (new or existing — auto-detected).
checkride doctor     Verify environment + every slot's status (read-only).
checkride fix        Run every active adapter's fix command (oxlint --fix, …).
```

Invoke as `pnpm check` (the alias `init` writes), or directly with
`pnpm exec checkride <command>` / `pnpm dlx checkride <command>`.

## Run flags

| Flag | Effect |
| ---- | ------ |
| `--bail` | Stop at the first failing check. |
| `--only <a,b>` | Run only the named slots. |
| `--skip <a,b>` | Run everything except the named slots. |
| `--include <a,b>` | Add opt-in slots (`format`, `mutation`, `security`, `publint`, `attw`) to the default run. |
| `--all` | Run every slot, including opt-in ones. |
| `--changed` | Affected-only mode (incremental types, changed-file tests). |
| `--json` | Write machine-readable output to stdout. |

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
| `--dry-run` | Print what would be written; change nothing. |

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

Slots run cheapest-first so `--bail` fails fast. The default run is everything
except the opt-in slots.

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

To debug: read `summary.json` for the failing slot, then read that slot's raw
output for structured diagnostics.

## When something is off

| Symptom | Do this |
| ------- | ------- |
| Not sure the environment is ready | `pnpm exec checkride doctor` |
| `doctor` says a tool is not installed | `pnpm install`, or `pnpm add -D <pkg>` |
| Fixable lint/format/markdown errors | `pnpm exec checkride fix` |
| A check is irrelevant to this repo | set `"<slot>": false` in `checkride.config.json` |
| Share one config across repos | set `"extends": "<path-or-pkg>"` in `checkride.config.json` (local keys win) |
| Slow inner loop | `pnpm check --bail --only types,lint` or `--changed` |
