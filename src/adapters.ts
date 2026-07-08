/**
 * Adapter registry — pure data.
 *
 * A `Slot` is a role in the pipeline (the catalogue; order matters, cheapest
 * first). An `Adapter` is a concrete tool that can fill a slot. The registry is
 * data only: no logic lives here. Resolution (config vs detection) lives in
 * `../config`, and execution lives in `../orchestrator`.
 *
 * Phase 1 ships the blessed defaults plus the opt-in slots (format, mutation,
 * security, and the library-publishing pair publint + attw). Alternates (biome,
 * knip, eslint, jest) land in Phase 2.
 */

/** The aggregate-report schema version written to `.check/summary.json`. */
export const SCHEMA_VERSION = 1;

/** A role in the pipeline. */
export type Slot = {
  /** Stable slot name, e.g. `'lint'`. Used by `--only`/`--skip` and the report. */
  name: string;
  /**
   * Opt-in slots are excluded from the default run. Enable one with
   * `--all`/`--include <slot>`, or by naming it in `checks` (an explicit config
   * entry opts you in — see `resolveChecks`/`selectChecks`).
   */
  optIn?: boolean;
};

/** A concrete tool that can fill a slot. */
export type Adapter = {
  /** Adapter name, e.g. `'oxlint'`. Recorded as `adapter` in the report. */
  name: string;
  /** The slot this adapter fills, e.g. `'lint'`. */
  slot: string;
  /** Human description for the report (mirrors the interim check catalogue). */
  description: string;
  /** Config files whose presence activates this adapter. `[]` = always available. */
  detect: string[];
  /** Command to spawn (usually `'pnpm'`). Ignored when `builtin` is set. */
  command: string;
  /** Arguments to the command. Ignored when `builtin` is set. */
  args: string[];
  /** `.check/<file>` target when stdout is JSON; `null` if the tool writes its own. */
  outputFile: string | null;
  /** Appended to `args` under `--changed`. */
  changedArgs?: string[];
  /** Used by `checkride fix`. */
  fixArgs?: string[];
  /** Per-check timeout in seconds; `0` disables the cap. Falls back to the config-level `timeout`. */
  timeout?: number;
  /** In-process check id (e.g. `'links'`); when set, the orchestrator runs it directly. */
  builtin?: string;
  /** Pinned versions `init` writes into package.json. */
  devDeps: Record<string, string>;
};

/** Pipeline order. Cheapest first so `--bail` fails fast. */
export const SLOTS: readonly Slot[] = [
  { name: 'types' },
  { name: 'format', optIn: true },
  { name: 'lint' },
  { name: 'struct' },
  { name: 'dead' },
  { name: 'test' },
  { name: 'docs' },
  { name: 'links' },
  { name: 'spell' },
  { name: 'mutation', optIn: true },
  { name: 'security', optIn: true },
  { name: 'publint', optIn: true },
  { name: 'attw', optIn: true },
];

/**
 * Adapter registry. The FIRST adapter for a slot is its blessed default: it
 * wins detection when several tool configs coexist, and is the only one `init`
 * generates config for. Alternates follow so checkride can still *run* them.
 */
