# Packs and pins

A pack is one language's adapters, together with where its tools are pinned
and the environment its checks run with. Five packs ship so far: `ts`, which
checks TypeScript code, `repo`, which checks the repo as a whole (`struct`,
`docs`, `links`, `spell` and `prose`), `bash`, which checks shell scripts,
`go`, which checks Go modules and workspaces, and `rust`, which checks Cargo
packages and workspaces. This page covers how a check's tool resolves to the
copy that runs, what the summary records about that copy, the bash pack and
the file lists its checks run over, the go and rust packs, and the spawn
environment each pack sets.
Packs for Python and Terraform arrive in later releases, and the rows below
that belong to them say so.

## Pin chains

Each pack names a pin chain: the pin sources its tools resolve through, in
order.

| Pack | Pin chain |
| --- | --- |
| `ts` | `js-lockfile` |
| `repo` | `js-lockfile`, then `mise`, then `path` |
| `bash` | `mise`, then `path` |
| `go` | `go-mod-tool`, then `mise`, then `path` |
| `rust` | `rust-toolchain`, then `mise`, then `path` |

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
| `go-mod-tool` | the `go.mod` nearest the check's directory, up to the repo root, names the tool's package in a `tool` directive, one-line or block | `go tool <tool>`, through the `go` a `mise.toml` pins, else the one on `PATH` | the version that `go.mod` requires for the module providing the tool |
| `rust-toolchain` | a `rust-toolchain.toml` or `rust-toolchain` from the check's directory up to the repo root pins the toolchain, for a rustup component: `cargo` itself, rustfmt and clippy | `cargo`, `cargo fmt` or `cargo clippy` through rustup's `cargo` on `PATH`, which reads the file | the file's channel, when it names an exact release such as `1.85.0` |
| `mise` | a `mise.toml` or `.mise.toml` from the check's directory up to the repo root has a `[tools]` key for it: one of the tool's `mise` ids in `TOOLS`, else its executable's name | `mise exec -- <tool>`, once `mise which <tool>` confirms the pinned copy is installed | none, since mise owns version resolution |
| `path` | nothing else declares it | `<tool>` from `PATH`, unpinned | none |

The summary's `pin_source` names three more sources, `override`, `uv-lock`
and `tf-version`. They arrive with the packs and the `--pins` flag that use
them, and no run writes them yet. `rust-toolchain` declares only a tool that
`TOOLS` names as a rustup component: `cargo` itself, rustfmt and clippy. Only
rustup reads a toolchain file, so a component the file pins fails its check
when `rustup` isn't on `PATH`, rather than run a `cargo` that ignores the
pin. `go-mod-tool`
declares a tool only when `TOOLS` gives its Go package, which it does for
staticcheck, deadcode and govulncheck. golangci-lint is pinned as a binary,
never as a `go tool`.

A toolchain resolves its own executables, `go` and `gofmt` for Go and `cargo`
for Rust, through its pack's chain, in a pack whose chain reads `mise`: a
toolchain file pins `cargo`, recorded as `rust-toolchain`; `mise exec -- go`
runs when a `mise.toml` up to the repo root pins `go`, recorded as
`pin_source: "mise"`; and the `go` on `PATH` runs otherwise, recorded as
`path`. A tool `go-mod-tool` declares runs through the
same `go`, and records `go-mod-tool`. A pinned `go` that mise can't run fails
the check, as any mise pin does, and a `go` from `PATH` runs even under
`requirePins`, since `go.mod`'s `go` line sets the oldest version it accepts
and `GOTOOLCHAIN=local` stops Go fetching a newer one. In a repo without
targets, a custom check's `go` spawns as written, as it always has.
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

## The go pack

A go target checks a Go module, or a workspace, from the directory that holds
its `go.mod` or `go.work`:

```json
{
  "targets": {
    "api": { "lang": "go", "root": "services/api" }
  }
}
```

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `types` | `go-build` | `go build -o /dev/null -json {go-packages}` | `go.mod`, `go.work` | `types.jsonl` |
| `format` (opt-in) | `gofmt` | `gofmt -l .`, which fails on any file it lists, and `gofmt -w .` under `checkride fix` | `go.mod`, `go.work` | `format.stdout.txt` |
| `lint` | `golangci-lint` | `golangci-lint run --output.json.path=stdout --show-stats=false --allow-serial-runners {go-packages}`, and `run --fix` under `checkride fix` | `.golangci.yml`, `.golangci.yaml`, `.golangci.toml`, `.golangci.json` | `lint.json` |
| `lint` | `staticcheck` | `staticcheck -f json {go-packages}` | a pin | `lint.jsonl` |
| `dead` | `deadcode` | `deadcode -test {go-packages}`, which fails on any function it lists | a pin | `dead.stdout.txt` |
| `test` | `go-test` | `go test -json {go-packages}` | `go.mod`, `go.work` | `test.jsonl` |
| `security` (opt-in) | `govulncheck` | `govulncheck {go-packages}`, with the network | a pin | `security.stdout.txt` |

