# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-07-19

### Contract

- **The `order` field is now a first-class, promised scheduling surface.** A
  config entry's `order` accepts a **number** — a wave, where distinct wave
  numbers run in ascending order with a barrier between them, checks sharing a
  number run concurrently, and decimals sequence steps within a wave (`1` before
  `1.1`) — or one of `first`, `last`, `middle`, `single`, `any`. It is honored
  on every object-form entry: a slot's `{ use, order }` and a custom check
  alike. `first`/`last` keep their exact historical meaning, pinned by a
  backward-compat contract test. See `docs/contract.md` §"Check ordering and
  concurrency".
- **Two deliberate default-placement changes**, both noted in `docs/contract.md`:
  a config-only custom check with **no** `order` now defaults to `any` (the main
  group) instead of the old implicit `last` — set `"order": "last"` to restore
  the previous placement — and a catalogue-filling custom entry's `order`, which
  earlier releases documented as ignored, is now **honored**. A sequential
  default run is unaffected in verdicts and summary order; the difference is
  visible only under concurrency or beside a numbered wave.
- **New `--concurrency <n>` flag.** Sets the size of the pool that runs a wave's
  checks concurrently (`1` = sequential; the default is a conservative cap
  derived from the CPU count). `--bail` overrides it: the run goes fully
  sequential and a one-line stderr note reports that `--concurrency` was ignored
  (the combination is safe, just slower — not a usage error). Additive to the
  flag contract and contract-tested.
- **`total_duration_ms` is now the run's wall-clock duration.** Under
  concurrency the summary's total is measured wall-to-wall rather than summed
  across checks; the two are identical for any sequential run (including
  `--bail`). The `checks` array stays in deterministic group order — the run's
  scheduling sequence, never completion order. `schema_version` is unchanged.

### Added

- **A publish-ready bundle of four opt-in slots** that take the definition of
  done past static publishing lint (`publint`, `attw`) and out to the shipped
  artifact. Each is a built-in or runs the consumer's own `build`/`tsc`, so
  enabling them adds **zero devDependencies**:
  - **`build`** (wave 10) runs the consumer's `build` script, so the artifact
    checks below inspect fresh output rather than a stale `dist/`. An opted-in
    `build` on a repo with no build script stands down as a skip, never a red
    check.
  - **`pack`** (wave 20) packs the tarball with a dry-run and fails if a required
    file (a resolved `exports`/`main`/`types`/`bin` target, or `README`) is
    missing or a forbidden one (`src/`, tests, `.ts` sources — the
    `dist/**/*.d.ts` declarations excepted) is shipped. npm/pnpm only; yarn/bun
    report **unavailable** until a per-manager adapter lands, like `security`.
  - **`smoke`** (wave 20) imports every `exports` entry of the built package
    through its own resolution map and asserts each declared value export is live
    at runtime — a liveness check, not a type check.
  - **`snippets`** (wave 20 / `any`) type-checks the fenced code blocks tagged
    `<!-- snippet: check -->` in `README.md` and `docs/*.md`. The default
    `snippets` adapter checks against source; a second `snippets-dist` adapter
    checks against the built `.d.ts`. A slot opted in with zero tagged fences is
    a hard error.

  All four are opt-in (`--all`, `--include`, or config), so a default run is
  byte-for-byte unchanged. They **order themselves**: `build` at wave 10 precedes
  `pack`/`smoke`/`snippets`/`publint`/`attw` at wave 20, so `checkride --all`
  builds before it inspects the artifact with no ordering config. `checkride
  init` on a library can scaffold the bundle.

### Changed

- **A dependency can now activate a slot, not just its config file.** Adapters
  whose tool runs correctly with zero config — `oxlint` (lint), `knip` (dead),
  `vitest` (test), `cspell` (spell), and `prettier` (the opt-in format slot) —
  now also activate when the package appears in `dependencies`/`devDependencies`,
  as a backup to the detect-file signal. A repo that installed one of these but
  never wrote its config file gains that check on upgrade; `doctor` names which
  signal matched. This widens the default run for those slots and is a
  deliberate, noted behavior change.