export const ADAPTERS: readonly Adapter[] = [
  {
    name: 'tsc',
    slot: 'types',
    description: 'TypeScript type checking (incremental, via project references)',
    detect: ['tsconfig.json'],
    command: 'pnpm',
    args: ['exec', 'tsc', '--build'],
    outputFile: null,
    devDeps: { typescript: '6.0.3', '@types/node': '22.20.0' },
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
    command: 'pnpm',
    args: ['exec', 'prettier', '--check', '.'],
    outputFile: null,
    fixArgs: ['exec', 'prettier', '--write', '.'],
    devDeps: { prettier: '3.6.2' },
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
    devDeps: { '@biomejs/biome': '2.2.4' },
  },
  {
    name: 'oxlint',
    slot: 'lint',
    description: 'Oxlint with tsgolint type-aware rules',
    detect: ['.oxlintrc.json'],
    command: 'pnpm',
    args: ['exec', 'oxlint', '--type-aware', '--format=json'],
    outputFile: 'lint.json',
    fixArgs: ['exec', 'oxlint', '--type-aware', '--fix'],
    devDeps: { oxlint: '1.61.0', 'oxlint-tsgolint': '0.21.1' },
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
    devDeps: { '@biomejs/biome': '2.2.4' },
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
    devDeps: { eslint: '9.36.0' },
  },
  {
    name: 'ast-grep',
    slot: 'struct',
    description: 'Structural rules (ast-grep)',
    detect: ['sgconfig.yml', 'sgconfig.yaml'],
    command: 'pnpm',
    args: ['exec', 'ast-grep', 'scan', '--json=compact'],
    outputFile: 'struct.json',
    devDeps: { '@ast-grep/cli': '0.42.1' },
  },
  {
    name: 'fallow',
    slot: 'dead',
    description: 'Fallow: dead code, cycles, duplication, boundaries, complexity',
    detect: ['fallow.toml'],
    command: 'pnpm',
    args: ['exec', 'fallow', '--format', 'json'],
    outputFile: 'dead.json',
    fixArgs: ['exec', 'fallow', 'fix'],
    devDeps: { fallow: '2.48.0' },
  },
  {
    name: 'knip',
    slot: 'dead',
    description: 'Knip: unused files, exports, and dependencies',
    detect: ['knip.json', 'knip.jsonc', '.knip.json', 'knip.config.ts', 'knip.config.js'],
    command: 'pnpm',
    args: ['exec', 'knip', '--reporter', 'json'],
    outputFile: 'dead.json',
    fixArgs: ['exec', 'knip', '--fix'],
    devDeps: { knip: '5.64.0' },
  },
  {
    name: 'vitest',
    slot: 'test',
    description: 'Vitest tests with coverage',
    detect: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts'],
    command: 'pnpm',
    args: [
      'exec', 'vitest', 'run',
      '--coverage',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=.check/test.json',
    ],
    outputFile: null,
    changedArgs: ['--changed', 'origin/main'],
    devDeps: { vitest: '4.1.5', '@vitest/coverage-v8': '4.1.5' },
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
    args: ['exec', 'jest', '--ci', '--json', '--outputFile=.check/test.json'],
    outputFile: null,
    changedArgs: ['--changedSince', 'origin/main'],
    devDeps: { jest: '30.0.5' },
  },
  {
    name: 'markdownlint-cli2',
    slot: 'docs',
    description: 'Markdown linting',
    detect: [
      '.markdownlint-cli2.jsonc',
      '.markdownlint-cli2.json',
      '.markdownlint-cli2.yaml',
      '.markdownlint-cli2.cjs',
      '.markdownlint-cli2.mjs',
    ],
    command: 'pnpm',
    args: ['exec', 'markdownlint-cli2'],
    outputFile: null,
    fixArgs: ['exec', 'markdownlint-cli2', '--fix'],
    devDeps: { 'markdownlint-cli2': '0.22.1' },
  },
  {
    name: 'links',
    slot: 'links',
    description: 'Relative markdown link targets exist on disk',
    detect: [],
    command: 'node',
    args: [],
    outputFile: 'links.json',
    builtin: 'links',
    devDeps: {},
  },
  {
    name: 'cspell',
    slot: 'spell',
    description: 'Spell check',
    detect: [
      'cspell.json',
      '.cspell.json',
      'cspell.config.json',
      'cspell.config.yaml',
      'cspell.config.cjs',
      'cspell.config.mjs',
    ],
    command: 'pnpm',
    args: ['exec', 'cspell', '--no-progress', '--no-summary', '--reporter=default'],
    outputFile: null,
    devDeps: { cspell: '10.0.0' },
  },
  {
    name: 'stryker',
    slot: 'mutation',
    description: 'Stryker mutation testing (incremental)',
    detect: ['stryker.config.mjs', 'stryker.config.json', 'stryker.conf.json', 'stryker.conf.js'],
    command: 'pnpm',
    args: ['exec', 'stryker', 'run'],
    outputFile: null,
    devDeps: {
      '@stryker-mutator/core': '9.6.1',
      '@stryker-mutator/vitest-runner': '9.6.1',
    },
  },
  {
    name: 'pnpm-audit',
    slot: 'security',
    description: 'Dependency audit (pnpm audit)',
    detect: [],
    command: 'pnpm',
    args: ['audit', '--audit-level=high', '--json'],
    outputFile: 'security.json',
    devDeps: {},
  },
  {
    name: 'publint',
    slot: 'publint',
    description: 'publint: package.json publishing correctness',
    detect: [],
    command: 'pnpm',
    args: ['exec', 'publint'],
    outputFile: null,
    devDeps: { publint: '0.3.21' },
  },
  {
    name: 'attw',
    slot: 'attw',
    description: 'Are the types wrong? (type resolution across module systems)',
    detect: [],
    command: 'pnpm',
    args: ['exec', 'attw', '--pack', '.', '--format', 'json'],
    outputFile: 'attw.json',
    devDeps: { '@arethetypeswrong/cli': '0.18.4' },
  },
];