`{go-packages}` stands for `./...` at a module root, and for `./<dir>/...` for
each `use` directive at a `go.work` root, in `go.work`'s order, since a
workspace root's own `./...` matches none of its modules. golangci-lint takes
the same patterns, because it misses a workspace's modules without them.

Under `--changed`, `go build` and `go test` at a workspace root narrow to the
modules a change touched, each changed path counting toward the deepest `use`
directory it lies under, plus every module that depends on one of them,
transitively. A module depends on another when its `go.mod` requires the
other's module path or replaces a module with the other's directory, or when
it requires a module the `go.work` replaces that way; edges to modules outside
the workspace don't count, and nothing is fetched to read them. The summary
records `narrowed: { units, total }`. A change to `go.work`, `go.work.sum` or
any `go.mod`, or a workspace file checkride can't read, runs every module, and
a change under none of the modules skips the two checks with
`no Go module changed under <root>`. golangci-lint, staticcheck, deadcode and
govulncheck always run every module, and a single module has nothing to
narrow. `go test` caches results per package, so a sandbox that keeps
`GOCACHE` between runs recovers much of what narrowing saves.

A pin is the repo's word that a Go tool should run: a `tool` directive in the
target's `go.mod`, such as one `go get -tool honnef.co/go/tools/cmd/staticcheck`
writes, or a `mise.toml` key. The summary records it as `detected_by`, such as
`api/go.mod: honnef.co/go/tools/cmd/staticcheck`, and a `tool` directive's tool
records the version `go.mod` requires as `tool_version`. Where golangci-lint's
config and a staticcheck pin both sit, golangci-lint fills `lint`. Two
golangci-lint runs never overlap, in one target or across several, and the one
that waits isn't started, so its timeout doesn't count the wait.

Each row was checked against Go 1.27.2 and golangci-lint 2.14.0, the versions
this repo's `mise.toml` pins, and against staticcheck 0.8.2, deadcode from
x/tools 0.52.0 and govulncheck 1.9.0. A few flags differ from what a reader
might expect:

- `go build -o /dev/null` discards the binary a module with one main package
  would otherwise write into the checkout.
- `--show-stats=false` keeps golangci-lint's per-linter tally off stdout,
  where it would follow the JSON and leave `lint.json` unwritten.
- `gofmt -l` and `deadcode` list what they find and exit 0, so each fails its
  check on any output, with `exit_code: 0` and a `reason`.
- `govulncheck` prints text, because with `-format json` it exits 0 even when
  the code calls a vulnerable function. Text exits 3. Its JSON is a stream of
  objects, not one value or JSON lines, so it would land in
  `security.stdout.txt` either way.
- deadcode reads reachability from `main` packages and tests, so a library
  with neither fails with `deadcode: no main packages`.

## The rust pack

A rust target checks a Cargo package, or a workspace, from the directory that
holds its `Cargo.toml`:

```json
{
  "targets": {
    "core": { "lang": "rust", "root": "crates" }
  }
}
```

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `types` | `cargo-check` | `cargo check --workspace --all-targets --message-format=json` | `Cargo.toml` | `types.jsonl` |
| `format` (opt-in) | `rustfmt` | `cargo fmt --all --check`, and `cargo fmt --all` under `checkride fix` | `Cargo.toml` | `format.stdout.txt` |
| `lint` | `clippy` | `cargo clippy --workspace --all-targets --message-format=json -- -D warnings`, and `--fix` under `checkride fix` | `Cargo.toml` | `lint.jsonl` |
| `dead` | `cargo-machete` | `cargo machete` | a pin | `dead.stdout.txt` |
| `test` | `nextest` | `cargo nextest run --workspace --no-fail-fast` | `.config/nextest.toml` | `test.stderr.txt` |
| `test` | `cargo-test` | `cargo test --workspace --no-fail-fast` | `Cargo.toml` | `test.stdout.txt` |
| `snippets` (opt-in) | `cargo-doctest` | `cargo test --doc --workspace` | `Cargo.toml` | `snippets.stdout.txt` |
| `security` (opt-in) | `cargo-deny` | `cargo deny --format json check`, with the network | `deny.toml` | `security.stderr.txt` |
| `mutation` (opt-in) | `cargo-mutants` | `cargo mutants --output {out}` | a pin | `mutants.out/` in the check's directory |

