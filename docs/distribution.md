# Installing checkride

checkride ships through three channels:

- **npm**, for a repo with a `package.json`, where checkride is a
  devDependency.
- **The mise route**, for a repo without one: [mise](https://mise.jdx.dev)
  installs Node and the npm package side by side and runs checkride through
  `mise exec`.
- **The standalone binary**, one executable file that needs no Node on the
  machine. It ships from the first release that attaches binaries to its
  GitHub release. No release has yet, so until one does the mise route is the
  supported way to run checkride in a repo without Node.

`checkride doctor` names the channel a copy came through, `channel: npm` or
`channel: binary`.

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
`mise.toml`, with `node` beside it:

```toml
[tools]
node = "22.18.0"
"npm:checkride" = { version = "<version>", allow_low_downloads = true }
```

`<version>` is a checkride release, such as `0.15.0`. `init --lang go|rust`
writes that pin at the checkride you ran it with, and a repo that already
exists can add it in one command:

```bash
mise use node@22.18.0 'npm:checkride[allow_low_downloads=true]@<version>'
```

Keep the quotes: zsh reads unquoted brackets as a glob and refuses the
command. Then:

```bash
mise trust                   # once per clone
mise install                 # every pin, node and checkride among them
mise exec -- checkride init  # once: adopt the repo's tools, write the stanza and hooks
mise exec -- checkride       # the gate
```

mise loads a `mise.toml` that sets a tool option only once it's trusted, and
`allow_low_downloads` is a tool option, so until `mise trust` runs, mise
refuses the whole file and no check it pins can run: each fails naming
`mise trust`. `init --lang go|rust` prints `mise trust` first among its setup
steps for that reason.

checkride still runs on Node, so `node` is a pin like any other tool's: mise
installs it, and nothing on the machine's `PATH` has to provide it. Where a
root `mise.toml` pins `npm:checkride`, the AGENTS.md stanza, the plugin skills
and an opted-in stop gate run `mise exec -- checkride`, and `doctor` reports that harness
as pinned. A repo with no `package.json` that pins nothing runs the
`checkride` on `PATH`, which `doctor` reports as the harness unpinned, naming
the `mise use` above.

### Why the entry sets `allow_low_downloads`

mise's npm backend refuses a package with fewer than 1000 weekly downloads
until the entry that names it opts in, and checkride is under that line. The
refusal reads:

```text
refusing to add checkride: only <n> weekly downloads (threshold: 1000)
help: after verifying the package, set `allow_low_downloads = true` on `npm:checkride` to approve it
```

`allow_low_downloads = true` is that opt-in, given once, in the repo's own
`mise.toml`. It approves checkride alone, and every other `npm:` entry keeps
the check. An end-to-end test installs a scaffold's `mise.toml` this way,
through a mise that shares nothing with the machine's and finds no Node on
`PATH`, and runs `mise exec -- checkride --version`.

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

**It ships from the first release that attaches binaries.** Each such release
carries up to four tarballs, `SHA256SUMS`, and a build provenance attestation
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
as unpinned. mise's `github:` backend installs a release's asset for the
platform and records the version in the repo's `mise.toml`:

```bash
mise use github:robmclarty/checkride@<version>
mise exec -- checkride
```

The [entry command](./packs.md#the-entry-command) reads a
`github:robmclarty/checkride` pin the way it reads an `npm:checkride` one, so
the AGENTS.md stanza, the plugin skills and an opted-in stop gate run
`mise exec -- checkride`. It needs no `node` pin beside it and no
`allow_low_downloads`, which is the npm backend's rule. This route works from
the first release that carries binaries too. The binary's own hints name
this pin: `doctor`'s `harness` row, a gate that couldn't run, and the gate
hook it generates. `init --lang go|rust` writes the same files from either
channel, so its `mise.toml` still pins `npm:checkride` with `node` beside
it. Swap that entry for the `github:` one to drop Node from the repo.

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
  default to an npm tool. Cursor's generated `protect` hook is a Node script
  as well, so on a machine with no `node` Cursor can't run it. Claude Code's
  `protect` is a permission rule and needs none.

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

## Not yet

- **A release with binaries.** The release workflow builds, tests, attests
  and attaches them on the next tag, after the npm publish and the release
  themselves. Until that tag exists, everything under
  [The standalone binary](#the-standalone-binary) describes what it will
  carry, and building from a clone is the one way to get a binary.
- **A Homebrew tap.** It would come after the first binary release, as a
  convenience and never a pin.
