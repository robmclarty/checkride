# Tools and installation

checkride has **no runtime dependency on any tool it runs**. For each slot it
spawns `<pm> exec <tool>` — where `<pm>` is your repo's package manager (see
[Package managers](#package-managers) below) — so the tools are ordinary project
`devDependencies`, pinned and owned by your repository. "Installing a missing
tool" therefore means adding an npm package — not a separate system binary.

There are two layers:

1. **System prerequisites** — installed outside the project, once per machine.
2. **Slot tools** — installed into the project with pnpm.

## System prerequisites

| Tool | Minimum | Install |
| ---- | ------- | ------- |
| Node | `>=22.18` | <https://nodejs.org> or `nvm install 22 && nvm use 22` (24 works too) |
| a package manager | pnpm `>=9` (default) / npm / yarn / bun | pnpm: `corepack enable && corepack prepare pnpm@latest --activate` |
| git  | any | <https://git-scm.com/downloads> |

The commands in this doc use pnpm's forms; on another manager, substitute yours
per the [Package managers](#package-managers) table below.

Check them with `pnpm exec checkride doctor`.

## Package managers

checkride detects your repo's package manager and runs each tool through it, so
pnpm is the default but not a requirement. Detection uses the `packageManager`
field in `package.json` first, then the lockfile:

| Lockfile | Manager | Exec form |
| -------- | ------- | --------- |
| `pnpm-lock.yaml` | pnpm (default) | `pnpm exec <tool>` |
| `package-lock.json` | npm | `npx <tool>` |
| `yarn.lock` | yarn | `yarn <tool>` |
| `bun.lock` / `bun.lockb` | bun | `bunx <tool>` |

With no lockfile or field, checkride falls back to pnpm. `doctor` prints the
detected manager at the top of its report and verifies that manager is on your
PATH (pnpm keeps its `>=9` floor; the others are presence-only for now).

The one manager-specific slot is `security`: it runs `pnpm audit`, whose flags
and JSON shape don't port across managers, so on npm/yarn/bun the slot is
reported **unavailable** until a per-manager audit adapter lands. Every other
slot runs identically regardless of manager.

## Slot tools

Each slot is filled by one tool. A slot runs only when its detect file is
present (built-in checks always run). The default tool per slot:

| Slot | Tool | Install with | Detect file |
| ---- | ---- | ------------ | ----------- |
| `types` | `tsc` | `pnpm add -D typescript @types/node` | `tsconfig.json` |
| `format` | `prettier` (opt-in) | `pnpm add -D prettier` | `.prettierrc.json` |
| `lint` | `oxlint` | `pnpm add -D oxlint oxlint-tsgolint` | `.oxlintrc.json` |
| `struct` | `ast-grep` | `pnpm add -D @ast-grep/cli` | `sgconfig.yml` |
| `dead` | `fallow` | `pnpm add -D fallow` | `fallow.toml` |
| `test` | `vitest` | `pnpm add -D vitest @vitest/coverage-v8` | `vitest.config.ts` |
| `docs` | `markdownlint-cli2` | `pnpm add -D markdownlint-cli2` | `.markdownlint-cli2.jsonc` |
| `links` | built-in | — (always available) | — |
| `spell` | `cspell` | `pnpm add -D cspell` | `cspell.json` |
| `mutation` | `stryker` | `pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner` | `stryker.config.mjs` |
| `security` | `pnpm audit` | — (built into pnpm) | — (opt-in) |
| `publint` | `publint` | `pnpm add -D publint` | — (opt-in) |
| `attw` | `attw` | `pnpm add -D @arethetypeswrong/cli` | — (opt-in) |

Note the npm package names differ from the binary names: `ast-grep` ships in the
`@ast-grep/cli` package, `stryker` ships in `@stryker-mutator/core`, and `attw`
ships in `@arethetypeswrong/cli`.

Some slots accept alternates that checkride will also run if it detects their
config: `format` → `biome`; `lint` → `biome` or `eslint`; `dead` → `knip`; `test`
→ `jest`. The blessed default is the one `init` scaffolds; the rest just need their
own config file present.

The `format` slot is **opt-in**: `checkride init --add format` scaffolds
`.prettierrc.json`, then enable it by naming it in `checkride.config.json`
(`"format": "prettier"`) or with `--include format`. Keeping it opt-in means
adopting checkride never fails a repo on formatting it never signed up for.

## When `doctor` reports a missing tool

`doctor` prints a row per slot. A slot whose tool is not installed shows `not
installed` with a hint. Two cases:

### The tool should already be there

You have the config file (so the slot is active) but the package is gone — for
example after a fresh clone or a pruned `node_modules`. Restore everything from
the lockfile:

```bash
pnpm install
```

### Adding a tool that is not in the project yet

Say you want the `dead` (fallow) or `struct` (ast-grep) slot but the repo never
had it. Scaffold the config, then install the package:

```bash
pnpm exec checkride init --add dead,struct   # writes fallow.toml, sgconfig.yml, rules/
pnpm add -D fallow @ast-grep/cli              # installs the tools
pnpm check                                    # the slots now run
```

`init --add` writes only the config files; it does not touch
`devDependencies` — that is the `pnpm add -D` step. Once both the config and the
package exist, the slot is detected automatically on the next run.

## ast-grep, specifically

ast-grep is also distributed as a standalone binary (for example via Homebrew or
cargo). checkride invokes it through `pnpm exec ast-grep`, so for this project
prefer the npm package:

```bash
pnpm add -D @ast-grep/cli
```

That keeps the version pinned in your lockfile and resolvable at
`node_modules/.bin/ast-grep`, which is exactly what `doctor` probes for.

## Turning a slot off

If a slot is irrelevant to a repo, disable it in `checkride.config.json` rather
than leaving its tool half-installed:

```jsonc
{
  "checks": {
    "spell": false
  }
}
```

`doctor` then reports that slot as `disabled in config` instead of a failure.

See the [cheat sheet](./cheatsheet.md) for the full command and flag reference,
and the [README](../README.md) for the slot/adapter model in depth.
