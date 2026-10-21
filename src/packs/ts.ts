/**
 * The ts pack: the TypeScript toolchain's adapters.
 *
 * It fills every target-scope slot, from `types` to `snippets`: the blessed
 * defaults, the opt-in slots (format, mutation, security, and the
 * library-publishing checks), and alternate adapters (biome, knip, eslint,
 * jest) that fill a slot when detected. Its tools are the ones the project's
 * own package manager installed.
 */

import { CHECK_DIR } from '../artifacts/index.js';
import type { Pack } from './types.js';

/**
 * The tsconfig the snippets built-ins generate in their scratch directory,
 * which sits under the target root even when `--out` moves the artifacts.
 */
const SNIPPETS_TSCONFIG = `${CHECK_DIR}/doc-snippets/tsconfig.json`;

export const TS_PACK: Pack = {
  name: 'ts',
  markers: ['package.json', 'tsconfig.json'],
  pins: ['js-lockfile'],
  env: {},
  adapters: [
    {
      name: 'tsc',
      slot: 'types',
      description: 'TypeScript type checking (incremental, via project references)',
      detect: ['tsconfig.json'],
      command: 'pnpm',
      args: ['exec', 'tsc', '--build'],
      outputFile: null,
      devDeps: { typescript: '7.0.2', '@types/node': '22.20.5' },
    },
    {
      name: 'prettier',
      slot: 'format',
      description: 'Prettier formatting check',
      detect: [
        '.prettierrc',
        '.prettierrc.json',
        '.prettierrc.yml',
        '.prettierrc.yaml',
        '.prettierrc.json5',
        '.prettierrc.js',
        '.prettierrc.cjs',
        '.prettierrc.mjs',
        '.prettierrc.toml',
        'prettier.config.js',
        'prettier.config.cjs',
        'prettier.config.mjs',
        'prettier.config.ts',
      ],
      detectDeps: ['prettier'],
      command: 'pnpm',
      args: ['exec', 'prettier', '--check', '.'],
      outputFile: null,
      fixArgs: ['exec', 'prettier', '--write', '.'],
      static: true,
      codeConfigs: [
        'prettier.config.js',
        'prettier.config.cjs',
        'prettier.config.mjs',
        'prettier.config.ts',
        'prettier.config.mts',
        'prettier.config.cts',
        '.prettierrc.js',
        '.prettierrc.cjs',
        '.prettierrc.mjs',
        '.prettierrc.ts',
        '.prettierrc.mts',
        '.prettierrc.cts',
      ],
      // An rc file may instead name a shared config, a module prettier loads,
      // and so may package.json's `prettier`.
      codeKeys: [
        { file: '.prettierrc', keys: ['plugins'], shared: true },
        { file: '.prettierrc.json', keys: ['plugins'], shared: true },
        { file: '.prettierrc.json5', keys: ['plugins'], shared: true },
        { file: '.prettierrc.yaml', keys: ['plugins'], shared: true },
        { file: '.prettierrc.yml', keys: ['plugins'], shared: true },
        { file: '.prettierrc.toml', keys: ['plugins'] },
        { file: 'package.json', keys: ['plugins'], under: 'prettier' },
      ],
      // prettier takes the nearest config above a file, so one at the repo
      // root reaches a target below it.
      configSearchesUp: true,
      devDeps: { prettier: '3.9.6' },
    },
    {
      name: 'biome-format',
      slot: 'format',
      description: 'Biome formatting check',
      detect: ['biome.json', 'biome.jsonc'],
      command: 'pnpm',
      args: ['exec', 'biome', 'format', '.'],
      outputFile: null,
      fixArgs: ['exec', 'biome', 'format', '--write', '.'],
      static: true,
      devDeps: { '@biomejs/biome': '2.5.6' },
    },
    {
      name: 'oxlint',
      slot: 'lint',
      description: 'Oxlint, type-aware with oxlint-tsgolint',
      detect: ['.oxlintrc.json'],
      detectDeps: ['oxlint'],
      command: 'pnpm',
      args: ['exec', 'oxlint', '--type-aware', '--format=json'],
      outputFile: 'lint.json',
      fixArgs: ['exec', 'oxlint', '--type-aware', '--fix'],
      static: true,
      nonStaticArgs: ['--type-aware'],
      // Type-aware rules run through tsgolint, which oxlint finds in a node_modules/.bin above it.
      flagDeps: { '--type-aware': ['oxlint-tsgolint'] },
      codeConfigs: ['oxlint.config.ts', 'oxlint.config.mts', 'oxlint.config.cts', 'oxlint.config.js', 'oxlint.config.mjs', 'oxlint.config.cjs'],
      // A config it extends can add jsPlugins, and the sniff doesn't follow it.
      codeKeys: [{ file: '.oxlintrc.json', keys: ['jsPlugins', 'extends'] }],
      devDeps: { oxlint: '1.87.0', 'oxlint-tsgolint': '7.0.2003' },
    },
    {
      name: 'biome',
      slot: 'lint',
      description: 'Biome lint + format check',
      detect: ['biome.json', 'biome.jsonc'],
      command: 'pnpm',
      args: ['exec', 'biome', 'check', '--reporter=json'],
      outputFile: 'lint.json',
      fixArgs: ['exec', 'biome', 'check', '--write'],
      static: true,
      devDeps: { '@biomejs/biome': '2.5.6' },
    },
    {
      name: 'eslint',
      slot: 'lint',
      description: 'ESLint',
      detect: [
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.cjs',
        'eslint.config.ts',
        '.eslintrc.json',
        '.eslintrc.cjs',
        '.eslintrc.js',
      ],
      command: 'pnpm',
      args: ['exec', 'eslint', '.', '--format', 'json'],
      outputFile: 'lint.json',
      fixArgs: ['exec', 'eslint', '.', '--fix'],
      // Held at 9.x deliberately: eslint 10 is a major and nothing in this repo
      // exercises the eslint adapter, so bumping it would ship a pin no run has
      // ever executed. Needs a fixture project proving this command line and
      // `--format json` still hold before it moves.
      devDeps: { eslint: '9.36.0' },
    },
    {
      name: 'fallow',
      slot: 'dead',
      description: 'Fallow: unused code, cycles, and boundary violations (dead-code)',
      detect: ['fallow.toml'],
      command: 'pnpm',
      // Per-analysis subcommand, not combined `fallow`: only the subcommands emit a
      // single-kind report, and checkride reads the issue count out of it to gate
      // (fallow's own exit code is unreliable). That verdict is keyed on this
      // adapter's *name* — see `REPORT_VERDICTS` in `baseline/fingerprint.ts`,
      // computed by `baseline/fallow.ts` — so the entry declares nothing for it.
      args: ['exec', 'fallow', 'dead-code', '--format', 'json', '--quiet'],
      outputFile: 'dead.json',
      fixArgs: ['exec', 'fallow', 'fix'],
      devDeps: { fallow: '3.31.0' },
    },
    {
      name: 'knip',
      slot: 'dead',
      description: 'Knip: unused files, exports, and dependencies',
      detect: ['knip.json', 'knip.jsonc', '.knip.json', 'knip.config.ts', 'knip.config.js'],
      detectDeps: ['knip'],
      command: 'pnpm',
      args: ['exec', 'knip', '--reporter', 'json'],
      outputFile: 'dead.json',
      fixArgs: ['exec', 'knip', '--fix'],
      // Held at 5.x deliberately, for the same reason as eslint above: knip 6 is
      // a major, the knip adapter is unexercised here, and `--reporter json` is
      // exactly the kind of surface a major rearranges.
      devDeps: { knip: '5.64.0' },
    },
    {
      name: 'fallow',
      slot: 'dupes',
      description: 'Fallow: code duplication (clones)',
      detect: ['fallow.toml'],
      command: 'pnpm',
      args: ['exec', 'fallow', 'dupes', '--format', 'json', '--quiet'],
      outputFile: 'dupes.json',
      // Report-gated by name, like `dead` above: see `REPORT_VERDICTS`.
      devDeps: { fallow: '3.31.0' },
    },
    {
      name: 'fallow',
      slot: 'health',
      description: 'Fallow: complexity & maintainability (health)',
      detect: ['fallow.toml'],
      command: 'pnpm',
      args: ['exec', 'fallow', 'health', '--format', 'json', '--quiet'],
      outputFile: 'health.json',
      // Report-gated by name, like `dead` above: see `REPORT_VERDICTS`.
      devDeps: { fallow: '3.31.0' },
    },
    {
      name: 'vitest',
      slot: 'test',
      description: 'Vitest tests with coverage',
      detect: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts'],
      detectDeps: ['vitest'],
      command: 'pnpm',
      args: [
        'exec', 'vitest', 'run',
        '--coverage',
        '--reporter=default',
        '--reporter=json',
        '--outputFile={out}/test.json',
      ],
      outputFile: null,
      changedArgs: ['--changed', '{base}'],
      devDeps: { vitest: '5.0.3', '@vitest/coverage-v8': '5.0.3' },
    },
    {
      name: 'jest',
      slot: 'test',
      description: 'Jest tests',
      detect: [
        'jest.config.js',
        'jest.config.ts',
        'jest.config.mjs',
        'jest.config.cjs',
        'jest.config.json',
      ],
      command: 'pnpm',
      args: ['exec', 'jest', '--ci', '--json', '--outputFile={out}/test.json'],
      outputFile: null,
      changedArgs: ['--changedSince', '{base}'],
      devDeps: { jest: '30.4.2' },
    },
    {
      name: 'stryker',
      slot: 'mutation',
      description: 'Stryker mutation testing (incremental)',
      detect: ['stryker.config.mjs', 'stryker.config.json', 'stryker.conf.json', 'stryker.conf.js'],
      command: 'pnpm',
      args: ['exec', 'stryker', 'run'],
      // Ships uncapped (`0`). A real mutation run legitimately takes 15–20 min, past
      // the 600s default cap; `mutation` is opt-in and never in the definition-of-done
      // gate the cap protects, so it runs to completion rather than tripping a timeout.
      timeout: 0,
      outputFile: null,
      devDeps: {
        '@stryker-mutator/core': '10.0.0',
        '@stryker-mutator/vitest-runner': '10.0.0',
      },
    },
    {
      name: 'pnpm-audit',
      slot: 'security',
      description: 'Dependency audit (pnpm audit)',
      detect: [],
      command: 'pnpm',
      // Unlike the other built-ins, the security evaluator DOES run these args:
      // they are the audit invocation, and `--audit-level=<l>` doubles as the
      // gate threshold it enforces itself — pnpm's JSON-mode exit code ignores
      // the level, so trusting it gated at zero advisories of any severity.
      // The fetch flags bound the wait when npm's advisory endpoint is down:
      // pnpm's defaults (2 retries, 60s timeout, 10–60s backoff) sit ~250s
      // before reporting; one retry at 15s measures ~40s. pnpm-only flags are
      // safe here — the slot is unavailable under any other manager.
      args: ['audit', '--audit-level=high', '--json', '--fetch-retries=1', '--fetch-timeout=15000'],
      outputFile: 'security.json',
      builtin: 'security',
      devDeps: {},
    },
    {
      name: 'build',
      slot: 'build',
      description: "Build the package (runs the consumer's build script)",
      // No config file to detect — availability rides on `scripts.build`.
      detect: [],
      detectScript: 'build',
      command: 'pnpm',
      args: ['run', 'build'],
      outputFile: null,
      devDeps: {},
    },
    {
      name: 'publint',
      slot: 'publint',
      description: 'publint: package.json publishing correctness',
      // Gated on the installed tool (not "always available"): pulled in by --all on
      // a repo that never installed publint, the slot stands down as a skip rather
      // than hard-failing with `Command "publint" not found`. Naming it in config
      // still forces it (that's an explicit ask to run it).
      detect: [],
      detectDeps: ['publint'],
      command: 'pnpm',
      args: ['exec', 'publint'],
      outputFile: null,
      devDeps: { publint: '0.3.25' },
    },
    {
      name: 'attw',
      slot: 'attw',
      description: 'Are the types wrong? (type resolution across module systems)',
      // Gated on the installed tool for the same reason as publint above.
      detect: [],
      detectDeps: ['@arethetypeswrong/cli'],
      command: 'pnpm',
      args: ['exec', 'attw', '--pack', '.', '--format', 'json'],
      outputFile: 'attw.json',
      devDeps: { '@arethetypeswrong/cli': '0.18.5' },
    },
    {
      name: 'pack',
      slot: 'pack',
      description: 'Pack dry-run: the tarball ships the required files and none of the forbidden ones',
      detect: [],
      // `command`/`args` are the availability signature (`isAvailableUnder` gates
      // pack to npm/pnpm, mirroring the pnpm-only `security` slot). The real
      // per-PM invocation — including the manager-specific ignore-scripts flag —
      // lives in `pack.ts`'s `packInvocation`, since this is a built-in.
      command: 'pnpm',
      args: ['pack', '--dry-run', '--json'],
      outputFile: 'pack.json',
      builtin: 'pack',
      devDeps: {},
    },
    {
      name: 'smoke',
      slot: 'smoke',
      description: 'Smoke import: the built package loads and its declared value exports are live',
      detect: [],
      // Built-in liveness probe. Like `links`, it spawns a plain `node` — no
      // package manager, no checked tool — so it is available under every PM. The
      // real work (enumerate `exports`, scan the dist `.d.ts`, spawn the probe)
      // lives in `smoke.ts`.
      command: 'node',
      args: [],
      outputFile: 'smoke.json',
      builtin: 'smoke',
      devDeps: {},
    },
    {
      name: 'snippets',
      slot: 'snippets',
      description: 'Doc snippet typecheck: tagged fences typecheck against package source',
      detect: [],
      // Built-in; `command`/`args` are the availability signature only — the
      // real invocation (translated per PM) and the src-mode `paths` derivation
      // live in `snippets.ts`. First adapter for the slot, so it is the
      // blessed default (config names `snippets-dist` to opt into the other mode).
      command: 'pnpm',
      args: ['exec', 'tsc', '--noEmit', '-p', SNIPPETS_TSCONFIG],
      outputFile: 'snippets.json',
      builtin: 'snippets',
      devDeps: {},
    },
    {
      name: 'snippets-dist',
      slot: 'snippets',
      description: 'Doc snippet typecheck: tagged fences typecheck against built .d.ts',
      detect: [],
      command: 'pnpm',
      args: ['exec', 'tsc', '--noEmit', '-p', SNIPPETS_TSCONFIG],
      outputFile: 'snippets.json',
      builtin: 'snippets-dist',
      order: 20,
      devDeps: {},
    },
  ],
};