- **Checks now run concurrently within a wave by default.** The orchestrator
  schedules the wave sequence — `first`s, the numeric line ascending (equal
  values through a bounded pool, a barrier between distinct values), `single`s
  exclusively, then `last`s — instead of strictly one-at-a-time cheapest-first.
  `--bail` keeps the sequential fail-fast path. The catalogue ships ordered so
  existing default runs produce the same verdicts and the same summary order as
  before, only faster; `mutation` runs as a `single` (exclusive) because Stryker
  saturates every core and races the real test run's cache.
- **`mutation` now ships uncapped (`timeout: 0`) by default.** A real Stryker run
  legitimately outlives the 600s per-check cap; because `mutation` is opt-in and
  never part of the definition-of-done gate the cap protects, its adapter runs to
  completion instead of tripping a timeout under `checkride --all`. Every other
  slot keeps the safe-by-default cap; override per check or globally with
  `timeout`.

## [0.4.3] - 2026-07-18

### Internal

- Refactored for maintainability: decomposed high-complexity functions across
  the orchestrator, `init`, `doctor`, `config`, and the baseline code into small
  single-purpose helpers, extracted shared option/stanza helpers, and broke
  internal import cycles. No change to runtime behavior or the public API.
- Zeroed the project's grandfathered debt: cleared the `lint`, `dead`, `dupes`,
  and `health` baselines and removed checkride's own `checkride.baseline.json`,
  so the repo passes a full `pnpm check` with no suppressions.
- The repo's own default `pnpm check` now also runs the `dupes` and `health`
  slots. Mutation stays opt-in (`pnpm mutation`): a cold full pass has no warm
  incremental cache in CI and would time out the gate.

## [0.4.2] - 2026-07-18

### Fixed

- **The `dead` (fallow) slot now actually gates.** checkride ran fallow in JSON
  mode, which exits `0` even with findings, so the slot reported ✔ while fallow
  had real issues. checkride now reads fallow's JSON report and derives the
  verdict from the issue count instead of the (unreliable) exit code — so the
  slot fails `pnpm check` on new findings and passes only when clean or fully
  baselined. An **unrecognized fallow report fails loudly** (explicit
  "unsupported schema_version" / "unrecognized kind") rather than passing
  silently.
- **fallow ≥ 3.5 support.** The dead-code parser reads fallow's current
  `schema_version` 7 JSON (2.x emitted schema 4 with an incompatible layout).
  The pinned devDependency moves from `fallow@2.48.0` to `fallow@3.5.0`.

### Added

- **`checkride baseline` now grandfathers fallow findings.** A fingerprint
  extractor keys each fallow finding by kind + file + symbol, so fallow slots
  participate in `checkride.baseline.json` like `lint`/`struct`/`spell` (and
  ratchet the same way). Repos that prefer fallow's native `--save-baseline`
  suppression can still use it — see `docs/tools.md`.
- **New opt-in `dupes` and `health` slots.** fallow's duplication and
  complexity analyses are now first-class checks (`--include dupes,health` or
  `"dupes": "fallow"` in config), each with gating and baselines. They stay
  opt-in so adopting checkride never fails a repo on duplication/complexity it
  never signed up for.

## [0.4.1] - 2026-07-11

### Internal

- Docs refresh: updated the reported mutation score to 69% and bumped the README `$schema` example to v0.4.0.

## [0.4.0] - 2026-07-11

### Contract

- **An unknown slot name is now a usage error.** An unrecognized slot in
  `--only`, `--skip`, or `--include` (e.g. `checkride --only lints`) exits **2**,
  naming the bad slot and the valid set (catalogue slots plus config
  custom-check names). It previously matched nothing and exited **0** — a typo
  could silently disable the gate, the worst vacuous green in a definition-of-done
  check. See `docs/contract.md` §CLI.

### Added

- New-project `checkride init` refuses to overwrite existing files, listing
  every collision, and writes nothing; `--force` overrides. Existing-project
  mode (additive-only) is unchanged.
- Per-command `--help` (`checkride init --help`, etc.); new-project `init` ends
  by printing the next command to run; `checkride baseline` now rejects stray
  flags instead of ignoring them.

### Changed

- `checkride init` scaffolds an exact checkride version (no caret), and the
  README install uses `pnpm add -D -E checkride`, matching the pre-1.0
  exact-pin policy consumers are told to follow.
