/**
 * Adapter registry — pure data.
 *
 * A `Slot` is a role in the pipeline (the catalogue; order matters, cheapest
 * first). An `Adapter` is a concrete tool that can fill a slot. The registry is
 * data only: no logic lives here. Resolution (config vs detection) lives in
 * `../config`, and execution lives in `../orchestrator`.
 *
 * Phase 1 ships the blessed defaults plus the two opt-in slots. Alternates
 * (biome, knip, eslint, jest) land in Phase 2.
 */

/** The aggregate-report schema version written to `.check/summary.json`. */
export const SCHEMA_VERSION = 1;

/** A role in the pipeline. */
export type Slot = {
  /** Stable slot name, e.g. `'lint'`. Used by `--only`/`--skip` and the report. */
  name: string;
  /** Opt-in slots are excluded from the default run (need `--all`/`--include`). */
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
  /** In-process check id (e.g. `'links'`); when set, the orchestrator runs it directly. */
  builtin?: string;
  /** Pinned versions `init` writes into package.json. */
  devDeps: Record<string, string>;
};

/** Pipeline order. Cheapest first so `--bail` fails fast. */
export const SLOTS: readonly Slot[] = [
  { name: 'types' },
  { name: 'lint' },
  { name: 'struct' },
  { name: 'dead' },
  { name: 'test' },
  { name: 'docs' },
  { name: 'links' },
  { name: 'spell' },
  { name: 'mutation', optIn: true },
  { name: 'security', optIn: true },
];

/** Blessed-default adapters (Phase 1). One per slot. */
export const ADAPTERS: readonly Adapter[] = [
  {
    name: 'tsc',
    slot: 'types',
    description: 'TypeScript type checking (incremental, via project references)',
    detect: ['tsconfig.json'],
    command: 'pnpm',
    args: ['exec', 'tsc', '--build'],
    outputFile: null,
    devDeps: { typescript: '6.0.3', '@types/node': '24.12.2' },
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
];
