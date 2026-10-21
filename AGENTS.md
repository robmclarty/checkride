# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, Cursor, Windsurf, Amp) operating in this repository.

This repository is `checkride` itself — the agent harness. It dogfoods every convention it enforces.

## The contract

**`pnpm check` is the single source of truth for "done".** If it exits 0, the work is complete. If it exits non-zero, it is not.

Before declaring a task finished:

1. Run `pnpm check`.
2. If it fails, read `.check/summary.json` to find which check failed.
3. Read the corresponding per-tool JSON (`.check/lint.json`, `.check/dead.json`, and so on) for structured diagnostics.
4. Fix the root cause, not the symptom.
5. Re-run `pnpm check`.

Never claim a task is done while `pnpm check` is red.

## Tight feedback loops

During iteration, use narrower commands:

```bash
pnpm check --bail              # stop at first failure
pnpm check --only types,lint   # just the fast checks
pnpm check --changed           # affected mode (tsc is incremental; vitest --changed origin/main)
pnpm test:watch                # watch-mode tests
pnpm exec tsc --build          # incremental type-check / build
```

Full `pnpm check` is for the final verification.

## Conventions

- **TypeScript strict.** No `any`, no `!` non-null assertions without justification.
- **No classes.** Enforced by `rules/no-class.yml`.
- **Named exports only.** Enforced by `rules/no-default-export.yml`.
- **File extensions:** import with `.js` from `.ts` files (NodeNext resolution). Enforced by `rules/require-js-extension.yml`.
- **No logic in barrels.** `index.ts` only re-exports (`export { x } from './x.js'`); functions, classes and values live in named files. Enforced by `rules/no-logic-in-barrel.yml`.
- **A single file does not need a folder.** Each module is a named file (`src/atomic.ts`), not a one-file folder.
- **Tests:** colocated with the module they cover, always inside a `__tests__/` folder — `src/__tests__/foo.test.ts` for a root module, `src/<module>/__tests__/bar.test.ts` for a file inside a folder module. Never beside the source file. Enforced by `rules/colocate-unit-tests.yml` and `test/integration/conventions.test.ts`.
- **Tests outside `src/`** go in `test/integration/` when they span modules, `test/contract/` when they lock a surface consumers rely on (`docs/contract.md`), or `test/e2e/` for the slow suite. Shared test code goes in `test/helpers/` and test data in `test/fixtures/`. One suffix, `.test.ts`. Enforced by `rules/test-dir-layout.yml`, `rules/tests-dir-is-src-only.yml` and `rules/no-spec-suffix.yml`; `rules/src-never-imports-test.yml` keeps shipped code from importing any of it.

## Repository layout

A single flat package. Named module files under `src/`, with `src/index.ts` as the package's barrel (the public programmatic surface).

```text
src/
  index.ts          barrel: re-exports the public API (no logic)
  cli.ts            arg parsing, command dispatch (the bin)
  adapters.ts       the slot catalogue, and ADAPTERS drawn from the packs (data-only)
  config.ts         checkride.config.json loading and validation, resolution, detection
  init.ts           shape presets, existing-repo adoption, AGENTS stanza
  claude-md.ts      whether CLAUDE.md loads AGENTS.md, and the `@AGENTS.md` edit that makes it
  doctor.ts         `checkride doctor` — the environment and every check's status
  baseline-command.ts  `checkride baseline` — capture the committed baseline
  recover.ts        `checkride recover` — rebuild the baseline from git history
  gate.ts           `checkride gate` — the stop-gate verdict, harness-neutral
  target-command.ts `checkride target add` — declare a target, converting a repo with none
  target-files.ts   write a targets change: the config as written, and the renamed baseline
  git.ts            read-only git plumbing: the --changed base and paths, the run's head
  node-pin.ts       the repo's Node pin, and aligning a child process to it
  links.ts          built-in links check
  pack.ts           built-in pack dry-run check
  smoke.ts          built-in import-liveness check
  snippets.ts       built-in doc-snippet typecheck
  security.ts       built-in dependency-audit check
  atomic.ts         atomic file writes (temp file + fsync + rename)
  proc.ts           process-group kill + SIGTERM→SIGKILL escalation
  json.ts           the one `isRecord` narrowing primitive
  resources.ts      the only reader of the shipped templates/, schema/ and skills/
  tool-json.ts      tolerant JSON extraction from a tool's stdout
  agent-setup/      AGENTS.md stanza + Claude Code hooks
  artifacts/        the output directory (`.check/`) and its shared, bounded read
  baseline/         fingerprints drawn from findings/, the committed baseline store, the ratchet
  digest/           token-bounded digest.md of the failing slots
  findings/         one parser per tool output format, the findings the baseline keys
  launch/           a check's argv through its pack's pin chain, and the repo's entry command
  orchestrator/     slot selection, spawning, .check/ writing, the summary
  packs/            the language packs' adapter rows, and the tools they run (data-only)
  qa/               bundled-plugin reader: the quality artifacts
  targets/          named (pack, root) targets, and the rules their config keeps
  triage/           bundled-plugin reader: preflight a red gate
  __tests__/        unit tests for the root modules
templates/          per-pack scaffold files (shipped): ts/ (shapes, configs, rules), repo/,
                    go/ and rust/ (shapes, configs, rules), python/ and terraform/ (configs)
test/
  integration/      tests that span modules (run by `pnpm check`)
  contract/         locks on the surfaces in docs/contract.md (run by `pnpm check`)
  e2e/              the slow suite (`pnpm test:e2e`)
  fixtures/         test data
rules/              ast-grep structural rules (dogfooded here)
```