`cargo` itself resolves as a toolchain, through a `mise.toml` pin of `rust`,
else `PATH`. rustfmt and clippy resolve through the toolchain file first, as
rustup components, and cargo-machete, cargo-nextest, cargo-deny and
cargo-mutants are cargo plugins, each its own binary that a `mise.toml` pins,
such as `"ubi:bnjbvr/cargo-machete" = "0.9.2"`, or that `PATH` holds. Clippy's
`-D warnings` fails the check on a warning, rustc's `dead_code` lint among
them, which is why `dead` looks for unused dependencies instead. nextest
doesn't run doctests, so a Rust repo names `snippets` to opt the doctests in.

Every row takes the lock `cargo:{root}`, so one target's cargo runs never
overlap and the one that waits isn't started, while another target's run
beside them. Targets that share one build directory through
`CARGO_TARGET_DIR` still serialize, on cargo's own lock on that directory,
and that wait does count against their timeouts.

Each row was checked against Rust 1.99.0, cargo-machete 0.9.2,
cargo-nextest 0.9.148, cargo-deny 0.20.2 and cargo-mutants 27.1.0. cargo-deny
prints its JSON lines on stderr, so they land in `security.stderr.txt`, and
nextest reports on stderr too. cargo-mutants writes its `mutants.out/` into
the check's artifact directory through `--output`, rather than the source
tree.

## The entry command

The entry command is how the stop-hook gate, the AGENTS.md stanza and the
plugin skills run checkride in a repo, chosen from the repo root:

1. A root `package.json`: its `check` script, `<pm> run check`, as every
   release has run it. `init` writes that script.
2. No `package.json`, and a root `mise.toml` or `.mise.toml` whose `[tools]`
   declares `npm:checkride` or `github:robmclarty/checkride`:
   `mise exec -- checkride`.
3. Neither: the `checkride` on `PATH`, which nothing pins, so `doctor`
   reports the harness unpinned.

The gate runs the entry command with `--strict --digest` and the gate
profile's flags. The hook script tests whether that copy is there to run
(`node_modules/.bin`, `mise which checkride`, or `command -v checkride`)
before it blocks on a gate that didn't answer.

## What `doctor` reports

`checkride doctor` names the mode first: `implicit`, where the repo is one
project at its root, naming the pack its root marks (`ts`, `go` or `rust`, as
[Targets](./targets.md#a-repo-without-targets) explains), or `multi-target`,
followed by a table of the targets the config declares. Each check gets a row, named `<target>:<slot>` in a target,
whose tool is looked for where that check runs from, and the row ends with the
pin source the tool resolves through (`js-lockfile`, `mise` or `path`), read
from files alone. A tool `mise.toml` pins reports missing when mise isn't on
`PATH`. Each tool nothing pins gets an **unpinned tools** row naming the checks
that run it and the `mise use` that would pin it: a warning, or with
`requirePins: true` a failure (exit 1) when a check that runs by default
uses it. Last, a **workspace** row lists the markers no target claims, the ones
the `unclaimed` check reports. A repo without `targets` gets a row only when it
holds another language's markers, such as a `go.mod` below a ts root, which
the one implicit project leaves unchecked, as a hint to declare targets.
Neither row ever fails `doctor`. `doctor --json` carries the same as `mode`,
`pack` (implicit mode only), `targets`, `unclaimed`, and each row's `target`
and `pinSource`.

## The spawn environment

A pack's variables apply to every check of that pack that spawns, the
target's custom checks included, and override the user's own values for those
variables only. The go and rust rows apply today, and so do the mise
variables, which checkride sets on every check whose tool resolves through
`mise` or `path`,
since a tool on `PATH` may be one of mise's shims. The other rows apply once
their pack ships. No row touches `GOFLAGS`: Go 1.24 already refuses to rewrite
`go.mod` during a build, and an explicit `-mod=readonly` would make Go ignore
`vendor/`, so a vendored module builds with an empty module cache. An adapter
marked `network: true` gets none of the variables that block the network
(`GOPROXY`, `CARGO_NET_OFFLINE`, `PIP_NO_INDEX` and `UV_OFFLINE`), and keeps
the ones that pin a toolchain or switch off an install.

A tool stopped by one of these variables names the variable, not the way out,
so a red check's status line is followed by the command to run first: `go mod
download` for Go's `module lookup disabled by GOPROXY=off`, `cargo fetch` for
an offline cargo's missing crate, and `rustup toolchain install <toolchain>`
for rustup's `toolchain '<toolchain>' is not installed`. The raw output keeps
the tool's own words.

Where a `rust-toolchain.toml` or `rust-toolchain` pins the toolchain, every
spawn of a rust check also clears `RUSTUP_TOOLCHAIN`, which rustup 1.29.1 reads
as unset when it's empty. mise exports that variable for its own Rust, and it
would otherwise override the toolchain the repo's file names, so the verdict
would depend on the shell that ran it.

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
