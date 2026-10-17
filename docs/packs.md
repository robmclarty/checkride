# Packs and pins

A pack is one language's adapters, together with where its tools are pinned
and the environment its checks run with. Three packs ship so far: `ts`, which
checks TypeScript code, `repo`, which checks the repo as a whole (`struct`,
`docs`, `links`, `spell` and `prose`), and `bash`, which checks shell scripts.
This page covers how a check's tool resolves to the copy that runs, what the
summary records about that copy, the bash pack and the file lists its checks
run over, and the spawn environment each pack sets. Packs for Go, Rust, Python
and Terraform arrive in later releases, and the rows below that belong to them
say so.

## Pin chains

Each pack names a pin chain: the pin sources its tools resolve through, in
order.

| Pack | Pin chain |
| --- | --- |
| `ts` | `js-lockfile` |
| `repo` | `js-lockfile`, then `mise`, then `path` |
| `bash` | `mise`, then `path` |

A check with no pack, which is every check in a repo without `targets`,
resolves through `js-lockfile` alone, so a repo that declares no targets runs
every tool through its package manager as it always has. The `repo` pack's
own chain applies once a repo declares targets.

## The repo pack without Node

The repo pack's slots check the repo as a whole, so a repo with no
`package.json` still needs them. Each slot that runs an npm tool by default has
a single-binary alternate, which `mise.toml` or `PATH` provides:

| Slot | npm default | Node-free alternate | Detected by |
| --- | --- | --- | --- |
| `struct` | `ast-grep`, from `@ast-grep/cli` | the `ast-grep` binary | `sgconfig.yml`, `sgconfig.yaml` |
| `docs` | `markdownlint-cli2` | `rumdl`, writing `docs.json` | `.rumdl.toml`, `rumdl.toml` |
| `spell` | `cspell` | `typos` | `_typos.toml`, `typos.toml`, `.typos.toml` |
| `prose` | `vale`, from `@vvago/vale` | the `vale` binary | `.vale.ini`, `_vale.ini` |

`ast-grep` and `vale` are one adapter each: the copy that runs is whichever the
chain reaches first, the `package.json` dependency, then a `mise.toml` pin,
then `PATH`. `rumdl` and `typos` are adapters of their own, after the npm
default in their slot, so where both configs sit the npm default wins
detection. rumdl runs `rumdl check --no-cache --output-format json .`, so it
writes no cache into the checkout, and `checkride fix` runs it with `--fix`.
typos runs `typos --format brief`, which exits 2 on a typo, and
`checkride fix` runs `typos --write-changes`.

## Pin sources

| Source | Declares a tool when | Runs it as | `tool_version` |
| --- | --- | --- | --- |
| `js-lockfile` | its package is a dependency in the nearest `package.json` from the check's directory up to the repo root | the project's package manager: `pnpm exec <tool>`, `npx --no-install <tool>`, `yarn <tool>` or `bunx --no-install <tool>` | the `version` in `node_modules/<package>/package.json` nearest the check's directory, for a tool whose package `TOOLS` names |
| `mise` | a `mise.toml` or `.mise.toml` from the check's directory up to the repo root has a `[tools]` key for it: one of the tool's `mise` ids in `TOOLS`, else its executable's name | `mise exec -- <tool>`, once `mise which <tool>` confirms the pinned copy is installed | none, since mise owns version resolution |
| `path` | nothing else declares it | `<tool>` from `PATH`, unpinned | none |

The summary's `pin_source` names five more sources, `override`,
`go-mod-tool`, `rust-toolchain`, `uv-lock` and `tf-version`. They arrive with
the packs and the `--pins` flag that use them, and no run writes them yet.
Every search stops at the repo root: a `mise.toml` or a `node_modules` above
the checkout isn't the repo's pin.

## How a tool resolves

1. Each source in the chain, in order, is asked whether it declares the tool.
2. The first source that declares it runs it, with no fall-through. When that
   source can't run the tool, the check fails with exit 1 and names the
   source: mise isn't on `PATH`, mise hasn't installed the version it pins, or
   an `npx` or `bunx` tool is missing from `node_modules/.bin`. checkride never
   reaches for another copy, because that copy's version depends on the
   machine.
3. When no source declares the tool and the chain names `path`, checkride
   runs the tool from `PATH` and records `pin_source: "path"`. With
   `requirePins: true` in `checkride.config.json`, the check fails instead,
   with `<tool> is not pinned; pin it with: mise use <id>@<version>`.
   `mise use --pin <id>@latest` writes the newest version as an exact pin. A
   tool `PATH` doesn't have fails, naming how to install it.