Same principle either way: a single file is a module; a module only becomes a
folder with a barrel `index.ts` when it grows internals worth hiding, and then
siblings reach only the index. Eleven modules (`agent-setup/`, `artifacts/`,
`baseline/`, `digest/`, `findings/`, `launch/`, `orchestrator/`, `packs/`,
`qa/`, `targets/`, `triage/`) have crossed that line; the rest are single files. That list is checked against the tree by
`test/integration/conventions.test.ts`, so it cannot go stale silently. The
same rules ship to consumer projects — see `templates/ts/shared/rules/`.

## Patched dependencies

`pnpm-workspace.yaml` carries `patchedDependencies`: fixes upstream hasn't
shipped yet, with the diffs under `patches/`. Each entry's comment names its
issue and how to retire it. Today there are three. One fixes
`@stryker-mutator/vitest-runner` for vitest 5 (stryker-js #6210), and
`test/e2e/mutation-canary.e2e.test.ts` fails if mutation testing stops killing
mutants. Another points `@vvago/vale`'s postinstall at the release's
github.com download links instead of GitHub's API, whose anonymous limit (60
requests an hour per IP, shared on hosted CI runners) fails the install with a
403. The third carries micromatch/braces#88 into braces 3.0.3, which
markdownlint-cli2 globs through, so a brace pattern nested past 128 throws a
`SyntaxError` instead of overflowing the stack (GHSA-vfj7-8cjw-p6xm, which no
braces release fixes). `pnpm audit` matches by version and can't see a patch,
so `auditConfig.ignoreGhsas` ignores that advisory beside it.

- **When a patched package moves,** `pnpm install` stops with
  `ERR_PNPM_UNUSED_PATCH`. Don't silence it: delete the entry and its patch
  file, re-install, and run `pnpm test:e2e`. If the canary passes, the release
  fixed it and the patch is retired. If it fails, re-create the patch for the
  new version with `pnpm patch`.
- **`@vvago/vale` has no canary,** and it releases often. When it moves, grep
  the new version's `dist/index.cjs` for `api.github.com`. If it's gone, the
  patch is retired. If not, re-create the patch with the new version's links;
  its `pnpm-workspace.yaml` comment says where to find them.
- **When braces ships a fix,** delete its entry, the patch file and the
  `auditConfig` ignore, re-install, and run `pnpm check --include security`.
  If the slot is green, the release fixed it.
- **When vitest, stryker or TypeScript moves,** run `pnpm test:e2e` before
  trusting the result. A mutation run that kills nothing passes every other
  check.
- **If the canary still fails after a patch is restored,** pnpm's repeat-install
  cache may have skipped applying it. Delete
  `node_modules/.pnpm-workspace-state-v1.json` and re-install.

## What NOT to do

- Do not disable a lint rule to pass the check. Use a scoped inline suppression with a reason, or discuss first.
- Do not add dependencies casually. Fallow will flag unused ones.
- Do not add a file that is not imported by something.
- Do not skip tests for new behavior.
- Do not bypass `pnpm check` by running individual tools and claiming done.
- Do not put logic in a barrel `index.ts` — re-export from a named file.
