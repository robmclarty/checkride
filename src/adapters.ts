/**
 * Adapter registry — pure data.
 *
 * A `Slot` is a role in the pipeline (the catalogue; order matters, cheapest
 * first). An `Adapter` is a concrete tool that can fill a slot. The registry is
 * data only: no logic lives here. Resolution (config vs detection) lives in
 * `../config`, and execution lives in `../orchestrator`.
 *
 * The catalogue covers the blessed defaults, the opt-in slots (format,
 * mutation, security, and the library-publishing checks), and alternate
 * adapters (biome, knip, eslint, jest) that fill a slot when detected.
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
  /** Stable slot name, for example `'lint'`. Used by `--only`/`--skip` and the report. */
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
  /** Adapter name, for example `'oxlint'`. Recorded as `adapter` in the report. */
  name: string;
  /** The slot this adapter fills, for example `'lint'`. */
  slot: string;
  /** Human description for the report. */
  description: string;
  /** Config files whose presence activates this adapter. `[]` = always available. */
  detect: string[];
  /**
   * Detection by package script: the slot is available when `scripts.<name>`
   * exists in package.json. `build` uses `scripts.build` — an opted-in `build`
   * on a repo with no build script stands down as a skip, never a red check.
   */
  detectScript?: string;
  /**
   * Backup detection signal: the slot activates when a `detect` file exists OR
   * one of these packages appears in dependencies/devDependencies. Populated only
   * on adapters whose tool runs correctly with zero config, so a repo that
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
  /** In-process check id (for example `'links'`); when set, the orchestrator runs it directly. */
  builtin?: string;
  /**
   * Consumed by the `links` built-in only: extra directory names to skip while
   * walking for markdown, on top of its built-in exclude set. Carried from a
   * config entry's `exclude`; ignored by every other adapter.
   */
  exclude?: string[];
  /**
   * Consumed by the `links` built-in only: regex sources for link targets to
   * treat as always-valid (deliberately illustrative links). Carried from a
   * config entry's `allowlist` and validated at config load; ignored elsewhere.
   */
  allowlist?: string[];
  /**
   * Consumed by the `prose` slot only: repo-relative directory of hand-written
   * voice exemplars, carried from a config entry's `exemplars`. The orchestrator
   * fails the check when the directory is missing or holds no files — the
   * exemplars are load-bearing anchor texts, and a config that points at nothing
   * must not stay green. Ignored by every other adapter.
   */
  exemplars?: string;
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
  { name: 'prose', optIn: true },
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
    devDeps: { typescript: '6.0.3', '@types/node': '22.20.1' },
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
    devDeps: { '@biomejs/biome': '2.5.6' },
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
    devDeps: { oxlint: '1.74.0', 'oxlint-tsgolint': '0.25.0' },
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
    name: 'ast-grep',
    slot: 'struct',
    description: 'Structural rules (ast-grep)',
    detect: ['sgconfig.yml', 'sgconfig.yaml'],
    command: 'pnpm',
    args: ['exec', 'ast-grep', 'scan', '--json=compact'],
    outputFile: 'struct.json',
    devDeps: { '@ast-grep/cli': '0.45.0' },
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
    devDeps: { fallow: '3.9.1' },
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
    gate: 'fallow',
    devDeps: { fallow: '3.9.1' },
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
    devDeps: { fallow: '3.9.1' },
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
    devDeps: { vitest: '4.1.10', '@vitest/coverage-v8': '4.1.10' },
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
    devDeps: { jest: '30.4.2' },
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
    devDeps: { 'markdownlint-cli2': '0.23.2' },
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
    devDeps: { cspell: '10.0.1' },
  },
  {
    name: 'vale',
    slot: 'prose',
    description: 'Vale: writing style (prose linting)',
    // Vale's own config-discovery names, and the whole detection signal: no
    // `detectDeps`, because vale hard-errors (E100, exit 2) with no config file
    // — it is not configless-capable, so a repo that installed the tool but never
    // wrote its config must not be opted in.
    detect: ['.vale.ini', '_vale.ini'],
    command: 'pnpm',
    // `--no-global` keeps the verdict off ~/.vale.ini, so a check means the same
    // thing on every machine. The trailing `.` is load-bearing: vale lints
    // nothing at all without a path argument. It also reads no .gitignore and
    // skips no hidden directory, so a repo narrows the walk by overriding
    // `args` with explicit paths — the same way this one already does for lint.
    args: ['exec', 'vale', '--no-global', '--output=JSON', '.'],
    outputFile: 'prose.json',
    devDeps: { '@vvago/vale': '3.17.0' },
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
    // Unlike the other built-ins, the security evaluator DOES run these args:
    // they are the audit invocation, and `--audit-level=<l>` doubles as the
    // gate threshold it enforces itself — pnpm's JSON-mode exit code ignores
    // the level, so trusting it gated at zero advisories of any severity.
    args: ['audit', '--audit-level=high', '--json'],
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
    devDeps: { publint: '0.3.22' },
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
