/**
 * What a `go test -json` run says about its tests, for the reader of a red
 * check: which tests failed, with the last lines each printed, which were
 * still running when the run stopped, and which packages failed without a
 * failing test, a build failure or a panic outside any test among them.
 *
 * The raw `test.jsonl` holds every event, often megabytes of them, and its last
 * lines are package summaries that name no test, so a tail of it never says
 * which test failed. This reads the events instead. It is a reader's view, not
 * a parser the baseline keys with: a test's verdict is its run's, and tests are
 * never grandfathered.
 *
 * A test that failed because a subtest did is left out, as is a test still
 * running only because a subtest is: the leaf names what to look at. A test
 * paused to wait for its parallel siblings isn't running, so it's not listed
 * either. One that ran and never finished, when the check's timeout killed
 * the run, is listed as running.
 */

import { isRecord } from '../json.js';

/** One test, or one package that failed outside any test, with the last lines it printed. */
export type GoTestCase = { pkg: string; test: string | null; output: string[] };

/** The tests a run failed, the ones it left running, and the packages that failed with no failing test. */
export type GoTestReport = { failed: GoTestCase[]; running: GoTestCase[] };

/** How many of a test's output lines the report keeps: its last ones, where `go test` prints why it failed. */
const OUTPUT_LINES = 5;

/** One `go test -json` event, the fields this reads. */
type GoTestEvent = { action: string; pkg: string; test: string | null; output: string | null };

/** A test's state so far: its last action and its last output lines. */
type TestState = { pkg: string; test: string | null; action: string; output: string[] };

/** One line of `go test -json` as an event, or `null` for a line that isn't one. */
function eventOf(line: string): GoTestEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['Action'] !== 'string') return null;
  const test = parsed['Test'];
  const output = parsed['Output'];
  return {
    // A build's output is the package's, as `go test` reports a failed build.
    action: parsed['Action'] === 'build-output' ? 'output' : parsed['Action'],
    pkg: packageOf(parsed),
    test: typeof test === 'string' ? test : null,
    output: typeof output === 'string' ? output : null,
  };
}

/**
 * The package an event is about: its `Package`, or for a build event, which
 * Go 1.24 and later report apart under `ImportPath`, the package that path
 * names, `example.com/c` for `example.com/c [example.com/c.test]`.
 */
function packageOf(event: Record<string, unknown>): string {
  const pkg = event['Package'];
  if (typeof pkg === 'string') return pkg;
  const importPath = event['ImportPath'];
  return typeof importPath === 'string' ? importPath.replace(/ \[.*\]$/, '') : '';
}

/** Whether an output line says something a reader wants: not `go test`'s own `=== RUN` bookkeeping. */
function meaningful(line: string): boolean {
  return line.trim() !== '' && !/^=== (RUN|PAUSE|CONT|NAME)\s/.test(line);
}

/** Fold one event into the states, by package and test. */
function record(states: Map<string, TestState>, event: GoTestEvent): void {
  const id = `${event.pkg}\u0000${event.test ?? ''}`;
  const state = states.get(id) ?? { pkg: event.pkg, test: event.test, action: event.action, output: [] };
  if (event.action === 'output') {
    const line = (event.output ?? '').replace(/\n$/, '');
    if (meaningful(line)) state.output = [...state.output, line].slice(-OUTPUT_LINES);
  } else {
    state.action = event.action;
  }
  states.set(id, state);
}

/** Whether `state` names a test another state names a subtest of, so the leaf says more. */
function hasSubtestIn(state: TestState, others: readonly TestState[]): boolean {
  return others.some((o) => o.pkg === state.pkg && o.test !== null && state.test !== null && o.test.startsWith(`${state.test}/`));
}

/** The cases a report lists from states in one condition: tests only the leaves of, packages as they are. */
function leaves(states: readonly TestState[]): GoTestCase[] {
  return states.filter((s) => !hasSubtestIn(s, states)).map(({ pkg, test, output }) => ({ pkg, test, output }));
}

/**
 * The report a `go test -json` run's stdout makes, or `null` when no line of
 * it is an event, as when a build failed before any test ran and `go` printed
 * text. A package lands in `failed` only when it failed with no failing test.
 */
export function goTestReport(stdout: string): GoTestReport | null {
  const states = new Map<string, TestState>();
  for (const line of stdout.split('\n')) {
    const event = eventOf(line);
    if (event !== null) record(states, event);
  }
  if (states.size === 0) return null;
  const all = [...states.values()];
  const failedTests = all.filter((s) => s.test !== null && s.action === 'fail');
  const failedPackages = all.filter((s) => s.test === null && s.action === 'fail' && !failedTests.some((t) => t.pkg === s.pkg));
  const running = all.filter((s) => s.test !== null && (s.action === 'run' || s.action === 'cont'));
  return { failed: [...leaves(failedTests), ...leaves(failedPackages)], running: leaves(running) };
}

/** How a case names itself: its package and test, or its package alone. */
export function caseName(c: GoTestCase): string {
  return c.test === null ? `${c.pkg} (package)` : `${c.pkg} ${c.test}`;
}