- Malformed consumer JSON (`.claude/settings.json`, a project `package.json`)
  now produces an error naming the offending file instead of a bare stack trace.

### Fixed

- **Interrupts no longer orphan checks.** Ctrl-C (SIGINT) or SIGTERM on a
  running `checkride` is forwarded to every in-flight check and group-kills its
  whole process tree before exit, then re-raises so the shell still sees the
  conventional signal exit (130/143). Since checks run in detached process
  groups (for the timeout kill), a plain interrupt previously left them running.
- `doctor` distinguishes a version probe that **timed out** from one that
  **could not be parsed** (30s probe), so a slow `pnpm --version` is no longer
  misdiagnosed.
- `checkride init --baseline --dry-run` no longer writes a real
  `checkride.baseline.json` — a dry run now truly writes nothing.
- A timed-out check's whole process group is killed (wrapper-spawned
  grandchildren included), and output is captured with a UTF-8 decoder so a
  multibyte character split across read chunks survives intact.
- `checkride fix` runs under the detected package manager (e.g. `npx` under
  npm), matching the run path instead of assuming pnpm.
- A slot's stale `.check/` artifacts are cleared before it re-runs, so a leaner
  or empty run can't leave the previous run's output behind as authoritative.

### Internal

- Docs pass: README restructure linking all six `docs/` files and splitting the
  existing-repo vs new-project install paths, getting-started/tools sync,
  reconciliation of the "locked by `test/contract/`" claim with real tests, and
  a batch of drift corrections.
- Release automation: tag↔version guard on release, CI concurrency group,
  security-only Dependabot; `publint` and `attw` added as dev checks and
  dogfooded; explicit test timeouts for slow-spawn machines; npm publishing
  switched to Trusted Publishing (OIDC).

## [0.3.0] - 2026-07-10

### Contract

- Three additions to the promised surfaces, each recorded in `docs/contract.md`
  and locked by `test/contract/`: the `summary.json` `checks_run` field, the
  `--strict` flag, and the `DEFAULT_TIMEOUT_SECONDS` export. (Heading added
  retroactively — the full entries are under **Added** below.)

### Added

