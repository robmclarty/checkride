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
    // The two bundled-plugin bins. Each is three lines that read argv, call the
    // module, and print — and each does that work at module top level, which is
    // correct for a bin and unreachable from the unit runner Stryker drives
    // (the e2e suite is excluded from the default vitest config). They are
    // covered, by `test/e2e/plugin-readers.e2e.test.ts` spawning them as
    // processes; left in here they would report a permanent 0% that no test
    // could ever move, which is worse than absent. If either grows logic
    // beyond wiring, that logic belongs in the module and stays mutated there.
    '!src/qa/cli.ts',
    '!src/triage/cli.ts',
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
  // `break` is the gate; `high`/`low` only colour the report. The measured
  // score is 73.2%, so break sits ~5 points under it rather than right beneath:
  // a mutant's `Timeout` status depends on machine load, so a threshold within a
  // point or two of the real score fails on a busy laptop and passes on an idle
  // one. Ratchet it up as the score climbs — never down to make a run pass.
  thresholds: { high: 85, low: 70, break: 68 },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
