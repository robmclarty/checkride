# Targets

A repo with more than one language, or one language in more than one place,
declares **targets**: named parts of the repo, each checked from its own root
by the pack that knows its language. A repo without targets is checked as one
project at its root, by the pack its root marks. Declaring any switches it to
multi-target mode.

```json
{
  "targets": {
    "web": { "lang": "ts", "root": "web" },
    "scripts": { "lang": "bash", "root": "scripts" }
  }
}
```

[`examples/polyglot-ts-bash`](../examples/polyglot-ts-bash/) runs this config
end to end, and [A polyglot repo, end to end](./polyglot.md) walks a
four-language repo from `init`'s proposal to the targets it keeps.

A target's name starts with a lowercase letter and holds only lowercase
letters, digits and hyphens, 32 characters at most. It can't be a slot's name
or a custom check's, since `--only <name>` has to mean one thing, nor
`doc-snippets`, where the `snippets` check keeps its scratch files. Its `root`
is a directory inside the repo, relative to the repo root, and only the repo's
own config declares targets: a preset that `extends` names can't.

## A repo without targets

Without `targets`, the repo is one unnamed target at its root, and its pack is
the first that matches:

1. a root `package.json` or `tsconfig.json` picks `ts`, exactly as before, even
   when the repo also holds Go or Rust code that custom checks cover;
2. a root `go.mod` or `go.work` picks `go`;
3. a root `Cargo.toml` picks `rust`;
4. a root `pyproject.toml`, `setup.cfg` or `setup.py` picks `python`;
5. a root `.terraform.lock.hcl` or `*.tf` file picks `terraform`;
6. anything else picks `ts`, where every slot stands down as it always has.
   When [`target add`](#declaring-targets) converts such a repo, its root
   becomes a target only if it configures a tool of its own.

A Go, Rust, Python or Terraform root runs its pack's checks under their bare slot names (`types`,
`lint`, `test`), from the root and into `.check/`, as a declared target of that
pack rooted at `.` would run them otherwise: the pack's tools, pin chain and
spawn environment, and no check for a slot the pack doesn't fill. A top-level
entry may still pick the tool, since there's only one pack to pick from, and
each check's summary entry records its `pack`. A ts root records none, as
before.

In any repo without targets, the top-level `checks` are the implicit target's
own entries, so they rank above the `packs.<pack>.checks` block of the root's
pack, the same order they keep once `target add` moves them into a target. A
preset's pack block then fills what the repo's own entries leave open.

## What a target runs

Each target runs the slots its pack fills, once, from its root: `web:types`,
`web:lint`, `scripts:lint` and so on. The repo-scope slots (`struct`, `docs`,
`links`, `spell`, `prose` and `unclaimed`) still run once, for the whole repo,
under their bare names, and so do top-level custom checks.

A target's slot takes its tool from the target's own `checks`, then from
`packs.<pack>.checks`, then from the top level, then from detection at the
target's root. Once targets are declared, a top-level entry for a target-scope
slot may only switch it off or tune it (`optIn`, `timeout`, `order`), because
the tool depends on the pack. Each check writes under `.check/<target>/` (or
`<out>/<target>/`), and its baseline keys name files from the repo root.

A ts target's checks run under the package manager nearest its root: the first
lockfile or `packageManager` field from there up to the repo root, else pnpm.
`checkride fix` runs each target's fixers from its root, through the same pin
chain as its checks.

`--only`, `--skip` and `--include` take a slot (every target's), a target (all
of its checks), or `<target>:<slot>` (one check). `--changed` skips each check
of a target nothing changed under, with the reason `no changes under <root>`.
It reads the paths that differ from the merge base of its base and `HEAD`,
committed, staged, unstaged or untracked, so build output git doesn't ignore
counts as a change.

## The packs

| Pack | Checks | Tools |
| --- | --- | --- |
| `ts` | a root and everything under it | the project's package manager, as before |
| `bash` | a list of shell files under its root | shellcheck (`lint`) and shfmt (`format`, opt-in), through `mise` then `PATH` |
| `go` | a Go module or workspace from its root | go build, gofmt (opt-in), golangci-lint or staticcheck, deadcode, go test and govulncheck (opt-in), with Go's downloads switched off |
| `rust` | a Cargo package or workspace from its root | cargo check, rustfmt (opt-in), clippy, cargo-machete, nextest or cargo test, doctests (opt-in), cargo-deny (opt-in) and cargo-mutants (opt-in), offline, with the toolchain its `rust-toolchain.toml` names |
| `python` | a Python project from its root | ruff (`lint`, and `format`, opt-in), mypy or basedpyright and pytest, each from the project's `.venv` when `uv.lock` lists it, with pip's and uv's downloads switched off |
| `terraform` | a Terraform or OpenTofu module from its root | terraform fmt (opt-in), tflint, terraform validate where a `.terraform.lock.hcl` marks a root module, and trivy (opt-in), with `terraform` or `tofu` as its version file declares, at the release that file names, and no prompt or call home |

