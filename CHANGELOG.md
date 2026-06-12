# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://www.npmjs.com/package/checkride/v/0.1.0
