# checkride docs

Every page here, listed by the job you came to do. The [README](../README.md)
is the two-minute version: the pitch, the install, and what a run prints.

## Start

- **[Getting started](./getting-started.md)**: the ten minutes after the
  README. Install, what `init` wrote, the first run, reading a red one, and
  the daily loop.
- **[Installing checkride](./distribution.md)**: the channels, npm, the mise
  route and the standalone binary; a new project from an empty directory; and
  uninstalling.
- **[Working with agents](./agents.md)**: the AGENTS.md stanza, the three
  hooks, the opt-in stop gate, what it costs and how to narrow it.
- **[Why checkride](./why.md)**: the case for adopting it, the return against
  ad-hoc scripts or a task runner, and answers to the common objections.
- **[A polyglot repo, end to end](./polyglot.md)**: a TypeScript app, a Go
  API, OpenTofu and shell scripts in one repo, from install to CI, with the
  real output at each step.
- **[Deep modules](./deep-modules.md)**: the module-boundary convention `init`
  scaffolds, the rules that hold it, and how to swap it.

## Adopt on a team

- **[checkride on a team](./team.md)**: a repo several teams merge
  agent-written code into. One required check, the baseline guard, code owners
  for the record, and what a green gate leaves a reviewer.
- **[The baseline](./baseline.md)**: grandfathering a repo's findings so day
  one is green, the ratchet that shrinks them, reviewing what a change adds,
  and recovering after a bad merge.
- **[Targets](./targets.md)**: more than one language, or one language in more
  than one place, as named targets, and local targets whose config and
  baseline sit with their team's code.
- **[Running a fleet with shared presets](./presets.md)**: one versioned
  preset across many repos, rolling a rule out as a release.
- **[The Claude Code plugin](./plugin.md)**: the `/checkride:check` and
  `/checkride:qa` skills, what each reads and what it leaves alone.
- **[Cursor](./cursor.md)**: what `agent-setup` writes for Cursor, and where
  Cursor's hooks differ from Claude Code's.

## Run in CI

- **[Running in CI](./ci.md)**: a GitHub Actions recipe for each package
  manager and for a repo without Node, `--strict`, annotations, the step
  summary, and the baseline guard.
- **[Running checkride from outside a repo](./consumers.md)**: for a reviewer,
  CI job or agent checking a checkout it didn't write: `--defaults`, `--pins`,
  `--discover`, `--static-only` and `--out`.
- **[Ordering waves in practice](./ordering-in-practice.md)**: what the
  `order` surface buys on a real repo, and a method for tiering your own gate.

## Reference

- **[Cheat sheet](./cheatsheet.md)**: every command, flag and npm-script alias,
  and the `.check/` output files.
- **[Configuration](./configuration.md)**: every key `checkride.config.json`
  takes, from a tool pick per slot to custom checks, presets and timeouts.
- **[Tools and installation](./tools.md)**: the slots and their adapters, what
  the ts and repo packs run, and installing a tool `doctor` reports missing.
- **[Packs and pins](./packs.md)**: each language pack's slots and tools, the
  pin chain that picks the copy that runs, and the spawn environment.
- **[Suites](./suites.md)**: a second suite of checks beside the code gate,
  with its own config, baseline and output directory.
- **[The contract](./contract.md)**: the surfaces consumers may rely on: exit
  codes, `.check/` and `summary.json`, the baseline format, flags, the
  programmatic exports, and the pin policy.
- **[Reliability](./reliability.md)**: why checkride is safe to build a gate
  on, the failure modes it closes by default, and the tested envelope.

Design records, kept for the reasoning behind what shipped:

- [The v1 spec](./spec-v1.md): the guard, local targets, the docs and the
  soak toward 1.0.
- [The polyglot spec](./spec-polyglot.md): targets and language packs.
- [Agent-setup upgrade](./spec-agent-setup-upgrade.md): the 0.9.0 fixes a
  consumer's adoption turned up, the CI concurrency default among them.
- [Slot provenance](./spec-slot-provenance.md): the tag that says why each
  check ran.
- [Test layout](./spec-test-layout.md): the test layout `init` scaffolds, and
  the rules that hold it.

## The one rule

`pnpm check` (or `mise exec -- checkride`, in a repo without Node) is the
single source of truth for "done". Exit `0` means the work is complete; any
other exit code means it isn't. Everything else in these docs is detail
around that one rule.