- **Vacuous-green signal.** `summary.json` gains a top-level `checks_run` count
  of the checks that actually executed, so "green because everything passed" and
  "green because nothing ran" are distinguishable by every consumer: `ok: true`
  with `checks_run: 0` means nothing was verified. A zero-check run now prints a
  loud warning naming why each slot sat out and how to enable it, and the new
  `--strict` flag turns that case into exit 2 (for CI and commit-hook gates; the
  default stays a warned exit 0 so exploring a fresh repo isn't punished).
  `checks_run` is additive — `schema_version` is unchanged.
- **A frozen, tested contract.** `docs/contract.md` declares the surfaces
  consumers may rely on — the exit-code taxonomy, the `summary.json`
  additive-only discipline, the CLI flags, the programmatic exports, and the
  pre-1.0 exact-pin policy — each locked by a new `test/contract/` suite that
  fails the build on drift. The summary shape ships as a published JSON Schema
  (`schema/checkride.summary.schema.json`).
- `DEFAULT_TIMEOUT_SECONDS` is now part of the public programmatic surface.
- New docs: a copy-paste CI guide (`docs/ci.md`), a reliability article
  (`docs/reliability.md`), and `CONTRIBUTING.md` with the release ritual and
  succession path.

### Changed

- **Per-check timeouts are on by default** (600s; override per check or globally,
  `0` to disable). A check that exceeds it is killed (SIGTERM → grace → SIGKILL)
  and recorded as failed with a "timed out" note — a hung tool can no longer
  hang the definition of done. Give long-running slots (`test`, `mutation`, …) a
  higher cap or `0` on large repos.
- Run artifacts (`summary.json`, the raw slot files, the digest, the baseline)
  are written atomically (temp file then rename), so a run interrupted mid-write
  never leaves a consumer a half-written file to parse.

### Fixed

- The supported Node floor is now stated consistently as `>=22.18` across the
  docs; `docs/tools.md` and `docs/getting-started.md` previously claimed `>=24`,
  contradicting `package.json` engines.

### Internal

- CI runs the full suite across macOS and Linux at the Node floor (22.18.0) and
  current (24), and the e2e suite exercises all four package managers
  (pnpm/npm/yarn/bun) plus an interrupted-run case. Releases now publish with npm
  provenance, and the README wears the Stryker mutation score.

## [0.2.1] - 2026-07-08

### Fixed

- Every `checkride init` scaffold shipped a `spell` check that failed out of the
  box: the generated AGENTS.md contract stanza uses the word "baselined", but the
  scaffolded `cspell.json` dictionary didn't include it, so a freshly generated
  project's first `checkride` run exited non-zero.

### Internal

- Added a fast local guard (`generated-spell.test.ts`) that runs cspell against an
  in-process `init` scaffold for each shape, catching this class of drift in
  `pnpm check` instead of only in the slower end-to-end suite.

## [0.2.0] - 2026-07-08

### Added

- **Baseline** — adopt checkride on an existing repo without turning it into a
  cleanup project. `checkride baseline` records current diagnostics into a
  committed `checkride.baseline.json`; a normal run then passes a slot as long as
  only baselined findings remain, fails listing only genuinely new ones, and
  *ratchets* the file smaller as findings are fixed — never larger, and never
  pruned on a partial `--only`/`--skip`/`--changed` run. `checkride init
  --baseline` grandfathers today's debt instead of disabling failing slots.
  Grandfathered counts surface in `.check/summary.json` as an additive
  `baselined` field.
- **Package-manager-agnostic runs** — checkride detects pnpm, npm, yarn, or bun
  (from the lockfile or the `packageManager` field) and translates each tool
  invocation accordingly; the default pnpm behavior is byte-identical to before.
  `doctor` reports the detected manager. The `security` audit stays pnpm-only
  until per-manager adapters land.
- **`checkride agent-setup`** plus an `init` Stop hook — both write an idempotent
  Claude Code Stop hook to `.claude/settings.json` that runs the gate on the
  *detected* package manager and blocks a stop while checks are red. `agent-setup`
  also (re)writes the AGENTS.md contract stanza for a repo set up without a full
  `init`. Both are opt-out with `--no-hook`.
- **`format` slot** (opt-in) — a blessed `prettier` adapter (with `biome` as an
  alternate) that runs before `lint` and is wired into `checkride fix`. Excluded
  from the default run so upgrading never turns a repo red; `init` can enable it
  for greenfield projects. The `order: "first"` custom-check hatch still works for
  bespoke formatters.
- **`publint` and `attw` slots** (opt-in) — library-publishing checks that make
  "the published package is correct" part of the definition of done: `publint`
  lints the `package.json` publishing surface, `attw` verifies types resolve
  across module systems. Detect-gated so apps that never publish don't run them.
- **Config presets via `extends`** — `checkride.config.json` accepts `"extends":
  "<package-or-path>"` (string or array) to inherit a shared base; local keys win,
  and a missing or circular extend fails with a friendly message.
- **`--digest`** — writes a token-bounded Markdown excerpt of the failing slots to
  `.check/digest.md`, each section pointing at the authoritative raw output, so
  agents spend less context triaging failures on large repos. Absent on a green
  run.
- **Custom-check `detect` field** — a custom check can declare `detect:
  ["<file>"]` so a shared preset skips it when the file is absent and activates it
  when present, keeping one config safe across heterogeneous repos.
- **Published JSON Schema** — `schema/checkride.config.schema.json` describes the
  full config surface and ships in the package; `init` writes a version-pinned
  `$schema` pointer into generated configs for editor validation.

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

[0.5.0]: https://www.npmjs.com/package/checkride/v/0.5.0
[0.4.3]: https://www.npmjs.com/package/checkride/v/0.4.3
[0.4.2]: https://www.npmjs.com/package/checkride/v/0.4.2
[0.4.1]: https://www.npmjs.com/package/checkride/v/0.4.1
[0.4.0]: https://www.npmjs.com/package/checkride/v/0.4.0
[0.3.0]: https://www.npmjs.com/package/checkride/v/0.3.0
[0.2.1]: https://www.npmjs.com/package/checkride/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/checkride/v/0.2.0
[0.1.6]: https://www.npmjs.com/package/checkride/v/0.1.6
[0.1.5]: https://www.npmjs.com/package/checkride/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/checkride/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/checkride/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/checkride/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/checkride/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/checkride/v/0.1.0
