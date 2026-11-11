/**
 * A vitest setup file, run in each test process before its test file: it
 * removes every `CHECKRIDE_*` variable from `process.env`, so a test never
 * reads one the developer's shell or the CI job exported. CI sets
 * `CHECKRIDE_ANNOTATE` on the step that runs these tests, and a test that
 * calls `runCli` with no `env`, or spawns the CLI with the process's own,
 * would otherwise annotate, pick a suite or write somewhere else. A test
 * that needs one of them passes it explicitly.
 *
 * The ones the test harness itself reads stay: they switch the tests, not the
 * CLI under test, and are set on purpose by whoever runs the suite.
 */

/** The variables the tests read for themselves: a missing toolchain fails an e2e case, the invariance fixtures are rewritten, and the binary e2e runs a binary already built. */
const HARNESS_VARS: ReadonlySet<string> = new Set(['CHECKRIDE_REQUIRE_TOOLCHAINS', 'CHECKRIDE_UPDATE_INVARIANCE', 'CHECKRIDE_BIN']);

for (const name of Object.keys(process.env)) {
  if (name.startsWith('CHECKRIDE_') && !HARNESS_VARS.has(name)) delete process.env[name];
}