A bash target's checks run over its files: by default every `.sh` and `.bash`
file and each extensionless file with a shell shebang, narrowed with `include`
and `exclude` globs. A rust target is rooted at its workspace's root, the
directory whose `Cargo.toml` holds `[workspace]`, or a lone package's own, as
discovery proposes it: cargo names each file from the workspace root, so a
target declared at a member crate would key its findings and baseline entries
by the wrong paths. [Packs and pins](./packs.md) covers each pack's tools and
how each tool resolves to the copy that runs.

## Code no target checks

`unclaimed` runs in every multi-target run and fails when a toolchain marker
(`package.json`, `tsconfig.json`, `go.mod`, `go.work`, `Cargo.toml`,
`pyproject.toml`, `setup.cfg`, `setup.py`, `.terraform.lock.hcl` or a `*.tf`
file) sits outside every target of its language, naming the target that would
claim it in `.check/unclaimed.json`. A root `package.json` that only
installs tools, above ts targets in their own directories, goes in
`unclaimed.ignore`, since two ts targets can't nest, and so does any marker
above a target of its own pack, such as a root `go.mod` above a `go.work`
target, which the message names in place of a target to add.

## Declaring targets

- `checkride target add <name> --lang <pack> --root <dir>` adds one, adopting
  the tools its root already configures. In a repo without targets, the
  implicit project becomes a target of its pack named `app` at `.`, and its
  top-level entries and baseline keys move with it. A root that marks no pack
  becomes that target only when it configures a tool, an `.oxlintrc.json` for
  one, or an entry picks one; otherwise the new target is declared alone, so
  a ts target below the root is never blocked by one at `.`.
- `checkride init` in an existing repo, one whose root holds a `package.json`
  or another pack's marker, or holds none but has a project below it, adopts
  the tools it finds through the implicit pack, proposes the targets its
  files suggest, and writes them when there's more than the one project at
  the root. Where that pack isn't `ts`, `--add`
  takes `docs`, `spell` and `prose`, and the pack's own blessed configs where
  it has them (python's `lint`, `format`, `types` and `test`, terraform's
  `lint`), and exits 2 on a slot whose blessed config is the ts pack's.
- `checkride --discover` checks the targets `init` would propose without
  writing them: the top-level entries and baseline keys move to the target at
  the root, in memory. A repo whose config already declares targets checks
  those, with a note on stderr saying they stand in. Discovery proposes a ts
  target at the root when the root holds a `package.json`,
  `pnpm-workspace.yaml` or `tsconfig.json` and runs a ts tool of its own (a
  config entry picks one, or detection finds a default ts check's config file
  or package there), claiming every ts project under it, and otherwise one
  for each top-most `package.json` or `tsconfig.json` directory below the
  root, with a root `package.json` listed in `unclaimed.ignore`. It proposes
  a go target for each top-most `go.work` and each `go.mod` outside one, a rust target for each top-most `[workspace]`
  manifest and each `[package]` one outside it, and a python target for each
  top-most `pyproject.toml`, `setup.cfg` or `setup.py` directory, which
  claims the ones under it, a terraform target for each top-most
  `.terraform.lock.hcl` directory and then each top-most directory of `.tf`
  files none of those claims, and a bash target where the shell files outside
  every other target gather. Where a pack's
  second rule finds a root above one its first proposed, a `go.mod` above a
  `go.work`, a `[package]` above a `[workspace]` or `.tf` files above a lock
  file, the inner root wins, and `unclaimed` reports the outer one's markers.
  A cargo-fuzz harness is no root: its crate's target claims it.
- `checkride doctor` names the mode and the implicit pack, lists the targets,
  and reports each check's pin source and the markers no target claims.
  `doctor --discover` shows what `--discover` would check.

[The contract](./contract.md) holds the exact rules each of these keeps.
