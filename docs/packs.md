# Packs and pins

A pack is one language's adapters, together with where its tools are pinned
and the environment its checks run with. Seven packs ship: `ts`, which
checks TypeScript code, `repo`, which checks the repo as a whole (`struct`,
`docs`, `links`, `spell`, `prose` and, with targets, `unclaimed`), `bash`,
which checks shell scripts, `go`, which checks Go modules and workspaces,
`rust`, which checks Cargo packages and workspaces, `python`, which checks
Python projects, and `terraform`, which checks Terraform and OpenTofu
modules. This page covers how a check's
tool resolves to the copy that runs, what the summary records about that copy,
each pack's slots and the adapters that fill them, the file lists a bash
target's checks run over, and the spawn environment each pack sets.

Each pack's table lists its adapters in the pack's order, and the first
adapter for a slot is its blessed default: it wins detection where several
tools' configs sit, and it's the one `init` and `target add --add` scaffold
config for. A slot marked opt-in stays out of the default run until a config
entry names it or `--include` does.

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
| `python` | `uv-lock`, then `mise`, then `path` |
| `terraform` | `tf-version`, then `mise`, then `path` |

In a repo without `targets`, a root that marks a pack other than ts (a
`go.mod`, a `Cargo.toml`, a `pyproject.toml`, a Terraform root) is checked as
one target of that pack, so its checks resolve through that pack's chain and
its repo-scope checks through the `repo` pack's. Every other repo without
`targets`, one whose root holds a `package.json` or `tsconfig.json` or no
marker at all, is checked as ts, with no pack: each check resolves through
`js-lockfile` alone, as it always has. Detection there never picks a tool
that chain can't provide, so `rumdl` and `typos` never fill a slot, and
neither can a `--defaults` file. The `repo` pack's own chain applies once a
repo declares targets. A run given `--pins` puts the `override` source at the
head of every chain, that one included.

## Pin sources

| Source | Declares a tool when | Runs it as | `tool_version` |
| --- | --- | --- | --- |
| `override` | the run's `--pins` file has a `[tools]` key for it, one of the tool's `mise` ids in `TOOLS`, else its executable's name, with a version | `mise exec <id>@<version> -- <tool>`, offline, with installs off and every config file inside the repo ignored, once `mise where <id>@<version>` confirms that version is installed | the release `mise where` resolved the file's version to, such as `2.14.0` for a `2.14` |
| `js-lockfile` | its package is a dependency in the nearest `package.json` from the check's directory up to the repo root | the project's package manager: `pnpm exec <tool>`, `npx --no-install <tool>`, `yarn <tool>` or `bunx --no-install <tool>` | the `version` in `node_modules/<package>/package.json` nearest the check's directory, for a tool whose package `TOOLS` names |
| `go-mod-tool` | the `go.mod` nearest the check's directory, up to the repo root, names the tool's package in a `tool` directive, one-line or block | `go tool <tool>`, through the `go` a `mise.toml` pins, else the one on `PATH` | the version that `go.mod` requires for the module providing the tool |
| `rust-toolchain` | a `rust-toolchain.toml` or `rust-toolchain` from the check's directory up to the repo root pins the toolchain, for a rustup component: `cargo` itself, rustfmt and clippy | `cargo`, `cargo fmt` or `cargo clippy` through rustup's `cargo` on `PATH`, which reads the file, or, without rustup, through a Nix dev shell's toolchain at the exact release the file names | the file's channel, when it names an exact release such as `1.85.0` |
| `uv-lock` | the `uv.lock` nearest the check's directory, up to the repo root, lists the tool's PyPI package, its name compared as PyPI compares names | the tool's executable in the project's environment: `.venv/bin/<tool>` beside the lock, which a workspace's members share, or `bin/<tool>` under the environment `UV_PROJECT_ENVIRONMENT` names, a relative one from the lock's directory; never through `uv` itself | the `version` of the lock's `[[package]]` entry for it, when the lock pins one version; a forked resolution that locks several records none |
| `tf-version` | a `.terraform-version` or `.opentofu-version` from the check's directory up to the repo root, the nearest one, `.opentofu-version` first in one directory, for the CLI it names: `terraform` or `tofu` | that CLI from `PATH`, once `<cli> version -json` reports the release the file names, when it names one exactly | the file's release, when it names one exactly, such as `1.5.7` |
| `mise` | a `mise.toml` or `.mise.toml` from the check's directory up to the repo root has a `[tools]` key for it: one of the tool's `mise` ids in `TOOLS`, else its executable's name | `mise exec -- <tool>`, once `mise which --version <tool>` confirms the pinned copy is installed | the version mise resolved the pin to, which that answer prints, such as `0.11.0` for `shellcheck = "0.11"`; none for a pin that resolves to no release, such as `system` |
| `nix` | nothing else declares it, and the copy on `PATH` is a Nix dev shell's the repo declares (see below) | `<tool>` from `PATH`, pinned by the repo's Nix files | the version its store path names, such as `2.11.4` for `golangci-lint-2.11.4` |
| `path` | nothing else declares it | `<tool>` from `PATH`, unpinned | none |

