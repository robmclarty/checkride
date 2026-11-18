![A robot pilot labeled AGENT approaches a runway signed DONE. Eight approach lights, one per check (types, lint, struct, dead, test, docs, links, spell) and all run by pnpm check, are green, so the checkride control tower signals exit 0, cleared to land. A dashed loop marks the earlier approach, where a failed test meant exit 1 and a go-around.](./hero.png)

# checkride

**One command that tells a coding agent — and you — when the work is actually
done.**

checkride is an npm package that runs your whole verification pipeline as a
single command (`pnpm check`) whose exit code is the verdict, and mechanically
enforces module boundaries so parallel changes stay out of each other's way.
Together those give an LLM agent the two things it otherwise lacks: a
definition of done, and lanes to stay inside.

It checks TypeScript, Go, Rust, Python, Terraform, Odin and shell code through
[language packs](./docs/packs.md), each running its own tools from the copy
the repo pins, and a mixed-language monorepo's parts as named
[targets](./docs/targets.md), each from its own root. A repo with no Node
installs and pins checkride through [mise](./docs/distribution.md), or runs
the [standalone binary](./docs/distribution.md#the-standalone-binary) once a
release carries one; built-in
checks stand down when their tool isn't in the repo, and custom checks run
any other command. [A worked example](./docs/polyglot.md) takes a repo with a
TypeScript app, a Go API, OpenTofu and shell scripts from install to a green
gate.

## The thesis

Agents are good at writing code and bad at knowing when to stop. Checkride fixes
both halves of that problem.

1. **A definition of done.** One command runs the whole verification pipeline —
   types, lint, structure, dead code, tests, docs, links, spelling. **Exit 0
   means the work is complete.** Agents stop guessing; humans stop re-reviewing
   half-finished work.
2. **Structured boundaries.** Code is organized into modules with narrow
   public surfaces. In the default layout, a module starts as a single file;
   when it grows internals worth hiding, it becomes a folder whose only public
   surface is its `index.ts`, and sibling modules import that index — never the
   internals. (These are [**deep modules**](./docs/deep-modules.md) —
   Ousterhout's term, from *A Philosophy of Software Design*, for a small
   interface hiding a substantial implementation.) checkride enforces this
   mechanically, which keeps each
   change inside one module's boundary and lets humans and agents work in
   parallel with minimal merge conflicts. Deep modules are checkride's default
   convention, not a hardcoded one — the rules are swappable ast-grep files in
   your repo, and the same slot enforces boundaries in other conventions and
   languages (see [Conventions](#conventions)).

One design choice to know up front: because the consumer of the output is an
LLM, checkride never normalizes diagnostics into a common format to reach a
verdict. Each tool writes its own raw output to `.check/`, which stays
authoritative, and the agent reads whatever the tool emits; a reader that
wants findings by file and line can parse them with `checkride/findings`.
Skipping normalization deletes the adapter-maintenance layer that makes
traditional run-all-my-tools wrappers expensive to extend.

## Install

For an **existing repository**, install checkride (exact-pinned — see the
[pin policy](./docs/contract.md#versioning-and-pin-policy)) and let `init`
adopt the tools you already have:

```bash
pnpm add -D -E checkride
pnpm exec checkride init
```

The same two steps under another package manager — `init` detects it and
spells the alias and stanza (and the stop gate, if you opt in) for it (see
[Package managers](./docs/tools.md#package-managers)):

```bash
npm install -D -E checkride && npx checkride init
yarn add -D -E checkride && yarn checkride init
bun add -d -E checkride && bunx checkride init
```

For a **new project**, run `init` in an empty directory — no install first;
`dlx` fetches checkride, and the generated `package.json` pins it:

```bash
pnpm dlx checkride init --shape flat --name my-app
pnpm install
pnpm check
```

The generated project is a pnpm project: its `engines` field and
`pnpm-workspace.yaml` assume it, and the monorepo and hybrid shapes are pnpm
workspaces. To start under npm, yarn, or bun, create the `package.json` first
(`npm init -y`, or your manager's equivalent), then take the
existing-repository path above — `init --add <slots>` scaffolds the tool
configs a bare repository lacks (`init --add struct,dead`, for example).

For a **repo without Node**, such as a Go or Rust project with no
`package.json`, mise installs checkride's standalone binary and runs it as
`mise exec -- checkride`. `init --lang go|rust` writes that `mise.toml` for a
new project. A Go, Rust, Python, Terraform or Odin repo that already exists adds the
pin with `mise use`, then runs `mise exec -- checkride init`, which adopts the
tools its root configures through that language's pack.
[Installing checkride](./docs/distribution.md) shows the pin, and the
`npm:checkride` one for a repo that would rather run the npm package.

A **standalone binary** takes Node out of that picture: one executable with
the CLI and its templates embedded, for macOS and Linux on arm64 and x64. It
ships with every release from 0.21.0, attached to its GitHub release, and is
what that `mise.toml` pins.
[Installing checkride](./docs/distribution.md#the-standalone-binary) covers
what it carries and leaves out, and how to verify a download.

Every path ends in the same place — `init` auto-detects which case it is in.
Where the repo has a `package.json`, it writes a `"check": "checkride"` script
alias, so daily usage is `pnpm check` (`npm run check`, `yarn run check`, or
`bun run check` under the others) regardless of the tool's name. It also
writes the agent contract: an AGENTS.md
stanza stating the "exit 0 = done" rule, an `@AGENTS.md` import in CLAUDE.md
(Claude Code reads a CLAUDE.md in AGENTS.md's place, so the import is what
loads the stanza; an existing CLAUDE.md gains that one line and nothing else),
and **hooks** in your agent harness's
config — `.claude/settings.json` for Claude Code, `.cursor/hooks.json` for
Cursor. Three of them: a guard that denies edits to `checkride.baseline.json`
and `.check/**`, written by default, and two that are **opt-in**: a stop gate
(a checkride-owned script that runs your detected package manager's
`run check --strict --digest` and blocks an agent from finishing while the
pipeline is red) and an edit marker so turns that touched no files skip the
gate. The stanza already tells the agent the contract, and that is usually
enough. Ask for the gate with `checkride hooks add` (every hook) or
`--hook gate,dirty,protect`. Once a repo has it, a re-run keeps it refreshed. In a repo with no
`package.json`, the gate, the stanza and the skills run `mise exec -- checkride`
where a root `mise.toml` pins checkride, and the `checkride` on `PATH`
otherwise, which `doctor` reports as the harness unpinned. Select hooks with
`--hook <a,b>` (gate | dirty | protect), harnesses with `--harness <a,b>`
(claude | cursor; detected by default), skip the hooks with `--no-hook`, or
take an installed one back out with `--remove-hook <a,b>`. To add all of this — alias, stanza,
CLAUDE.md import, hooks, and the Cursor skills — to a repo you already set up, run
`checkride agent-setup`.

Re-running either command refreshes the stanza in place, but never behind your
back: the marker carries a hash of what checkride wrote, so a stanza you have
since edited stops the run (exit 2) instead of being overwritten. Keep
repo-specific additions outside the markers, where nothing rewrites them — or
pass `--force` to discard the edits and refresh. A stanza written before the hash
existed is matched against the wordings checkride released, so upgrading is not
itself mistaken for an edit.

To add or remove a hook on its own, use `checkride hooks add [a,b]` /
`checkride hooks remove <a,b>` (a bare `hooks add` installs all three, the stop
gate included). It writes only the harness config and the
generated scripts, and never reads or writes AGENTS.md — managing a hook is not
managing your contract file, and an edited stanza does not stand in its way.

## Docs

Task-focused guides live in [docs/](./docs/README.md):

- [Why checkride](./docs/why.md) — the case for adopting it: what it's
  selling, the ROI versus ad-hoc scripts or a task runner, and answers to the
  common objections.
- [Getting started](./docs/getting-started.md) — prerequisites, adding
  checkride to a project (new or existing), your first run, and the daily loop.
- [Installing checkride](./docs/distribution.md) — the channels (npm, the mise
  route and the standalone binary), and how a repo without Node pins checkride.
- [Cheat sheet](./docs/cheatsheet.md) — one-screen reference for commands,
  flags, npm-script aliases, and the `.check/` output files.
- [Configuration](./docs/configuration.md) — every key `checkride.config.json`
  takes: tool picks, targets, data-file schemas, custom checks, presets and
  timeouts.
- [The baseline](./docs/baseline.md) — grandfathering today's findings, the
  ratchet that shrinks them, reviewing what a change adds, and recovering
  after a bad merge.
- [Tools and installation](./docs/tools.md) — what each check of the ts and
  repo packs runs, and how to install a missing tool when `doctor` reports one.
- [Targets](./docs/targets.md) — checking a repo with more than one language,
  or one language in more than one place, as named targets.
- [Suites](./docs/suites.md) — more than one suite of checks in a repo, each
  with its own config, baseline and output directory, run with `--suite`.
- [Packs and pins](./docs/packs.md) — each language pack's slots and tools,
  where each tool is pinned, and the environment its checks run with.
- [A polyglot repo, end to end](./docs/polyglot.md) — a worked example: one
  repo with a TypeScript app, a Go API, OpenTofu and shell scripts, from
  install through targets, pins, the daily loop and CI.
- [Running in CI](./docs/ci.md) — a copy-paste GitHub Actions recipe (with
  npm/yarn/bun variants, and a mise one for a repo without Node), and why
  gates should pass `--strict`.
- [Running checkride from outside a repo](./docs/consumers.md) — what a
  reviewer, a CI job or an agent passes to check a checkout it didn't write:
  `--discover`, `--defaults`, `--pins`, `--static-only` and `--out`.
- [Shared presets](./docs/presets.md) — one versioned config for a fleet of
  repos, through `extends`.
- [Deep modules](./docs/deep-modules.md) — the default convention `init`
  scaffolds, the `struct` and `dead` rules that hold it, and how to swap it.
- [Ordering in practice](./docs/ordering-in-practice.md) — what `order` and
  waves buy on a real repository, measured.
- [The contract](./docs/contract.md) — the surfaces consumers may rely on:
  exit codes, the `summary.json` schema discipline, the baseline file format,
  flags, exports, and the pin policy.
- [The Claude Code plugin](./docs/plugin.md) — the bundled `/checkride:check`
  and `/checkride:qa` skills: install, what each one reads, and what they
  deliberately do not do.
- [Cursor](./docs/cursor.md) — what `agent-setup` writes for Cursor, where
  Cursor's hook API differs from Claude Code's, and the assumptions not yet
  verified against a live Cursor.
- [Reliability](./docs/reliability.md) — why checkride is safe to build a
  gate on.

Runnable counterparts live in [examples/](./examples/): standalone projects you
can install and run on their own, each demonstrating one thing — what an agent
reads when the gate is red, how a repo with existing debt adopts checkride
without a cleanup project first, or how a pack checks a Go, Rust, Python,
Terraform or mixed-language repo. Each one declares the run it expects, and
the end-to-end suite asserts it on every push.

The [reference](#reference) below points at the page for each command, slot,
file and config key.

## Reference

The reference lives under [docs/](./docs/README.md), one page per topic:

- **Commands and flags** — every command, every flag and the npm-script
  aliases, on [the cheat sheet](./docs/cheatsheet.md).
- **Slots, adapters and packs** — what each slot checks, its blessed tool and
  alternates, which slots are opt-in, and each language pack's tools, in
  [Tools § Slots and adapters](./docs/tools.md#slots-and-adapters).
- **The `.check/` directory** — what a run writes and how to read a red one,
  in [the contract](./docs/contract.md#the-check-directory).
- **Configuration** — `checkride.config.json`, from a single tool pick to
  targets, custom checks, presets and timeouts, in
  [Configuration](./docs/configuration.md).
- **The baseline** — grandfathering a repo's existing findings so day one is
  green and a new finding still fails, in [The baseline](./docs/baseline.md).

During iteration, narrow the loop: `checkride --bail`, `checkride --only
types,lint`, `checkride --changed`. Progress goes to stderr, and stdout
carries only machine output, the summary JSON under `--json`, so it is safe
to pipe.

## The Claude Code plugin

The package root is also a [Claude Code](https://claude.com/claude-code) plugin
— two skills that consume the contract above, bundled in the same npm package
and versioned with it. This repo is its own marketplace, so the install needs
nothing else:

```text
/plugin marketplace add robmclarty/checkride
/plugin install checkride@checkride
```

- **`/checkride:check`** — triage a red gate. It runs the repo's own `check`
  script (or `mise exec -- checkride` in a repo with no `package.json`),
  branches on the promised 0/1/2 exit split, and names **one root cause**
  plus what it is deliberately not reading. It covers the corners a summary read
  by hand gets wrong — exit 2 versus exit 1, vacuous green, a narrow run's green,
  `baselined` counts, `skipped` slots, `exit_code: -1`, stale artifacts — then
  opens exactly one raw file.
- **`/checkride:qa`** — read the quality signal. It folds `mutation.json`,
  `dead.json`, `dupes.json` and `health.json` into a report under 8 kB, runs
  nothing, and reports which dimensions were never measured rather than guessing
  at them.

Both are **readers**: no new flag, no config, no hook. They exist because
reading `.check/` by hand is unbounded (`mutation.json` is over 12 MB in this
repo) and credulous (every run overwrites `summary.json`, so an `ok: true` on
disk may describe three of twenty-one slots from a while ago). The readers ship
prebuilt in `dist/`, so installing the plugin needs no build step, and they run
without it too: `checkride triage` and `checkride qa` print the same reports.
Full details in [docs/plugin.md](./docs/plugin.md).

## Project shapes

`init` scaffolds three TypeScript shapes. They share everything except
`tsconfig.json`, `fallow.toml`, and `pnpm-workspace.yaml`:

- **flat** — a single package using the deep-modules layout under `src/`.
- **monorepo** — a pnpm workspace of `apps/*` (deployable leaves) and `libs/*`
  (reusable internals); libs may not import from apps.
- **hybrid** — a root app in `src/` plus internal packages under `packages/*`.

`init --lang go` scaffolds a Go `module` or `workspace`, and `init --lang rust`
a Rust `crate` or `workspace`, each with no `package.json`: a `mise.toml` pins
checkride and its tools, the config sets `requirePins`, and the pack's dialect
rules ship under `rules/`. See [getting started](./docs/getting-started.md).

Every generated shape is green out of the box — an end-to-end test enforces it.

At runtime, a repo without `targets` is one project: checkride runs each tool
**once, from the repo root** — one pipeline, one `.check/` — and workspace
awareness comes from the tools' own configs, which is what the monorepo
scaffold sets up: `tsc --build` follows the root tsconfig's project
references, and vitest, oxlint, ast-grep, and the rest walk the whole tree. To
check each part from its own root instead, declare
[targets](./docs/targets.md): each runs its pack's checks from its root, as
`web:lint` or `api:test`, writing under `.check/<target>/`. `--only web` runs
one target, and `--changed` skips the ones a change didn't touch.

## Conventions

`init` scaffolds one **default** convention — [deep
modules](./docs/deep-modules.md), whose boundaries are enforced by `ast-grep`
(the `struct` slot) and `fallow`:

- A module is a unit of encapsulation. A single file is a module; promote it to
  a folder with a barrel `index.ts` when it grows internals worth hiding — a
  one-file folder is just ceremony.
- A folder module's `index.ts` is its only public surface: it re-exports, it
  holds no logic. Siblings import it via `'../<sibling>/index.js'`, never its
  internals.
- Named exports only; no classes; `.js` extensions on relative imports
  (NodeNext); tests colocated with the code they cover.

None of this is hardcoded into checkride. The `struct` slot just runs whatever
ast-grep rules live in your repo's `rules/` directory (the barrel rule is
`rules/no-deep-sibling-import.yml`), so the convention is whatever those files
encode:

- **A different convention, same language.** Edit or replace the rules to match
  how your repo is organized — public/private folders, a naming prefix, an
  allowed-import list — and `struct` enforces the new shape unchanged.
- **Another language.** ast-grep is polyglot; set each rule's `language`
  (`typescript`, `python`, `go`, `rust`, …) and the same slot covers boundaries
  there. `init --lang go` and `init --lang rust` start you off with their
  packs' dialect rules under `rules/go/` and `rules/rust/` (no dot imports,
  import aliases or `init` outside `package main` in Go; no glob imports or
  glob re-exports in Rust), and
  [`examples/python-project`](./examples/python-project/) writes its rules
  for Python.
- **Beyond ast-grep.** When a rule can't be expressed in ast-grep, or lives in
  another ecosystem's tooling (`import-linter`, `depguard`, `dependency-cruiser`),
  wire it as a [custom check](./docs/tools.md#when-to-write-a-custom-check).

checkride ships an opinionated default; it does not lock you to it.

## Tested envelope

Every push runs the full suite — unit, contract, and end-to-end (generated
projects, installed and checked for real) — on **macOS and Linux**, at **Node
22.18.0 (the exact supported floor), Node 24 and Node 26**. The e2e suite
exercises the full package-manager quartet, **pnpm, npm, yarn, and bun**, and
every language pack against its real tools, which CI installs at pinned
versions through mise, so no pack's cases are skipped. Windows is not tested
and not claimed; it waits for a real consumer who needs it.

The promised surfaces (exit codes, `summary.json` shape, flags, exports) are
locked by a dedicated [contract suite](./test/contract/) — see
[docs/contract.md](./docs/contract.md). Beyond line coverage (enforced at 70%),
the test suite is itself tested: Stryker mutation testing runs with a hard
floor of 68, and the last full run scored **83%** (`pnpm mutation` reproduces
it, in about three hours).

See [AGENTS.md](./AGENTS.md) for the contract agents follow,
[CONTRIBUTING.md](./CONTRIBUTING.md) for the release ritual, and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

## Programmatic API

The CLI is the primary interface, but the run and `doctor` are also
functions. Import from the package root to run the pipeline inside your
own tooling; the result carries the same summary written to
`.check/summary.json`, plus the exit code the CLI would return:

<!-- snippet: check -->
```ts
import { runChecks, type RunResult } from 'checkride';

const result: RunResult = await runChecks({ cwd: process.cwd(), strict: true });
process.exitCode = result.exitCode;
```

`runChecks` sits beside `runDoctor`, with the types `RunOptions`,
`RunResult`, `Summary`, `SummaryCheck` and `DoctorCheck`; the rest, `init`,
`fix`, config loading and the registries among it, is the CLI's. A second
entry point, `checkride/findings`, parses a run's raw artifacts into
findings, with `parseFindings`, `findingsFor` and
`isParseable`. The full surface is the package's `exports`, and it is part of
the [contract](./docs/contract.md).

## License

[Apache-2.0](./LICENSE)
