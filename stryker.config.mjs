/**
 * Stryker mutation testing config.
 *
 * Invoked by the opt-in `mutation` slot (and directly via `pnpm mutation`).
 * Mutates the source modules and runs the unit tests (the e2e suite is excluded
 * from the default vitest config, so Stryker does not run it). Incremental mode
 * keeps re-runs cheap.
 */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '.check/mutation.json' },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/index.ts',
    // adapters.ts is the data registry (descriptions, detect globs, pinned
    // versions); mutating data strings is noise, not a test-quality signal.
    '!src/adapters.ts',
  ],
  // Mutation testing here targets control flow, not the exact wording of
  // human-readable messages, install hints, and generated file content (license
  // text, README, AGENTS stanza). Those are data; asserting them character by
  // character is brittle and not a behavior test. StringLiteral mutations on
  // that content are expected survivors, so they are excluded from the metric.
  mutator: { excludedMutations: ['StringLiteral'] },
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'stryker.incremental.json',
  thresholds: { high: 80, low: 60, break: 55 },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