No chain names `nix`: it's what the `path` step records when the copy it
finds came from a Nix dev shell. The repo declares one with a `flake.nix`,
`flake.lock`, `shell.nix`, `default.nix`, `devenv.nix`, `devbox.json` or
`.flox` between the check's directory and the repo root. The copy counts
when the `PATH` entry it came from lies inside the Nix store, as `nix
develop`, `nix-shell`, nix-direnv and devenv put it there, or inside the repo,
as devbox's profile does, and the copy resolves into the store. A user's
profile, such as `~/.nix-profile/bin`, links into the store too, but it's the
machine's, so its copy stays `path`. A tool its runner picks, as `cargo deny`
picks `cargo-deny`, stays `path` as well, since the runner may run another
copy. A `nix` copy passes `requirePins`, which a Nix repo can turn on to fail
any tool the shell doesn't provide. An ad hoc `nix shell nixpkgs#<tool>` in a
repo with Nix files counts too: the recorded version still says which copy
ran.

A dev shell decides which copy a check runs, never whether it runs.
Detection reads only the repo's files, so a tool only the shell provides,
such as a shellcheck with no `.shellcheckrc` and no pin, turns no slot on,
and `doctor` says so when the slot sits empty with that copy on `PATH`. Name
the adapter in `checkride.config.json` and it runs the shell's copy, as
[the bash pack](#the-bash-pack) shows. checkride doesn't read the flake to
find the tool: `with pkgs; [ … ]`, imports, overlays and devenv modules can't
be read reliably, a false match would turn a check on, and a miss would be
silent. Reading the shell instead would make the checks a run picks depend on
being inside it: a baseline captured in the shell would name checks a run
outside it never runs.

`uv-lock` declares only a tool that `TOOLS` gives a PyPI package: ruff, mypy,
basedpyright and pytest.
Its argv names the environment's executable from the check's directory, such
as `.venv/bin/ruff`, and absolutely when the environment lies outside the
repo.
`override` is the consumer's, not the repo's: a review agent's own
`mise.toml`, named with `--pins` or `CHECKRIDE_PINS`, runs its toolbelt over a
checkout it can't write to. mise reads none of the repo's own config files for
it, so a `mise.toml` mise hasn't trusted neither refuses the tool nor gets
trusted, and the repo's `[env]` never reaches it. Each entry is a version
string or an inline table's `version`; anything else exits 2, and so does a
file that pins no tool, a `[tool]` typo among them. It changes which copy of a tool
runs, never which checks run, since detection reads only the repo. A toolchain
it names, such as `go`, runs that copy in any pack, a `go tool` included.
`rust-toolchain` declares only a rustup component: `cargo` itself, which
`TOOLCHAINS` describes, and rustfmt and clippy, which `TOOLS` does. rustup
reads a toolchain file through the `cargo` proxy it installs beside itself,
so a component the file pins fails its check when the `rustup` on `PATH` has
no `cargo` beside it, rather than run a `cargo` that ignores the pin.
Without `rustup`, a Nix dev shell built from the file, as rust-overlay's
`fromRustupToolchainFile` and fenix's `fromToolchainFile` build one, stands
in for it when the file names an exact release, such as `1.85.0`. Each
executable the check's cargo subcommand runs from `PATH` must be the shell's
copy of that release, by the version its store path names, as
`rust-default-1.85.0` and `rustfmt-preview-1.85.0-aarch64-unknown-linux-gnu`
name it, and a pre-release such as `1.85.0-beta.7` isn't it. Every check
runs `cargo` and `rustc`; `clippy` runs `cargo-clippy` too, `fmt` runs
`cargo-fmt` and `rustfmt`, and `test` and `doc` run `rustdoc`. The
subcommand is the first argument after `cargo` that isn't an option, so a
custom check's `cargo fmt --check` counts the same copies the rustfmt
adapter does. The check records `rust-toolchain` and the release, as a run
through rustup does, so a baseline captured under one sees the same copy
under the other. A channel only rustup resolves to a release, such as
`stable` or `1.85`, fails the check, and so does a shell at another release
or without one of those executables, naming each. Where the `cargo` on
`PATH` isn't a Nix shell's, the check fails for want of `rustup`. A cargo
plugin such as nextest builds through `cargo` too, so under a toolchain file
it fails the same way, with its own message, unless the `cargo` and `rustc`
it builds through are a Nix shell's copies of the file's release. Which copy
of the plugin runs is still its own pin's to say. Neither route reads the
variables that send cargo elsewhere: a `RUSTC`, `RUSTDOC` or `RUSTFMT` the
shell exports picks the copy that runs, through rustup or not. `go-mod-tool`
declares a tool only when `TOOLS` gives its Go package, which it does for
staticcheck, deadcode and govulncheck. golangci-lint is pinned as a binary,
never as a `go tool`.

A toolchain resolves its own executables, `go` and `gofmt` for Go and `cargo`
for Rust, through its pack's chain, in a pack whose chain reads `mise`: a
toolchain file pins `cargo`, recorded as `rust-toolchain`; `mise exec -- go`
runs when a `mise.toml` up to the repo root pins `go`, recorded as
`pin_source: "mise"` with the version mise resolved; and the `go` on `PATH`
runs otherwise, recorded as
`path`, or as `nix` with its version where a Nix dev shell the repo declares
put it there. A tool `go-mod-tool` declares runs through the
same `go`, and records `go-mod-tool`. A pinned `go` that mise can't run fails
the check, as any mise pin does, and a `go` from `PATH` runs even under
`requirePins`, since `go.mod`'s `go` line sets the oldest version it accepts
and `GOTOOLCHAIN=local` stops Go fetching a newer one. A repo checked as ts
without targets resolves through `js-lockfile` alone, which reads no
`mise.toml`, so a custom check's `go` there spawns as written, as it always
has.
Every search stops at the repo root: a `mise.toml` or a `node_modules` above
the checkout isn't the repo's pin.

## How a tool resolves

1. Each source in the chain, in order, is asked whether it declares the tool.
2. The first source that declares it runs it, with no fall-through. When that
   source can't run the tool, the check fails with exit 1 and names the
   source: mise isn't on `PATH`, mise hasn't installed the version it pins,
   an `npx` or `bunx` tool is missing from `node_modules/.bin`, or the project
   environment a `uv.lock` runs from doesn't exist or lacks the tool, which
   names the `uv sync` to run. checkride never
   reaches for another copy, because that copy's version depends on the
   machine.
3. When no source declares the tool and the chain names `path`, checkride
   runs the tool from `PATH` and records `pin_source: "path"`, or `"nix"`
   with the version its store path names for a Nix dev shell's copy. With
   `requirePins: true` in `checkride.config.json`, a `path` copy fails the
   check instead, with
   `<tool> is not pinned; pin it with: mise use <id>@<version>`.
   `mise use --pin <id>@latest` writes the newest version as an exact pin. A
   tool `PATH` doesn't have fails, naming how to install it.
4. A chain without `path`, such as `ts`'s, lets its last source run a tool no
   earlier source declared, which keeps the package manager running every
   tool as before.

A custom check resolves the way a catalogue check does. A `pnpm exec <tool>`
command resolves the tool through its pack's chain, any other `pnpm`
subcommand, such as `pnpm run lint:ci`, runs under the project's package
manager as `js-lockfile`, and a toolchain such as `go`, `cargo` or
`terraform` resolves through the chain when it reads `mise`, each recording
its `pin_source`. Any other command, such as `node scripts/x.mjs`, spawns as
written through no pin source, and records `argv` but no `pin_source`. `checkride fix`
launches each fixer the way its check is launched, so a fixer runs the same
copy and is refused where the check would be.

**Why the `override` source asks `mise where` first.** For the same reason:
`mise exec <id>@<version>` falls back to `PATH` for a version mise lacks.
`mise where` exits 1 for one, downloads nothing, and runs offline
(`MISE_OFFLINE=1`), so a prefix such as `1.24` resolves against the installed
copies rather than a remote list. A version it doesn't find fails the check,
naming the tool and the `mise install <id>@<version>` that would fix it.

**Why the `mise` source asks `mise which` first.** With auto-install off, mise
given a pinned version it hasn't installed prints a warning and runs whatever
copy of the tool `PATH` holds (checked against mise 2026.10.4). That's the
fall-through a pin chain exists to rule out, so the source runs
`mise which --version <tool>` from the check's directory before it spawns, and
fails the check when mise answers that the pinned copy isn't active. The
question costs one short spawn per check that mise launches. Its answer is the
version mise resolved the pin to, which the check records as `tool_version`:
checkride never reads the version a `mise.toml` names, since a value such as
`"2"` or `"latest"` stays the same across a `mise upgrade`, and it never runs
the tool to ask. A `mise.toml` mise hasn't trusted fails the check too,
quoting mise's own line and naming `mise trust` rather than `mise install`,
which would trust the file as a side effect.

## The ts pack

A ts target checks a TypeScript or JavaScript project from the directory that
holds its `package.json` or `tsconfig.json`, and a repo without targets whose
root holds either is one ts project at its root. Every tool runs through the
project's package manager, the one nearest the check's directory: the first
lockfile or `packageManager` field from there up to the repo root, else pnpm.
So the Runs column reads as `pnpm exec <tool>` under pnpm,
`npx --no-install <tool>` under npm, and so on
([Tools § Package managers](./tools.md#package-managers)).

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `types` | `tsc` | `tsc --build` | `tsconfig.json` | `types.stdout.txt` |
| `format` (opt-in) | `prettier` | `prettier --check .`, and `prettier --write .` under `checkride fix` | a `.prettierrc` in any of its forms, a `prettier.config.*`, or the `prettier` dependency | `format.stderr.txt`, with a summary in `format.stdout.txt` |
| `format` (opt-in) | `biome-format` | `biome format .`, and `biome format --write .` under `checkride fix` | `biome.json`, `biome.jsonc` | `format.stderr.txt`, with a summary in `format.stdout.txt` |
| `lint` | `oxlint` | `oxlint --type-aware --format=json`, and `--fix` under `checkride fix`, with `--type-aware` only where `oxlint-tsgolint` is a dependency | `.oxlintrc.json` or the `oxlint` dependency | `lint.json` |
| `lint` | `biome` | `biome check --reporter=json`, and `biome check --write` under `checkride fix` | `biome.json`, `biome.jsonc` | `lint.json` |
| `lint` | `eslint` | `eslint . --format json`, and `eslint . --fix` under `checkride fix` | an `eslint.config.*`, `.eslintrc.json`, `.eslintrc.cjs` or `.eslintrc.js` | `lint.json` |
| `dead` | `fallow` | `fallow dead-code --format json --quiet`, and `fallow fix` under `checkride fix` | `fallow.toml` | `dead.json` |
| `dead` | `knip` | `knip --reporter json`, and `knip --fix` under `checkride fix` | a `knip.json`, `knip.jsonc`, `.knip.json` or `knip.config.*`, or the `knip` dependency | `dead.json` |
| `dupes` (opt-in) | `fallow` | `fallow dupes --format json --quiet` | `fallow.toml` | `dupes.json` |
| `health` (opt-in) | `fallow` | `fallow health --format json --quiet` | `fallow.toml` | `health.json` |
| `test` | `vitest` | `vitest run --coverage --reporter=default --reporter=json --outputFile={out}/test.json`, with `--changed {base}` under `--changed` | a `vitest.config.*` or the `vitest` dependency | `test.json`, through vitest's own `--outputFile` |
| `test` | `jest` | `jest --ci --json --outputFile={out}/test.json`, with `--changedSince {base}` under `--changed` | a `jest.config.*` | `test.json`, through jest's own `--outputFile` |
| `mutation` (opt-in) | `stryker` | `stryker run`, with no timeout | a `stryker.config.*` or `stryker.conf.*` | `mutation.stdout.txt` |
| `security` (opt-in) | `pnpm-audit` | built-in: `pnpm audit --audit-level=high --json --fetch-retries=1 --fetch-timeout=15000`, with the network; the fetch flags reach pnpm as `npm_config_*` and `pnpm_config_*` variables, since most pnpm releases refuse them on `audit` | pnpm as the package manager | `security.json` |
| `build` (opt-in) | `build` | `<pm> run build` | `scripts.build` in `package.json` | `build.stdout.txt` |
| `publint` (opt-in) | `publint` | `publint` | the `publint` dependency | `publint.stdout.txt` |
| `attw` (opt-in) | `attw` | `attw --pack . --format json` | the `@arethetypeswrong/cli` dependency | `attw.json` |
| `pack` (opt-in) | `pack` | built-in: `<pm> pack --dry-run --json` | pnpm or npm as the package manager | `pack.json` |
| `smoke` (opt-in) | `smoke` | built-in: imports the built package's exports | always | `smoke.json` |
| `snippets` (opt-in) | `snippets` | built-in: type-checks the tagged doc fences against the source | always | `snippets.json` |
| `snippets` (opt-in) | `snippets-dist` | built-in: type-checks them against the built `.d.ts`, after `build` | always | `snippets.json` |

[Tools](./tools.md#slot-tools) covers each tool, what to install for it, and
the built-ins' own rules.

### Type-aware linting

oxlint's `--type-aware` runs tsgolint, which comes from the `oxlint-tsgolint`
package, and without it oxlint fails on every run. So the `lint` check passes
`--type-aware`, in a run and under `checkride fix`, only where a
`package.json` from the check's directory up to the repo root declares
`oxlint-tsgolint`. Elsewhere it runs plain oxlint, which a `--static-only` run
keeps once oxlint is installed. A new ts project from `init` declares both
packages.

A repo that provides tsgolint some other way, such as `OXLINT_TSGOLINT_PATH`,
names the arguments itself, and so does a repo that wants plain oxlint with
the package installed:

```jsonc
{
  "checks": {
    "lint": {
      "use": "oxlint",
      "args": ["exec", "oxlint", "--type-aware", "--format=json"],
      "fixArgs": ["exec", "oxlint", "--type-aware", "--fix"]
    }
  }
}
```

In a repo with targets, the entry goes under `packs.ts.checks.lint`, or in one
target's `checks`: once targets are declared, a top-level `checks.lint` may
only set `optIn`, `timeout`, `order` and `note`. A `.oxlintrc.json` that turns
the rules on with `options.typeAware` needs tsgolint whatever the argv says.
When oxlint can't find tsgolint, the red check's status line is followed by
what to do about it.

## The repo pack

The repo pack fills the repo-scope slots, which check the repo as a whole, so
each runs once, from the repo root, however many targets the config declares.
It has no root marker.

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `struct` | `ast-grep` | `ast-grep scan --json=compact` | `sgconfig.yml`, `sgconfig.yaml` | `struct.json` |
| `docs` | `markdownlint-cli2` | `markdownlint-cli2`, and `--fix` under `checkride fix` | a `.markdownlint-cli2.*` | `docs.stderr.txt`, with a summary in `docs.stdout.txt` |
| `docs` | `rumdl` | `rumdl check --no-cache --output-format json .`, and `--fix` under `checkride fix` | `.rumdl.toml`, `rumdl.toml` | `docs.json` |
| `links` | `links` | built-in: relative markdown links resolve on disk | always | `links.json` |
| `spell` | `cspell` | `cspell --no-progress --no-summary --reporter=default` | a `cspell.json`, `.cspell.json` or `cspell.config.*`, or the `cspell` dependency | `spell.stdout.txt` |
| `spell` | `typos` | `typos --format brief`, and `typos --write-changes` under `checkride fix` | `_typos.toml`, `typos.toml`, `.typos.toml` | `spell.stdout.txt` |
| `prose` (opt-in) | `vale` | `vale --no-global --output=JSON .` | `.vale.ini`, `_vale.ini` | `prose.json` |
| `unclaimed` | `unclaimed` | built-in: every toolchain marker sits in a target of its pack | `targets` in the config | `unclaimed.json` |

`unclaimed` is inactive in a repo without targets, and
[Targets](./targets.md#code-no-target-checks) covers what it reports.

### Without Node

A repo with no `package.json` still needs the repo pack's slots. Each slot that
runs an npm tool by default has a single-binary alternate, which `mise.toml` or
`PATH` provides:

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
detection. rumdl runs with `--no-cache`, so it writes no cache into the
checkout. typos exits 2 on a typo.

The alternates need a chain that reaches past the package manager: a repo
that declares `targets`, or one whose root marks a pack other than ts. A
repo without `targets` whose root holds a `package.json` or `tsconfig.json`,
or no marker at all, is checked as ts through its package manager alone,
which can't install `rumdl` or `typos`. Detection never picks either there,
whatever config sits beside them, and an entry that names one is refused
when it runs. Declare `targets` to run them.

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

**Nix dev shells.** A shell that provides shellcheck doesn't turn `lint` on
by itself, since detection reads only the repo
([Pin sources](#pin-sources) says why), and `doctor` names the copy it found
on `PATH` when the slot sits empty. One entry turns the slot on for every
bash target, and each then runs the shell's copy, recorded as
`pin_source: "nix"` with its version:

```json
{ "packs": { "bash": { "checks": { "lint": "shellcheck" } } } }
```

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
| `lint` | `golangci-lint` | `golangci-lint run --output.json.path=stdout --show-stats=false --max-issues-per-linter=0 --max-same-issues=0 --uniq-by-line=false --allow-serial-runners {go-packages}`, and `run --fix` under `checkride fix` | `.golangci.yml`, `.golangci.yaml`, `.golangci.toml`, `.golangci.json` | `lint.json` |
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
other's module path or replaces a module with the other's directory, when it
requires a module the `go.work` replaces that way, or when any of its `.go`
files, tests included, imports one of the other's packages. A workspace
resolves that last kind with no `require` at all, so `examples/go-workspace`'s
`api` depends on `greet` through its import alone. An import belongs to the
module whose path is its longest prefix, a module's files stop at a directory
holding another `go.mod`, and a `.go` file checkride can't read makes its
module depend on every other. Edges to modules outside the workspace don't
count, and nothing is fetched to read them. The summary
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

Every go check also records the Go release it ran on, as
`toolchain_version`, since a tool's findings can move with Go's while its own
version stands still: golangci-lint compiles its type checker and gofmt in and
type-checks through the `go` it finds, so a Nix bump that rebuilds it on a
newer Go keeps its name, and a new Go minor deprecates stdlib API that
staticcheck's `SA1019` reports. It's read without running `go`: the version
the pin source named for `go` and `gofmt` themselves, the `go` a `go.mod` tool
runs through where mise or `--pins` resolved it, `mise which --version go`
for a tool mise runs, and otherwise the `VERSION` file at the GOROOT of the
`go` the check's `PATH` finds. A baseline captured on one Go minor holds the
check back from the ratchet on another; a patch release doesn't.
`checkride baseline --versions` records the new release only where the repo
pins Go, in its `mise.toml` or its Nix shell: a `go` from a machine's own
`PATH` or mise config may be another release on CI. `go.mod`'s
`go` and `toolchain` lines can't stand in for it: the first is a minimum,
and `GOTOOLCHAIN=local` ignores the second.

Each row was checked against Go 1.27.2 and golangci-lint 2.14.0, the versions
this repo's `mise.toml` pins, and against staticcheck 0.8.2, deadcode from
x/tools 0.52.0 and govulncheck 1.9.0. A few flags differ from what a reader
might expect:

- `go build -o /dev/null` discards the binary a module with one main package
  would otherwise write into the checkout.
- `--show-stats=false` keeps golangci-lint's per-linter tally off stdout,
  where it would follow the JSON and leave `lint.json` unwritten.
- `--max-issues-per-linter=0 --max-same-issues=0 --uniq-by-line=false` lift
  the caps golangci-lint puts on what it shows: 50 issues a linter, 3 with one
  message, and one a line across linters. With them, a baseline captured all
  of a repo's errcheck findings rather than the first 50, and `gosec` keeps a
  finding on a line `errcheck` already flagged. They override an `issues:`
  block in the repo's config, since a finding it hides can't be grandfathered,
  and surfaces as new when one it showed is fixed. `run --fix` fixes before
  the caps apply, so it doesn't take them.
- golangci-lint prints each path relative to the directory of the config it
  found, and checkride reads it as relative to the target's root, where it
  detects that config. A config further up the tree, or a
  `relative-path-mode` other than `cfg`, misnames every path and every
  baseline key with it. `--path-mode=abs` isn't the fix: golangci-lint builds
  the absolute path from the shell's `PWD`, so in a checkout reached through a
  symlink, such as macOS's `/tmp`, the paths fall outside the repo's real root
  and the keys would keep them absolute.
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
| `mutation` (opt-in) | `cargo-mutants` | `cargo mutants --output {out}` | a pin | `mutants.out/` in the check's artifact directory |

`cargo` itself resolves as a toolchain: through the toolchain file where one
pins it, else a `mise.toml` pin of `rust`, else `PATH`. rustfmt and clippy
resolve through the toolchain file first, as rustup components, and
cargo-machete, cargo-nextest, cargo-deny and
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
tree, and ships uncapped (`timeout: 0`), as stryker does, since it builds and
tests the crate once per mutant; only a per-check `timeout` caps it.

## The python pack

A python target checks a Python project from the directory that holds its
`pyproject.toml`, `setup.cfg` or `setup.py`:

```json
{
  "targets": {
    "api": { "lang": "python", "root": "services/api" }
  }
}
```

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `lint` | `ruff` | `ruff check --no-cache --output-format=json .`, and `ruff check --fix .` under `checkride fix` | `ruff.toml`, `.ruff.toml`, a `[tool.ruff]` table or a pin | `lint.json` |
| `format` (opt-in) | `ruff-format` | `ruff format --no-cache --check .`, and `ruff format .` under `checkride fix` | as `ruff` | `format.stdout.txt` |
| `types` | `mypy` | `mypy --output json .` | `mypy.ini`, `.mypy.ini`, a `[tool.mypy]` table or a pin | `types.jsonl` |
| `types` | `basedpyright` | `basedpyright --outputjson` | `pyrightconfig.json`, a `[tool.basedpyright]` or `[tool.pyright]` table, or a pin | `types.json` |
| `test` | `pytest` | `pytest -q` | `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `conftest.py`, a `[tool.pytest]` or `[tool.pytest.ini_options]` table, or a pin | `test.stdout.txt` |

A table is read from the `pyproject.toml` at the target's root, and a
sub-table counts, so `[tool.ruff.lint]` detects ruff on its own, and the
summary's `detected_by` names the header it found, such as
`pyproject.toml: [tool.ruff.lint]`. A pin is a `uv.lock` that lists the tool,
or a `mise.toml` that pins it. Where both of the `types` adapters are
configured, mypy, the first, takes the slot.

Each tool runs from the project's environment when `uv.lock` lists it, so
run `uv sync` before checking; a missing environment fails the check, naming
`uv sync`, and never falls back to another copy. mypy reads the installed
packages' types, so it needs that environment whichever copy runs.
basedpyright's wheel bundles the Node it runs on; checkride never runs the
PyPI `pyright` wrapper, which downloads Node the first time. A pytest run
that collects no tests exits 5, and that fails the `test` check like any
other failure, since a test slot with nothing to run would be a vacuous
green.

Each row was checked against ruff 0.17.1, mypy 2.4.0, basedpyright 1.40.2
and pytest 9.1.1. ruff runs with `--no-cache`, because it fails outright
where it can't create `.ruff_cache`, as in a checkout a `--static-only` pass
may not write to. mypy prints one JSON object per line for each error and
only a blank line when there are none, so a clean run writes no
`types.jsonl`, and its summary entry's `output_file` is `null`.

`checkride target add --lang python --add <slots>` names the blessed tool for
each slot and scaffolds its config under the target's root: `ruff.toml` for
`lint` and `format`, `mypy.ini` for `types` and `pytest.ini` for `test`, and
`checkride init --add` does the same at a root the python pack checks. A tool
the root's `pyproject.toml` already configures keeps that config, since a new
file would hide the table, and the command says so instead of writing one.

## The terraform pack

A terraform target checks a Terraform or OpenTofu root module from its
directory, which a `.terraform.lock.hcl` or any `.tf` file marks:

```json
{
  "targets": {
    "network": { "lang": "terraform", "root": "infra/network" }
  }
}
```

| Slot | Adapter | Runs | Detected by | Writes |
| --- | --- | --- | --- | --- |
| `format` (opt-in) | `terraform-fmt` | `terraform fmt -check -recursive -diff`, and `terraform fmt -recursive` under `checkride fix` | every terraform target | `format.stdout.txt` |
| `lint` | `tflint` | `tflint --recursive --format=json` | `.tflint.hcl` or a pin | `lint.json` |
| `types` | `terraform-validate` | `terraform validate -json` | `.terraform.lock.hcl` | `types.json` |
| `security` (opt-in) | `trivy-config` | `trivy config --format json --exit-code 1 --skip-check-update --cache-dir {out}/trivy-cache .` | a pin | `security.json` |

`terraform validate` reads the providers and modules `terraform init`
installs under `.terraform/`, so it checks a root module, the directory a
`.terraform.lock.hcl` marks, and nothing else. In a target without one, such
as a directory of shared child modules, `types` stands down with the reason
`no .terraform.lock.hcl marks a root module here`, even where the config or a
shared preset names `terraform-validate`. Where `.terraform/` is missing, or
the directory `TF_DATA_DIR` names when it's set, the check fails before
anything spawns, naming `terraform init -backend=false`, or
`tofu init -backend=false` where the repo runs OpenTofu. A check never runs
init, which downloads providers; `-backend=false` installs them without
touching the state backend. A `.terraform/` that's there but stale, missing a
provider the lock file now names, fails validate itself, and its message asks
for a plain `init`, which reaches for the backend too: run the same
`init -backend=false`.

tflint lints every directory under the target's root with `--recursive`,
hidden ones such as `.terraform/` aside, and exits 2 on an issue at any
severity, a notice included, since its default `--minimum-failure-severity`
fails them all. Its terraform ruleset ships inside tflint, so the blessed
`.tflint.hcl` needs no `tflint --init`. A `plugin` block for another
ruleset does: run `tflint --init` before checking, or tflint exits 1 naming
the missing plugin. trivy's scan is opted in by naming `security`, and needs
a `mise.toml` pin, or the config naming `trivy-config`, since a copy on one
machine's `PATH` says nothing about the repo. It exits 1 on a
misconfiguration at any severity. Its cache directory is a scratch path under
the check's own artifact directory, which a config scan never writes, so it
always runs the checks it ships with: in its default cache, a checks bundle
an earlier online scan downloaded would stand in for them, and one machine's
findings would differ from another's. Its log on stderr says so, as
`Falling back to embedded checks`.

tflint's issues key `checkride.baseline.json`, so `init --baseline`
grandfathers a failing `lint`, while validate's diagnostics and trivy's
misconfigurations reach `checkride/findings` and never the baseline: a type
error or a security finding is something to fix, not a debt to carry. A
tflint run that stopped short, its `errors` list holding an entry, is read as
untrustworthy, so the ratchet keeps every key it holds.

`--static-only` keeps fmt, tflint and trivy, since each reads the
configuration as data, and skips validate. It skips tflint wherever tflint
0.64.0 would run a plugin, since a plugin is a binary:

- any file under a `.tflint.d/` below the target's root, at any depth. tflint
  runs plugins from the `plugins/` of the one in each directory it lints, and
  a binary named for the bundled terraform ruleset runs in its place, even
  under a terraform-only `.tflint.hcl` or none.
- a `.tflint.hcl` there that opens a `plugin` block other than `terraform`,
  its label quoted or bare. Comments don't count, apart from block comments:
  the sniff reads those as configuration rather than risk hiding a plugin.
- a `.tflint.hcl` there that sets `source`, `version` or `plugin_dir`, which
  fetch a plugin or move where tflint looks for one. A rule's own `source` or
  `version` option skips it too.
- a `.tflint.json` there, which tflint reads where no `.tflint.hcl` sits, that
  declares any plugin or sets one of those keys.
- argv that passes `--chdir`, `--config` (or `-c`) or `--enable-plugin`,
  which reach past what the sniff reads.

Names match in any case, since macOS opens a file by any case of its name,
and the sniff reads what sits on disk, so files git ignores and a submodule's
files count. A terraform-only `.tflint.hcl` with no `.tflint.d/` keeps
tflint, as the blessed one does.

Each row was checked against OpenTofu 1.13.1, tflint 0.64.0 and trivy 0.76.0.
`terraform fmt -check` exits 3 when a file would change, and passes over
hidden directories, `.terraform/` among them, as `-recursive` walks.

`checkride target add --lang terraform --add lint` names tflint and
scaffolds the blessed `.tflint.hcl`, the terraform ruleset at its
`recommended` preset, under the target's root, and `checkride init --add lint`
does the same at a root the terraform pack checks.

Discovery proposes a terraform target for each directory a
`.terraform.lock.hcl` marks, which claims the `.tf` directories under it, and
then one for each top-most directory holding `.tf` files that none of those
claims. A root module below another, its own lock file beside it, is one no
module call reads, so the outer target's `validate` never checks it, and it
gets a target of its own, terraform's targets being the ones that may nest.
That target switches `lint`, `format` and `security` off, since the outer
target's tflint, `fmt` and trivy already walk its files, and runs `validate`
alone, after its own `terraform init -backend=false`:

```json
{
  "targets": {
    "infra": { "lang": "terraform", "root": "infra" },
    "registry": { "lang": "terraform", "root": "infra/registry", "checks": { "format": false, "lint": false, "security": false } }
  }
}
```

A directory of `.tf` files outside every terraform target fails `unclaimed`,
which suggests one target for all of them.

The CLI is `terraform` or `tofu`. The nearest `.terraform-version` or
`.opentofu-version`, from the target's root up to the repo root, says which,
`.opentofu-version` first where one directory holds both. With neither, a
`mise.toml` that pins `opentofu`, or a `--pins` file that does, makes it
`tofu`, and otherwise it's `terraform`. A check that names `terraform` runs
whichever the repo declares, so a command written once fits both.

The version file is the one tfenv and tofuenv read, and where one of them is
the CLI on `PATH`, it runs the release the file names. A plain CLI reads no
such file, so when the file names an exact release, such as `1.5.7`, checkride
asks the CLI on `PATH` for its version with `version -json` before the check
runs, and fails the check, naming both releases and the `tfenv install` or
`tofuenv install` that fixes it, when they differ. It never runs another copy
in place of the pinned one. A constraint such as `latest:^1.5` is left to the
version manager, and records no `tool_version`. With no version file, a
`mise.toml` pin runs the CLI through mise, and otherwise it comes from `PATH`,
and a CLI from `PATH` runs even under `requirePins`, as a toolchain does. Both
CLIs report `terraform_version` from `version -json`, checked against
Terraform 1.9.8 and OpenTofu 1.13.1.

## The entry command

The entry command is how the stop-hook gate, the AGENTS.md stanza and the
plugin skills run checkride in a repo, chosen from the repo root:

1. A root `package.json` with a `check` script: `<pm> run check`, as every
   release has run it. `init` writes that script.
2. Otherwise, a root `mise.toml` or `.mise.toml` whose `[tools]` declares
   `npm:checkride` or `github:robmclarty/checkride`: `mise exec -- checkride`.
   No standalone binary ships yet, so the second id waits on a later
   release.
3. Otherwise, a root `package.json` with no `check` script: still
   `<pm> run check`, which fails naming the missing script.
4. None of those: the `checkride` on `PATH`, which nothing pins, so `doctor`
   reports the harness unpinned.

The gate runs the entry command with `--strict --digest` and the gate
profile's flags. The hook script tests whether that copy is there to run
(`node_modules/.bin`, `mise which checkride`, or `command -v checkride`)
before it blocks on a gate that didn't answer. Where `mise which` fails
because mise hasn't trusted the `mise.toml`, the gate stands down naming
`mise trust`, as it names the install for a checkride that isn't there.

## What `doctor` reports

`checkride doctor` names the mode under its package-manager line: `implicit`,
where the repo is one project at its root, naming the pack its root marks
(`ts`, `go`, `rust`, `python` or `terraform`, as
[Targets](./targets.md#a-repo-without-targets) explains), or `multi-target`,
followed by a table of the targets the config declares. Each check gets a row, named `<target>:<slot>` in a target,
whose tool is looked for where that check runs from. The row names the pin
source the tool resolves through (`js-lockfile`, `mise`, `path`, or a
language's own `go-mod-tool`, `rust-toolchain`, `uv-lock` or `tf-version`),
and ends with the tag a run's status line gives the check, such as
`[detected: .golangci.yml]`. A tool a pin file declares, a `mise.toml` or a
language's own, and a toolchain's own executable (`go`, `gofmt`, `cargo`, and
`terraform`, which runs as `tofu` where the version file names OpenTofu), are
probed by asking the run's launcher: `ok` names what the run would spawn, with
the source it resolves through and the version that source names, such as
`mise 0.11.0` or `tf-version 1.13.1`, and `missing` carries the refusal the
run would fail with, so a version mise pins and hasn't installed reads as
missing, as it fails a run. A tool from a Nix dev
shell the repo declares reads as `nix` with its version, as the run records
it. Each tool nothing pins gets an **unpinned tools** row naming the checks
that run it and the `mise use` that would pin it: a warning, or with
`requirePins: true` a failure (exit 1) when a check that runs by default
uses it. Last, a **workspace** row lists the markers no target claims, the ones
the `unclaimed` check reports. A repo without `targets` gets a row only when it
holds another language's markers, such as a `go.mod` below a ts root, which
the one implicit project leaves unchecked, as a hint to declare targets.
Neither row ever fails `doctor`. `doctor --json` carries the same as `mode`,
`pack` (implicit mode only), `targets`, `unclaimed`, and each row's `target`
and `pinSource`. Under `--pins`, a check whose tool the file pins resolves
through `override` first, as in a run, and its row's `toolVersion` is the
version `mise where` finds. Under `--static-only`, a check a static run would
skip carries that run's `static-only:` reason as `skip`, and fails nothing.

## The spawn environment

A pack's variables apply to every check of that pack that spawns, the
target's custom checks included, and override the user's own values for those
variables only. The mise variables apply to every check whose tool resolves
through `mise` or `path`, since a tool on `PATH` may be one of mise's shims.
No row touches `GOFLAGS`: Go 1.24 already refuses to rewrite
`go.mod` during a build, and an explicit `-mod=readonly` would make Go ignore
`vendor/`, so a vendored module builds with an empty module cache. An adapter
marked `network: true` gets none of the variables that block the network
(`GOPROXY`, `CARGO_NET_OFFLINE`, `PIP_NO_INDEX` and `UV_OFFLINE`), and keeps
the ones that pin a toolchain or switch off an install.

A tool stopped by one of these variables names the variable, not the way out,
so a red check's status line is followed by the command to run first: `go mod
download` for Go's `module lookup disabled by GOPROXY=off`, `cargo fetch` for
an offline cargo's missing crate, `rustup toolchain install <toolchain>` for
rustup's `toolchain '<toolchain>' is not installed`, and `uv sync` for uv's
`Network connectivity is disabled, but the requested data wasn't found in the
cache`, which a `uv run` prints for a package its cache lacks. The raw output
keeps the tool's own words.

Where a `rust-toolchain.toml` or `rust-toolchain` pins the toolchain, every
spawn of a rust check also clears `RUSTUP_TOOLCHAIN`, which rustup 1.29.1 reads
as unset when it's empty. mise exports that variable for its own Rust, and it
would otherwise override the toolchain the repo's file names, so the verdict
would depend on the shell that ran it. Where another `cargo`, such as
Homebrew's, comes before rustup's proxy on `PATH`, the spawn also puts
rustup's directory first, so a component, a plugin's `cargo <sub>` and a
custom check's `cargo` all reach the one that reads the file; argv and
`pin_source` don't change. rustup's proxy is the `cargo` in the first
directory on `PATH` that holds `rustup` too, so a `rustup` with no `cargo`
beside it earlier on `PATH`, as GitHub's macOS runners link one into
`/opt/homebrew/bin`, doesn't stop the check. One gap remains: a `mise.toml` that pins `rust`
runs its checks through `mise exec`, which sets `RUSTUP_TOOLCHAIN` again
inside.

Each variable below was checked against the version of its tool that this
repo's `mise.toml` pins, or against upstream source for a tool it doesn't pin:
the pack rows and the first mise row on 2026-10-16, and the last three rows on
2026-10-18.

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
| terraform | `TRIVY_SKIP_CHECK_UPDATE` | `true` | trivy never downloads its checks bundle. | trivy 0.76.0: maps `--skip-check-update` to the variable, and logs that it loads no downloadable checks. With an empty cache it falls back to its embedded checks, and with a cached bundle it uses that one, which is why the `trivy-config` adapter points `--cache-dir` at a scratch path no scan writes. |
| any check launched through mise | `MISE_EXEC_AUTO_INSTALL`, `MISE_NOT_FOUND_AUTO_INSTALL` | `false` | mise never installs a missing tool. | mise 2026.10.4: `mise settings get` reads `false` for `exec_auto_install` and `not_found_auto_install`. A pinned version that isn't installed then runs a copy from `PATH`, which is why the `mise` source asks `mise which` first. |
| a tool a `--pins` file runs | `MISE_OFFLINE` | `1` | `mise where` and `mise exec` resolve a version against the copies mise has installed, never a remote list. | mise 2026.10.4: `mise where go@1.27` answers with the installed 1.27.2, and an uninstalled version exits 1 with `not installed` and downloads nothing. |
| a tool a `--pins` file runs | `MISE_IGNORED_CONFIG_PATHS` | the repo root, after any paths the variable already holds | mise reads no config file inside the repo, so an untrusted one there neither refuses the tool nor gets trusted. | mise 2026.10.4: splits the list on `:`, ignores every config file beneath a listed directory, and leaves its `[env]` unset inside `mise exec`. |
| a rust check where a toolchain file pins the toolchain | `RUSTUP_TOOLCHAIN` | empty | The repo's toolchain file decides, never the Rust mise exports. | rustup 1.29.1: an empty value reads as unset, while mise's exported channel would beat `rust-toolchain.toml`. |
