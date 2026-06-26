# checkride docs

Onboarding and reference material for people running checkride day to day —
whether this is your first time or you just need a refresher.

Start here:

- **[Getting started](./getting-started.md)** — prerequisites, adding checkride
  to a project (new or existing), your first run, and the daily loop. Read this
  if you are new or coming back after a break.
- **[Cheat sheet](./cheatsheet.md)** — one-screen reference for commands, flags,
  npm-script aliases, and the `.check/` output files.
- **[Tools and installation](./tools.md)** — what each pipeline slot runs, and
  how to install a missing tool (fallow, ast-grep, oxlint, …) when `doctor`
  reports one as not installed.

Deeper background lives in the repository root:

- **[README](../README.md)** — the thesis, the slot/adapter model, and the
  `.check/` contract.
- **[AGENTS.md](../AGENTS.md)** — the contract coding agents follow in a
  checkride repository.
- **[CHANGELOG](../CHANGELOG.md)** — release notes.

## The one rule

`pnpm check` is the single source of truth for "done". Exit `0` means the work
is complete; any other exit code means it is not. Everything else in these docs
is detail around that one rule.