4. A chain without `path`, such as `ts`'s, lets its last source run a tool no
   earlier source declared, which keeps the package manager running every
   tool as before.

A custom check's own command, such as `node scripts/x.mjs`, spawns as written
through no pin source, and records `argv` but no `pin_source`. `checkride fix`
launches each fixer the way its check is launched, so a fixer runs the same
copy and is refused where the check would be.

**Why the `mise` source asks `mise which` first.** With auto-install off, mise
given a pinned version it hasn't installed prints a warning and runs whatever
copy of the tool `PATH` holds (checked against mise 2026.10.4). That's the
fall-through a pin chain exists to rule out, so the source runs
`mise which <tool>` from the check's directory before it spawns, and fails the
check when mise answers that the pinned copy isn't active. The question costs
one short spawn per check that mise launches, and it never asks for a
version.

## The bash pack

A bash target checks the shell scripts under its root. The pack has no root
marker, so a bash target is always one the config declares:

```json
{
  "targets": {
    "scripts": { "lang": "bash", "root": "scripts", "exclude": ["vendor"] }
  }
}
```

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `lint` | `shellcheck` | `shellcheck -f json1 {files}` | a `.shellcheckrc` at the target's root, or a pin | `lint.json` |
| `format` (opt-in) | `shfmt` | `shfmt -d {files}`, and `shfmt -w {files}` under `checkride fix` | a pin | `format.stdout.txt` |

Both tools resolve through `mise`, then `path`, and need no config file, so
detection asks for the repo's word that a tool should run: a config file, or a
pin. A `mise.toml` from the target's root up to the repo root that declares
the tool, by its own name or its `aqua:` id, is that pin, and the summary
records it as `detected_by`, such as `mise.toml: shellcheck`. A target with
neither leaves the slot empty. Naming the adapter in `packs.bash.checks` or
the target's own `checks` runs it either way, from `PATH` when nothing pins
it.

### File lists

`{files}` stands for the target's files, one argument each, relative to its
root, so every check of the target runs from its root over the same list:

1. The candidates are the files git lists under the root, tracked or
   untracked but not ignored. Outside a git repository, checkride walks the
   root instead, skipping `.git`, `node_modules`, `target` and `vendor`. A
   path that isn't a file on disk, such as a deleted file git still tracks,
   is left out.
2. The target's `include` globs keep a file. With no `include`, a target keeps
   every `.sh` and `.bash` file and each extensionless file whose first line
   is a `bash`, `sh`, `dash` or `ksh` shebang, directly or through `env`, as
   in `#!/bin/sh` or `#!/usr/bin/env bash`. An `include` replaces all of that.
3. The target's `exclude` globs drop a file, and a glob that matches a
   directory drops everything under it.

Globs are relative to the root and take `**` for any number of directories,
`*` and `?` within one, and `{a,b}` for alternatives. A target whose list
matches nothing records its checks as skipped with `no files matched`, rather
than failed. A list that would take a check's argv past 200,000 bytes stops
the run with exit 2 before anything runs; narrow `include`, or add `exclude`
globs.

## What `doctor` reports

`checkride doctor` names the mode first: `implicit`, where the repo is one ts
project at its root, or `multi-target`, followed by a table of the targets the
config declares. Each check gets a row, named `<target>:<slot>` in a target,
whose tool is looked for where that check runs from, and the row ends with the
pin source the tool resolves through (`js-lockfile`, `mise` or `path`), read
from files alone. A tool `mise.toml` pins reports missing when mise isn't on
`PATH`. Each tool nothing pins gets an **unpinned tools** row naming the checks
that run it and the `mise use` that would pin it: a warning, or with
`requirePins: true` a failure (exit 1) when a check that runs by default
uses it. Last, a **workspace** row lists the markers no target claims, the ones
the `unclaimed` check reports. A repo without `targets` gets a row only when it
holds another language's markers, such as a `go.mod`, which the one ts project
leaves unchecked, as a hint to declare targets. Neither row ever fails
`doctor`. `doctor --json` carries the same as `mode`, `targets`, `unclaimed`,
and each row's `target` and `pinSource`.

## The spawn environment

