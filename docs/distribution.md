# Installing checkride

checkride ships through two channels, and a repo runs it one of three ways:

- **npm**, for a repo with a `package.json`, where checkride is a
  devDependency.
- **The standalone binary**, one executable file that needs no Node on the
  machine. Every release from 0.21.0 attaches one per platform to its GitHub
  release.
- **The mise route**, for a repo without a `package.json`:
  [mise](https://mise.jdx.dev) pins checkride in the repo's `mise.toml` and
  runs it through `mise exec`. The pin is the binary, which is what
  `init --lang go|rust` writes on a platform a release has one for, or the
  npm package with Node beside it, which it writes anywhere else.

`checkride doctor` names the channel a copy came through, `channel: npm` or
`channel: binary`.

[Starting a new project](#starting-a-new-project) scaffolds a repo from
nothing, and [Uninstalling](#uninstalling) lists every file checkride writes.

## npm

```bash
pnpm add -D -E checkride   # or: npm i -D -E, yarn add -D -E, bun add -d -E
pnpm exec checkride init
```

`-E` pins the exact release, as the
[pin policy](./contract.md#versioning-and-pin-policy) asks while checkride is
below 1.0, where a minor release may break.

`init` writes a `check` script, so `pnpm check` (or `npm run check`, and so
on) runs the gate, and the AGENTS.md stanza, the plugin skills and the stop
gate, where a repo opts in to it, run that script. [Getting started](./getting-started.md) walks through it.

## The mise route

A Go, Rust or other repo with no `package.json` pins checkride in its root
`mise.toml`:

```toml
[tools]
"github:robmclarty/checkride" = "<version>"
```

`<version>` is a checkride release that carries binaries, `0.21.0` or later.
mise's `github:` backend installs that release's binary for the platform, so
the repo needs no Node. `init --lang go|rust` writes that pin at the checkride
you ran it with, on a machine [a release has a binary for](#the-binary-has-to-be-there),
and a repo that already exists can add it in one command:

```bash
mise use github:robmclarty/checkride@<version>
```

Then:

```bash
mise install                 # every pin, checkride among them
mise exec -- checkride init  # once: adopt the repo's tools, write the stanza and hooks
mise exec -- checkride       # the gate
```

`init` adopts the repo through the pack its root marks. It names the checks
the tools it finds fill, `types` and `test` for a `go.mod`, say, plus `lint`
where a `.golangci.yml` sits, writes the AGENTS.md stanza spelled
`mise exec -- checkride`, and writes no `check` script, since there's no
`package.json` to hold one. Pin the pack's own tools in the same `mise.toml`
(`mise use golangci-lint@<version>`, for one), and run the setup step a check
won't, such as `go mod download` or `uv sync`, before the first run. A repo
whose languages all live in subdirectories, with nothing at the root but the
`mise.toml`, is adopted the same way: `init` declares a target for each
project below the root, as [the polyglot walkthrough](./polyglot.md) shows.

No `mise trust` comes first. mise asks for one only where a `mise.toml` sets
a tool option or an env var, and this entry sets neither, so a fresh clone
installs and runs as it is. A repo whose `mise.toml` does set one, as
[the npm pin](#pin-the-npm-package-instead) does, needs `mise trust` once per
clone, and until then each check mise pins fails naming it. If mise reports
the file as untrusted all the same, run `mise trust`: an older or stricter
mise may ask for it, and so will this one once the file gains `[env]`, tasks
or a template. The stop gate stands down naming `mise trust` in that state
rather than blocking.

Where a root `mise.toml` pins checkride, the AGENTS.md stanza, the plugin
skills and an opted-in stop gate run `mise exec -- checkride`, and `doctor`
reports that harness as pinned. A repo with no `package.json` that pins
nothing runs the `checkride` on `PATH`, which `doctor` reports as the harness
unpinned, naming the `mise use` above.

An end-to-end test installs a scaffold's `mise.toml` this way, through a mise
that shares nothing with the machine's and finds no Node on `PATH`, and runs
`mise exec -- checkride --version` and `doctor`.

### The binary has to be there

A release carries a binary for four platforms: macOS and glibc Linux, each on
arm64 and x86-64. Two things follow for the pin.

**A platform with no binary.** On Windows, or an architecture outside those
two, mise finds no asset to install and `mise install` fails. Alpine is
worse: mise picks an asset by operating system and architecture, and the
tarballs' names say nothing of the C library, so on a musl Linux the install
is likely to succeed, with the glibc build, and `mise exec -- checkride` then
fails to start, typically with a `not found` for a binary that is plainly
there. Either way the answer is
[the npm pin](#pin-the-npm-package-instead).

`init --lang go|rust` makes that choice for the machine it runs on. On one of
the four platforms it writes the `github:` pin and no `node`. Anywhere else,
a musl Linux included, it writes the npm pin with `node` beside it, prints
`mise trust` ahead of `mise install`, and says why:

```text
  no standalone binary ships for linux-x64 (musl), so mise.toml pins checkride from npm, with node beside it.
```

The `mise.toml` is committed, so the pin is the scaffolding machine's choice
for everyone who clones the repo. A team that develops on macOS and runs CI
on Alpine swaps the entry for the npm pin by hand.

**A release moments old.** npm is the primary channel, so a tag publishes to
npm and creates its GitHub release without waiting for the binaries, which
attach a few minutes later, each platform on its own. A scaffold written by
a checkride installed from npm in that window pins a version whose binary
isn't there yet, and `mise install` fails until it attaches. A platform whose
build failed for that release stays missing until the release workflow is
re-run. [The standalone binary](#the-standalone-binary) has the command that
lists what a release holds.

### GitHub's rate limit

mise's `github:` backend finds the binary by listing the release's assets
through GitHub's API. Asked anonymously, that API allows 60 requests an hour
per IP address, and a hosted CI runner shares its address with other jobs, so
`mise install` there can fail with a 403 that has nothing to do with the
repo. A token lifts the limit. `jdx/mise-action` passes the job's own token
by default. Anywhere else, set `GITHUB_TOKEN` on the step that runs
`mise install`:

```yaml
      - run: mise install
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

A read-only token is enough: the release is public, and the token only says
who is asking. On a laptop the anonymous limit is rarely reached, and
`GITHUB_TOKEN` in the shell lifts it there too.

### Pin the npm package instead

A repo that would rather run the npm package, or sits on a platform with no
binary, pins `npm:checkride` with `node` beside it:

```toml
[tools]
node = "22.18.0"
"npm:checkride" = { version = "<version>", allow_low_downloads = true }
```

```bash
mise use node@22.18.0 'npm:checkride[allow_low_downloads=true]@<version>'
mise trust                   # once per clone
mise install                 # every pin, node and checkride among them
mise exec -- checkride
```

Keep the quotes: zsh reads unquoted brackets as a glob and refuses the
command. The npm package runs on Node, so `node` is a pin like any other
tool's: mise installs it, and nothing on the machine's `PATH` has to provide
it. The [entry command](./packs.md#the-entry-command) reads this pin the way
it reads the `github:` one.

mise's npm backend refuses a package with fewer than 1000 weekly downloads
until the entry that names it opts in, and checkride is under that line. The
refusal reads:

```text
refusing to add checkride: only <n> weekly downloads (threshold: 1000)
help: after verifying the package, set `allow_low_downloads = true` on `npm:checkride` to approve it
```

`allow_low_downloads = true` is that opt-in, given once, in the repo's own
`mise.toml`. It approves checkride alone, and every other `npm:` entry keeps
the check. It is also a tool option, which is why this pin needs
`mise trust`: mise refuses the whole file until then.

## The standalone binary

The binary is the same CLI as the npm package, built as a Node
[single executable application](https://nodejs.org/api/single-executable-applications.html):
the bundled CLI, the scaffold templates, the schemas and the skills, embedded
in a copy of Node, with the three libraries the
[`schema` slot](./tools.md#the-schema-slot-data-files-against-json-schemas)
validates with (`ajv`, `yaml` and `jsonc-parser`) bundled in. It runs the code paths the npm CLI runs, on the Node it
carries, so a Go, Rust, Python, Terraform or Odin repo needs no Node and no
package manager to run its gate. `checkride --version` prints the same
version in both channels, and `init` scaffolds the same files, byte for byte.

**It ships from 0.21.0, the first release to attach binaries.** Each release
since carries up to four tarballs, `SHA256SUMS`, and a build provenance attestation
for each tarball:

| Tarball | Platform |
| ------- | -------- |
| `checkride-<version>-darwin-arm64.tar.gz` | macOS on Apple silicon |
| `checkride-<version>-darwin-x64.tar.gz` | macOS on Intel |
| `checkride-<version>-linux-x64.tar.gz` | Linux on x86-64, glibc |
| `checkride-<version>-linux-arm64.tar.gz` | Linux on arm64, glibc |

Each holds two files, `checkride` and `LICENSE`. No musl build ships, so
Alpine takes the npm channel, and no Windows build does either.

The binaries attach a few minutes after the release appears. npm is the
primary channel, so a tag publishes to npm and creates its GitHub release
without waiting for them, and each platform builds and is tested on its own:
one that fails is left off, the others still attach, and `SHA256SUMS` lists
exactly the tarballs the release holds. Check that a platform's tarball is
there before pointing a script or a pin at it:

```bash
gh release view v<version> --repo robmclarty/checkride --json assets --jq '.assets[].name'
```

A platform missing from that list, and from `SHA256SUMS`, failed its build
for that release. The release workflow's run for the tag shows which, ends
red, and can be re-run for the tag from the Actions tab.

### Install from a release tarball

```bash
version=<version>        # a release that carries binaries, without the v
target=darwin-arm64      # or darwin-x64, linux-x64, linux-arm64
base="https://github.com/robmclarty/checkride/releases/download/v$version"

curl -fsSLO "$base/checkride-$version-$target.tar.gz"
curl -fsSLO "$base/SHA256SUMS"
```

Verify the download before running it. The checksum says the file is the one
the release holds, and the attestation says the release workflow built it
from this repository:

```bash
shasum -a 256 --check --ignore-missing SHA256SUMS   # Linux: sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify "checkride-$version-$target.tar.gz" --repo robmclarty/checkride
```

Then unpack it and put `checkride` on `PATH`:

```bash
tar -xzf "checkride-$version-$target.tar.gz"
install -m 755 checkride ~/.local/bin/checkride   # any directory on PATH
checkride --version
checkride doctor
```

The macOS binaries carry an ad-hoc signature and no notarization. A copy a
browser downloaded is quarantined, and macOS refuses to open it until
`xattr -d com.apple.quarantine checkride` clears that. `curl` sets no
quarantine.

### Pin it with mise

A binary on `PATH` is a copy nothing pins, and `doctor` reports that harness
as unpinned. [The mise route](#the-mise-route) pins it: mise's `github:`
backend installs a release's asset for the platform and records the version
in the repo's `mise.toml`:

```bash
mise use github:robmclarty/checkride@<version>
mise exec -- checkride
```

It needs no `node` pin beside it, no `allow_low_downloads`, which is the npm
backend's rule, and no `mise trust`. The binary's own hints name this pin:
`doctor`'s `harness` row, a gate that couldn't run, and the gate hook it
generates. `init --lang go|rust` writes the same files from either channel,
this pin among them.

### How the binary runs itself

Without a pin, the entry command is the `checkride` on `PATH`, and the
stanza and the hooks say `checkride`. When the binary's own `gate` or
`triage` runs that command, it runs itself, by its own path: a binary
started as `/opt/tools/checkride triage` needs no `checkride` on `PATH`, and
a different `checkride` there is never the one its gate ran. `triage` asks
`doctor` of the same copy. In a repo with a `package.json`, the gate goes
through the `check` script as it does from npm, and `triage` asks the
checkride installed in the repo.

The Node inside the binary runs checkride and nothing of the repo's. Where
a repo pins Node in `.nvmrc` or `.node-version`, the gate compares that pin
with the `node` on `PATH`, leaves a `PATH` that satisfies it alone, and puts
the pinned install in front of one that doesn't, or that holds no `node`.

### What the binary leaves out

- **The programmatic API.** `import { runChecks } from 'checkride'` and the
  `checkride/findings` subpath are modules of the npm package. The binary is
  a command and exports nothing.
- **The plugin's `dist/` readers.** The Claude Code plugin's skills fall back
  to `node dist/triage/cli.js` and `node dist/qa/cli.js` from the plugin's
  own copy. With the binary, run `checkride triage` and `checkride qa`, the
  same readers behind the CLI, which is what the skills try first.
- **Package presets.** An `extends` entry that names an npm package fails
  with exit 2, `invalid checkride.config.json: package presets need the npm
  distribution; use a file path: extends "@acme/preset" (in team.json)`. It
  names a suite's own config file for a suite, then the entry and the file
  that holds it, which may be a preset several files down. A file path,
  relative or absolute, resolves as it does from npm.
- **Tools that are Node programs.** The binary carries checkride and not the
  tools it runs. A check whose tool comes from npm, such as oxlint or cspell,
  still needs that tool installed, and the TypeScript pack's `smoke`
  built-in still runs the repo's own `node`. The repo pack's
  [single-binary alternates](./packs.md#without-node) cover the slots that
  default to an npm tool. The agent hooks need no Node: Claude Code's
  `protect` is a permission rule, and in a repo whose entry command is
  `mise exec -- checkride` or `checkride` from `PATH`, Cursor's `protect`
  hook calls [`checkride protect`](./cursor.md#which-form-of-protect-a-repo-gets)
  where a repo with a package manager gets a generated Node script.

One thing the binary carries that the npm package doesn't: the `schema`
slot's libraries. From npm they're optional peers the repo installs. A repo
with no Node has no install to hold them, so the binary bundles `ajv` 8,
`yaml` 2 and `jsonc-parser` 3 at the versions the release was built with, and
a `schemas` rule runs there with nothing to install. It never consults a copy
in the repo's own `node_modules`, and `doctor` shows the slot's row as
`bundled:` with each version.

`doctor`'s `node` row fails nothing in the binary when `PATH` holds no
`node`: it reads `not on PATH (checkride embeds Node <version>)`, and the
`channel` line names the embedded Node. A `node` that is on `PATH` is still
held to the repo's `engines.node`, and it's the one the `node pin` row's
hint names.

### Build it yourself

`pnpm build:sea` in a clone builds the binary for the machine it runs on and
prints its path. [CONTRIBUTING.md](../CONTRIBUTING.md#the-standalone-binary)
has the details.

## Starting a new project

`init` in an empty directory scaffolds a project that's green out of the box,
and an end-to-end test holds each shape.

### A TypeScript project

```bash
pnpm dlx checkride init --shape flat --name my-app
pnpm install
pnpm check
```

Pick a shape:

- **flat** — a single package using the deep-modules layout under `src/`.
- **monorepo** — a pnpm workspace of `apps/*` and `libs/*`.
- **hybrid** — a root app in `src/` plus internal `packages/*`.

Preview without writing anything using `--dry-run`.

The generated project is a pnpm project: its `engines` field and
`pnpm-workspace.yaml` assume it, and the monorepo and hybrid shapes are pnpm
workspaces. To start under npm, yarn, or bun, create the `package.json` first
(`npm init -y`, or your manager's equivalent), then take the
[existing-repository path](./getting-started.md#install-it). `init --add <slots>`
scaffolds the tool configs a bare repository lacks (`init --add struct,dead`,
for example).

Every shape writes its code in one layout, the one
[deep modules](./deep-modules.md) describes. The flat `my-app` above starts as:

```text
my-app/
├── src/
│   ├── index.ts             ← the barrel: re-exports, no logic
│   ├── my-app.ts            ← the starter module
│   └── __tests__/
│       └── my-app.test.ts   ← unit tests sit beside the code they cover
└── rules/                   ← the ten ast-grep rules that hold the layout
```

Tests that span modules go under `test/`, which `init` leaves for you to create
when you need it. It holds five folders and nothing else:

```text
test/
├── integration/   ← tests that span modules
├── e2e/           ← end-to-end tests
├── contract/      ← tests that hold a published surface in place
├── helpers/       ← shared test code
└── fixtures/      ← test data
```

In the monorepo and hybrid shapes, each package under `apps/`, `libs/` or
`packages/` has its own `src/` and `test/`, laid out the same way. The `struct`
check holds the layout, so a test in the wrong place fails the run. Every tool
`init` configures skips `test/fixtures/`, so a fixture that is broken on purpose
can't fail it.

`init` also writes a `checkride.config.json` naming each check it set up and
the tool that runs it; [Configuration](./configuration.md#the-config-init-writes)
shows the file and why it, not detection, picks each tool.

### A Go or Rust project

`--lang go` or `--lang rust` scaffolds a project with no `package.json`, which
mise runs:

```bash
mkdir my-api && cd my-api
pnpm dlx checkride init --lang go --shape module --module github.com/acme/my-api
mise install
go get -tool golang.org/x/tools/cmd/deadcode@v0.52.0
mise exec -- checkride
```

`init` prints the steps that need the network, since a check never fetches
anything. On a machine with no Node, mise runs the same `init` from the
binary: `mise exec github:robmclarty/checkride@<version> -- checkride init`
with the same flags. Pick a shape:

- **go module** — `go.mod`, `cmd/<name>/main.go` and `internal/greet/` with a
  test. Go's `internal/` is the deep-module boundary, and the compiler holds
  it. `--module` names the module, `example.com/<name>` by default.
- **go workspace** — `go.work` over a `core` and a `cli` module.
- **rust crate** — `Cargo.toml` (edition 2024, `unsafe_code` forbidden and
  `unwrap_used` denied), `src/lib.rs` with a doctest and a test, and
  `src/main.rs`.
- **rust workspace** — a virtual manifest over `crates/core` and `crates/cli`.

Each writes a `mise.toml` that pins checkride (as
`github:robmclarty/checkride`, the release's standalone binary) and every
binary tool its checks run, at the versions they were tested with, and a `checkride.config.json` with one target, `app`, at the
root, naming every slot, with `requirePins: true`. The `struct` check runs the
pack's dialect rules from `rules/go/` or `rules/rust/`: no dot imports, no
import aliases and no `init` outside `package main` in Go, and no glob
imports or re-exports in Rust. A Rust project's `rust-toolchain.toml` pins the
toolchain, with rustfmt and clippy, and its config names `snippets`, so its
doctests run. Every shape is green once its setup has run.

Nothing in that `mise.toml` installs through Node or runs on it, so the
project needs none, and no entry sets a tool option, so `mise install` works
without a `mise trust` before it. If mise reports the file as untrusted all
the same (an older or stricter mise, or once the file gains `[env]`, tasks or
a template), run `mise trust`. On a machine no release has a binary for, such
as Alpine or Windows, `init` pins `npm:checkride` with a `node` beside it
instead, says so, and prints `mise trust` first, which that pin needs. mise finds the binary through GitHub's API,
which rate-limits anonymous requests: in CI, give the install a token, as
[GitHub's rate limit](#githubs-rate-limit) shows, and
[the mise route](#the-mise-route) has the pin for a repo you already have.

## Uninstalling

No lock-in needs undoing. checkride's whole footprint is: the `checkride`
devDependency (or its pin in `mise.toml`, `github:robmclarty/checkride` or
`npm:checkride`),
`checkride.config.json`, `checkride.baseline.json` (if you
baselined), the `check` script alias, the AGENTS.md stanza between the
`checkride:begin`/`checkride:end` markers (plus the `@AGENTS.md` import in
CLAUDE.md, or the whole CLAUDE.md if `init` created it), checkride's deny
rules in `.claude/settings.json` and its entries in `.cursor/hooks.json` with
their `checkride-*` scripts (plus the stop gate's entries and scripts, if you
opted in), the
`.cursor/skills/checkride-*` directories, and the gitignored `.check/` output
directory, and the config and baseline files at a local target's root. Remove
those and checkride is gone. The
tools keep working untouched — they are ordinary `devDependencies` with their
own config files, so `pnpm exec oxlint`, `pnpm exec vitest run`, and the rest
run exactly as before; you have merely dropped the orchestrator.

## Not yet

- **A release with binaries.** The release workflow builds, tests, attests
  and attaches them on the next tag, after the npm publish and the release
  themselves. Until that tag exists, everything under
  [The standalone binary](#the-standalone-binary) describes what it will
  carry, and building from a clone is the one way to get a binary.
- **A Homebrew tap.** It would come after the first binary release, as a
  convenience and never a pin.
