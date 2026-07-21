# checkride docs

Onboarding and reference material for people running checkride day to day —
whether this is your first time or you just need a refresher.

Start here:

- **[Why checkride](./why.md)** — the case for adopting it: what it's selling,
  the ROI versus ad-hoc scripts or a task runner, and straight answers to the
  common objections. Read this if you're deciding, or persuading.
- **[Getting started](./getting-started.md)** — prerequisites, adding checkride
  to a project (new or existing), your first run, and the daily loop. Read this
  if you are new or coming back after a break.
- **[Cheat sheet](./cheatsheet.md)** — one-screen reference for commands, flags,
  npm-script aliases, and the `.check/` output files.
- **[Tools and installation](./tools.md)** — what each pipeline slot runs, and
  how to install a missing tool (fallow, ast-grep, oxlint, …) when `doctor`
  reports one as not installed.
- **[Running in CI](./ci.md)** — a copy-paste GitHub Actions recipe (and
  npm/yarn/bun variants), why gates should pass `--strict`, and the baseline
  note for legacy repos.
- **[Running a fleet with shared presets](./presets.md)** — operating checkride
  across many repos: one versioned preset package, rolling a rule out as a
  release instead of a wave of pull requests, and keeping the shared config safe
  where tools differ. Read this if you own code quality for an org, not one repo.
- **[Ordering waves in practice](./ordering-in-practice.md)** — a worked
  before/after on a real repo showing what the `order` surface buys: a legible
  schedule, an uncontended heavy check, and a method for tiering your own gate.
- **[The contract](./contract.md)** — the surfaces consumers may rely on: the
  exit-code taxonomy, the `summary.json` schema discipline, the CLI flag set,
  the programmatic exports, and the pin policy.
- **[Reliability](./reliability.md)** — why checkride is safe to build a gate
  on: the frozen contract, the vacuous-green signal, the failure modes it
  closes by default, and the tested envelope. The reasoning behind the
  contract above.

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