A pack's variables apply to every check of that pack that spawns, the
target's custom checks included, and override the user's own values for those
variables only. Today only the mise variables apply: checkride sets them on
every check whose tool resolves through `mise` or `path`, since a tool on
`PATH` may be one of mise's shims. The other rows apply once their pack
ships. No row touches `GOFLAGS`: Go 1.24 already refuses to rewrite `go.mod`
during a build, and an explicit `-mod=readonly` would make Go ignore
`vendor/`. An adapter marked `network: true` will get none of the variables
that block the network (`GOPROXY`, `CARGO_NET_OFFLINE`, `PIP_NO_INDEX` and
`UV_OFFLINE`), and keeps the ones that pin a toolchain or switch off an
install.

Each variable below was checked on 2026-10-16 against the version of its tool
that this repo's `mise.toml` pins, or against upstream source for a tool it
doesn't pin.

| Applies to | Variable | Value | Purpose | Verified against |
| --- | --- | --- | --- | --- |
| go | `GOTOOLCHAIN` | `local` | Fail rather than download the toolchain `go.mod` asks for. | Go 1.27.2: a module that requires `go 1.99` fails with `go.mod requires go >= 1.99 (running go 1.27.2; GOTOOLCHAIN=local)`. |
| go | `GOPROXY` | `off` | Fail rather than download modules; run `go mod download` first. | Go 1.27.2: with an empty module cache, `module lookup disabled by GOPROXY=off`. |
| rust | `CARGO_NET_OFFLINE` | `true` | Fail rather than fetch crates; run `cargo fetch` first. | cargo 1.99.0: an uncached dependency fails in offline mode instead of updating the crates.io index. cargo derives the name from its `net.offline` setting, so its message says `--offline`. |
| rust | `RUSTUP_AUTO_INSTALL` | `0` | Fail rather than install the toolchain `rust-toolchain.toml` names. | rustup 1.29.1: an uninstalled channel fails with `toolchain '<channel>' is not installed`. rustup reads the variable from 1.28.1 on. |
| rust | `CARGO_TERM_COLOR` | `never` | Keep captured text free of ANSI codes. | cargo 1.99.0: `always` colors an error, and `never` leaves it plain. |
| python | `PYTHONDONTWRITEBYTECODE` | `1` | No `__pycache__` writes in the checkout. | Python 3.14.8: `--help-env` lists it, and no `__pycache__` appears. |
| python | `PIP_NO_INDEX` | `1` | pip never reaches an index. | pip 26.2.1, bundled with Python 3.14.8: pip reads any `PIP_<OPTION>`, and with this one it searches no index. |
| python | `UV_OFFLINE` | `1` | uv never reaches an index. | uv 0.13.1: `--offline` reads `UV_OFFLINE`, and a resolve fails because the network is disabled. |
| terraform | `CHECKPOINT_DISABLE` | `1` | No version check call to HashiCorp. | OpenTofu 1.13.1 doesn't read it: OpenTofu removed the version check call, so the variable does nothing there. Terraform reads it, unverified here, since this repo pins OpenTofu. |
| terraform | `TF_IN_AUTOMATION` | `1` | Automation-friendly output. | OpenTofu 1.13.1: `plan` drops its note about `-out`. |
| terraform | `TF_INPUT` | `0` | Never prompt. | OpenTofu 1.13.1: a missing variable fails at once instead of prompting. |
| terraform | `TFENV_AUTO_INSTALL`, `TOFUENV_AUTO_INSTALL` | `false` | The version manager never downloads a CLI. | Neither manager is pinned. Upstream source: tfenv v3.2.2 (`lib/tfenv-exec.sh`) and tofuenv v1.0.7 (`lib/tofuenv-exec.sh`) install only while the variable is `true`, its default. |
| terraform | `TRIVY_SKIP_CHECK_UPDATE` | `true` | trivy never downloads its checks bundle. | trivy 0.76.0: maps `--skip-check-update` to the variable, and logs that it loads no downloadable checks. With an empty cache it falls back to its embedded checks, and with a cached bundle it uses that one. |
| any check launched through mise | `MISE_EXEC_AUTO_INSTALL`, `MISE_NOT_FOUND_AUTO_INSTALL` | `false` | mise never installs a missing tool. | mise 2026.10.4: `mise settings get` reads `false` for `exec_auto_install` and `not_found_auto_install`. A pinned version that isn't installed then runs a copy from `PATH`, which is why the `mise` source asks `mise which` first. |
