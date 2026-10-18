# Installing checkride

checkride ships through two channels:

- **npm**, for a repo with a `package.json`, where checkride is a
  devDependency.
- **The mise route**, for a repo without one: [mise](https://mise.jdx.dev)
  installs Node and the npm package side by side and runs checkride through
  `mise exec`.

A standalone binary waits for a later release. Until it ships, the mise route
is the supported way to run checkride in a repo without Node.

## npm

```bash
pnpm add -D checkride   # or: npm i -D, yarn add -D, bun add -d
pnpm exec checkride init
```

`init` writes a `check` script, so `pnpm check` (or `npm run check`, and so
on) runs the gate, and the hooks, the AGENTS.md stanza and the plugin skills
run that script. [Getting started](./getting-started.md) walks through it.

## The mise route

A Go, Rust or other repo with no `package.json` pins checkride in its root
`mise.toml`, with `node` beside it:

```toml
[tools]
node = "22.18.0"
"npm:checkride" = { version = "<version>", allow_low_downloads = true }
```

`<version>` is a checkride release, such as `0.14.0`. `init --lang go|rust`
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
mise exec -- checkride       # the gate
```

mise loads a `mise.toml` that sets a tool option only once it's trusted, and
`allow_low_downloads` is a tool option, so until `mise trust` runs, mise
refuses the whole file and no check it pins can run. `init --lang go|rust`
prints `mise trust` first among its setup steps for that reason.

checkride still runs on Node, so `node` is a pin like any other tool's: mise
installs it, and nothing on the machine's `PATH` has to provide it. Where a
root `mise.toml` pins `npm:checkride`, the hooks, the AGENTS.md stanza and the
plugin skills run `mise exec -- checkride`, and `doctor` reports that harness
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

## Not in this release

- **A standalone binary.** The entry command already counts a
  `github:robmclarty/checkride` pin as declaring checkride, but no release
  carries a binary for that backend to install yet. Switching a repo from
  `npm:checkride` to `github:` is a later release's to document.
- **A Homebrew tap.** It would come with the binary, as a convenience rather
  than a pin.
