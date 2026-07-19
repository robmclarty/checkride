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

/**
 * A check's scheduling order. Numbers form a single ascending line — equal
 * values run together as one concurrent wave, decimals sequence steps within a
 * wave (`1` before `1.1`), a barrier sits between distinct values. The five
 * keywords place a check relative to that line: `'first'`/`'last'` before/after
 * everything, `'single'` exclusively on its own (after the numeric line, before
 * `'last'`), and `'middle'`/`'any'` unordered in the main group. Effective order
 * resolves config `order` ?? `Adapter.order` ?? `Slot.order` ?? `'any'`.
 */
export type OrderString = 'first' | 'last' | 'middle' | 'single' | 'any';
export type Order = number | OrderString;

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
  /**
   * Default scheduling order for this slot — the lowest-precedence source, which
   * config and adapter overrides beat. Omitted means `'any'` (the main group).
   */
  order?: Order;
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
  /**
   * Detection by package script: the slot is available when `scripts.<name>`
   * exists in package.json. `build` uses `scripts.build` — an opted-in `build`
   * on a repo with no build script stands down as a skip, never a red check (D18).
   */
  detectScript?: string;
  /**
   * Backup detection signal: the slot activates when a `detect` file exists OR
   * one of these packages appears in dependencies/devDependencies. Populated only
   * on adapters whose tool runs correctly with zero config (D18), so a repo that
   * installed the tool but never wrote its config file still opts in.
   */
  detectDeps?: string[];
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
  /** Per-check timeout in seconds; `0` disables the cap. Falls back to the config-level `timeout`, then the built-in 600s default. */
  timeout?: number;
  /** In-process check id (e.g. `'links'`); when set, the orchestrator runs it directly. */
  builtin?: string;
  /**
   * When set, checkride derives this adapter's pass/fail from its parsed JSON
   * output instead of its process exit code. Only `'fallow'` today: fallow's
   * exit code doesn't reliably gate (combined mode and `dupes` exit 0 even with
   * findings), so the verdict is read from the report's issue count — see
   * `baseline/fallow.ts`. The exit code is still recorded in the report.
   */
  gate?: 'fallow';
  /**
   * Scheduling order override for this adapter, beating the slot's default (used
   * when one slot carries adapters that schedule differently). Omitted defers to
   * the slot.
   */
  order?: Order;
  /** Pinned versions `init` writes into package.json. */
  devDeps: Record<string, string>;
};

/**
 * Pipeline catalogue in cheapest-first order — the within-wave tie-break and the
 * full `--bail` sequence. Most slots take the default `'any'` wave; `mutation`
 * runs exclusively (`'single'`) because stryker saturates every core, `build`
 * runs in wave 10, and the artifact checks (`publint`/`attw`) share wave 20 so
 * the build precedes them. See `config.ts` for how effective order resolves and sorts.
 */
export const SLOTS: readonly Slot[] = [
  { name: 'types' },
  { name: 'format', optIn: true },
  { name: 'lint' },
  { name: 'struct' },
  { name: 'dead' },
  { name: 'dupes', optIn: true },
  { name: 'health', optIn: true },
  { name: 'test' },
  { name: 'docs' },
  { name: 'links' },
  { name: 'spell' },
  { name: 'mutation', optIn: true, order: 'single' },
  { name: 'security', optIn: true },
  { name: 'build', optIn: true, order: 10 },
  { name: 'publint', optIn: true, order: 20 },
  { name: 'attw', optIn: true, order: 20 },
  { name: 'pack', optIn: true, order: 20 },
  { name: 'smoke', optIn: true, order: 20 },
  { name: 'snippets', optIn: true },
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
    detectDeps: ['prettier'],
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
    detectDeps: ['oxlint'],
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
    description: 'Fallow: unused code, cycles, and boundary violations (dead-code)',
    detect: ['fallow.toml'],
    command: 'pnpm',
    // Per-analysis subcommand, not combined `fallow`: only the subcommands emit a
    // single-kind report, and checkride reads the issue count out of it to gate
    // (fallow's own exit code is unreliable — see `gate` and `baseline/fallow.ts`).
    args: ['exec', 'fallow', 'dead-code', '--format', 'json', '--quiet'],
    outputFile: 'dead.json',
    gate: 'fallow',
    fixArgs: ['exec', 'fallow', 'fix'],
    devDeps: { fallow: '3.5.0' },
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
    gate: 'fallow',
    devDeps: { fallow: '3.5.0' },
  },
  {
    name: 'fallow',
    slot: 'health',
    description: 'Fallow: complexity & maintainability (health)',
    detect: ['fallow.toml'],
    command: 'pnpm',
    args: ['exec', 'fallow', 'health', '--format', 'json', '--quiet'],
    outputFile: 'health.json',
    gate: 'fallow',
    devDeps: { fallow: '3.5.0' },
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
    detectDeps: ['cspell'],
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
    name: 'build',
    slot: 'build',
    description: "Build the package (runs the consumer's build script)",
    // No config file to detect — availability rides on `scripts.build` (D13/D18).
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
  {
    name: 'pack',
    slot: 'pack',
    description: 'Pack dry-run: the tarball ships the required files and none of the forbidden ones',
    detect: [],
    // `command`/`args` are the availability signature (`isAvailableUnder` gates
    // pack to npm/pnpm, mirroring the pnpm-only `security` slot; D10). The real
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
    // Built-in liveness probe (D9). Like `links`, it spawns a plain `node` — no
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
    // Built-in (D16); `command`/`args` are the availability signature only — the
    // real invocation (translated per PM) and the src-mode `paths` derivation
    // (Q1) live in `snippets.ts`. First adapter for the slot, so it is the
    // blessed default (config names `snippets-dist` to opt into the other mode).
    command: 'pnpm',
    args: ['exec', 'tsc', '--noEmit', '-p', '.check/doc-snippets/tsconfig.json'],
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
    args: ['exec', 'tsc', '--noEmit', '-p', '.check/doc-snippets/tsconfig.json'],
    outputFile: 'snippets.json',
    builtin: 'snippets-dist',
    order: 20,
    devDeps: {},
  },
];
