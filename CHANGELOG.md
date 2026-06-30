# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-06-30

### Added

- Custom checks (config entries keyed by a name outside the built-in slot
  catalogue) accept an `order` field: `"order": "first"` runs the check ahead
  of every built-in, `"last"` (the default) keeps it after them. Lets a
  formatter such as `biome format --write` normalize the tree before the
  linters and tests run. Within each group, config key order is preserved.

## [0.1.5] - 2026-06-30

### Added

- `checkride --help` / `-h` and `checkride --version` / `-V`.
- Optional per-check timeout, off by default: set a global `timeout` (seconds)
  in `checkride.config.json` or override it per check; `0` exempts a slot. A hung
  check is killed and reported as failed with its elapsed duration.

### Changed

- Supported Node floor lowered to 22.18 (the minimum required by the cspell and
  oxlint toolchain). `init` and `doctor` reflect it, and CI now runs a Node
  22 + 24 matrix.
- Unknown commands and bad flags print a concise message plus a `checkride
  --help` pointer; a malformed `checkride.config.json` now reports `invalid
  checkride.config.json: <reason>` instead of a raw parser error.
- `prepublishOnly` runs the test suite before publishing, not just the build.

### Internal

- `package.json` gains `repository`, `homepage`, and `bugs` for the npm page.
- README and cheat sheet document the stderr/stdout stream split; README gains a
  header image.

## [0.1.4] - 2026-06-26

### Added

- Onboarding and reference documentation under `docs/`: a getting-started guide,
  a command and flag cheat sheet, and a tool-installation reference (system
  prerequisites plus how to install a missing slot tool such as fallow or
  ast-grep). Includes a "Working with agents" section covering how Claude Code
  and other agents adopt the `pnpm check` contract via the AGENTS.md stanza, and
  how to enforce it with a Stop hook without double-running the pipeline.

### Internal

- Removed the v1 build plan now that it is fully implemented.

## [0.1.3] - 2026-06-17

### Changed

- `checkride doctor` now reports every catalogue slot with its enablement —
  `default`, `opt-in`, `disabled`, or `unavailable` — instead of listing only
  the slots the default run executes. Opt-in slots (mutation, security),
  config-disabled slots, and slots with no detected tool are no longer silently
  omitted; each shows how to enable it. Exit-code behavior is unchanged: only
  default slots are required, so the newly surfaced slots never fail the report.

## [0.1.2] - 2026-06-12

### Fixed

- The CLI now runs when invoked through its installed bin — `pnpm exec
  checkride`, `npx checkride`, and the generated `pnpm check` alias. The 0.1.1
  entrypoint guard compared unresolved paths, so launching via the
  `node_modules/.bin/checkride` symlink (how every consumer runs it) silently
  exited 0 without running any checks.

### Internal

- Added an end-to-end regression test that invokes the CLI through a bin
  symlink and asserts it behaves identically to a direct invocation.
- Bumped the CI GitHub Actions to their node24-runtime majors
  (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`), clearing the
  Node 20 deprecation warning.

## [0.1.1] - 2026-06-12

### Added

- `checkride init` for existing projects gained `--add <slots>`: it scaffolds
  blessed-default configs for the named empty slots (lint, spell, struct, test,
  docs, types, dead) and adopts them in the same run, never clobbering an
  existing config.
- `checkride init` for existing projects now writes the `check: checkride` alias
  to `package.json` when it is missing — additive, and never overwriting an
  existing `check` script.

### Internal

- Flattened checkride's own source to named single-file modules with a
  logic-free barrel `index.ts`, relocated unit tests to `src/__tests__/`, and
  added a `no-logic-in-barrel` structural rule. The deep-modules folder pattern
  still ships to consumers unchanged.
- Added Stryker mutation testing, strengthened weak tests, and gitignored the
  regenerated `stryker.incremental.json` cache.
- Added a GitHub Actions workflow running `pnpm check` plus the e2e suite.
- Added a `/version` release skill for cutting tagged releases.
- Reconciled the module-boundary documentation with the flat source layout.

## [0.1.0] - 2026-06-11

The first real release. (`0.0.0` was a name-claim placeholder.)

### Added

- `checkride` run command: the verification pipeline across ten slots (types,
  lint, struct, dead, test, docs, links, spell, plus opt-in mutation and
  security), writing raw per-tool output and an aggregate `.check/summary.json`
  (`schema_version: 1`).
- Adapter registry with blessed defaults (`tsc`, `oxlint`, `ast-grep`,
  `fallow`, `vitest`, `markdownlint-cli2`, built-in links, `cspell`, `stryker`,
  `pnpm audit`) and wired alternates (`biome`, `eslint`, `knip`, `jest`).
- Zero-config detection plus `checkride.config.json` for overrides, disabled
  slots, adapter swaps, and custom checks.
- `checkride init` for new projects (flat / monorepo / hybrid shapes, each green
  out of the box) and existing projects (additive adoption, idempotent AGENTS.md
  stanza, failing slots disabled with a report).
- `checkride doctor` (read-only environment + tooling verification) and
  `checkride fix` (runs every active adapter's fix command).
- Flags: `--only`, `--skip`, `--bail`, `--json`, `--changed`, `--all`,
  `--include`.

[0.1.6]: https://www.npmjs.com/package/checkride/v/0.1.6
[0.1.5]: https://www.npmjs.com/package/checkride/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/checkride/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/checkride/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/checkride/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/checkride/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/checkride/v/0.1.0
