/**
 * The failures a red vitest run names beneath its status line, read from
 * what vitest 5.0.3's default reporter printed on stderr. The fixtures under
 * `test/fixtures/vitest-stderr/` are real captures, each of one small test
 * file: `unhandled` has the stack lines inside `node_modules` left out, and
 * `colour` is `one` run with `FORCE_COLOR=1`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import type { Failure } from '../excerpt.js';
import { failureExcerpt } from '../excerpt.js';
import { vitestFailures } from '../vitest-failures.js';

const INDENT = '           ';

/** What vitest printed on stderr in the capture named `name`. */
function captured(name: string): string {
  return readFileSync(new URL(`../../../test/fixtures/vitest-stderr/${name}.stderr.txt`, import.meta.url), 'utf8');
}

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

const vitest = fakeAdapter({ name: 'vitest', slot: 'test', command: 'pnpm', args: ['exec', 'vitest', 'run'] });
const TOTALS = ' Test Files  1 failed (1)\n      Tests  1 failed (1)\n';

/** A failed check of `adapter` that printed `stderr`, and a run's totals on stdout. */
function failed(adapter: Adapter, stderr: string, stdout = TOTALS): Failure {
  const outcome = { ok: false, exit_code: 1, stdout, stderr };
  const check = { name: adapter.slot, adapter: adapter.name, description: adapter.name, ok: false, exit_code: 1, duration_ms: 1, output_file: null };
  return { run: { slot: adapter.slot, adapter, outcome, name: adapter.slot }, check, label: '.check', argv: [adapter.command, ...adapter.args], repoRoot: '/repo', stated: false };
}

/** The excerpt's lines, each without the indent every one of them starts with. */
function lines(failure: Failure): string[] {
  return failureExcerpt(failure).map((line) => line.slice(INDENT.length));
}

const BOTH_FILES = 'full output: .check/test.stdout.txt, .check/test.stderr.txt';

describe('vitestFailures', () => {
  test('reads a failed test and the first line of its error', () => {
    expect(vitestFailures(captured('one'))).toEqual([
      { name: 'one/sum.test.js > sum > adds two numbers', error: 'AssertionError: expected 3 to be 4 // Object.is equality' },
    ]);
  });

  test('reads every failed test in the order vitest printed them, whatever kind of error each threw', () => {
    expect(vitestFailures(captured('many'))).toEqual([
      { name: 'many/many.test.js > many > one', error: 'AssertionError: expected 1 to be 2 // Object.is equality' },
      { name: 'many/many.test.js > many > two', error: 'Error: boom two' },
      { name: 'many/many.test.js > many > three', error: "TypeError: Cannot read properties of null (reading 'x')" },
      { name: 'many/many.test.js > many > four', error: 'AssertionError: expected { a: 1 } to deeply equal { a: 2 }' },
      { name: 'many/many.test.js > many > five', error: "AssertionError: expected 'a' to be 'b' // Object.is equality" },
      { name: 'many/many.test.js > many > six', error: 'AssertionError: expected true to be false // Object.is equality' },
    ]);
  });

  test('reads a failed suite, a file that threw as it was imported, which names no test', () => {
    expect(vitestFailures(captured('suite'))).toEqual([
      { name: 'suite/broken.test.js [ suite/broken.test.js ]', error: "Error: Cannot find module './no-such-module.js' imported from /private/tmp/cr-vt/suite/broken.test.js" },
      { name: 'suite/throws.test.js [ suite/throws.test.js ]', error: 'Error: setup exploded' },
    ]);
  });

  test('reads an error thrown outside any test, named by its kind, and not the banner above them', () => {
    expect(vitestFailures(captured('unhandled'))).toEqual([
      { name: 'Unhandled Rejection', error: 'Error: late rejection' },
      { name: 'Uncaught Exception', error: 'Error: late throw' },
    ]);
  });

  test('reads coloured output as it reads plain', () => {
    expect(captured('colour')).toContain('\u001B[41m\u001B[1m FAIL \u001B[22m\u001B[49m');
    expect(vitestFailures(captured('colour'))).toEqual(vitestFailures(captured('one')));
    const rule = '\u001B[31m⎯⎯⎯⎯\u001B[39m\u001B[1m\u001B[41m Unhandled Rejection \u001B[49m\u001B[22m\u001B[31m⎯⎯⎯⎯⎯\u001B[39m\n\u001B[31m\u001B[1mError\u001B[22m: late\u001B[39m\n';
    expect(vitestFailures(rule)).toEqual([{ name: 'Unhandled Rejection', error: 'Error: late' }]);
  });

  test('tests that failed on one error each carry it', () => {
    const shared = ' FAIL  a.test.js > one\n FAIL  a.test.js > two\nError: same cause\n ❯ a.test.js:3:1\n';
    expect(vitestFailures(shared)).toEqual([
      { name: 'a.test.js > one', error: 'Error: same cause' },
      { name: 'a.test.js > two', error: 'Error: same cause' },
    ]);
  });

  test('a block that printed no error has none, and a rule is never taken for one', () => {
    expect(vitestFailures(' FAIL  a.test.js > one\n\n⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯\n\n FAIL  a.test.js > two\n')).toEqual([
      { name: 'a.test.js > one', error: '' },
      { name: 'a.test.js > two', error: '' },
    ]);
  });

  test('reads no failure in text that only mentions one', () => {
    expect(vitestFailures('')).toEqual([]);
    expect(vitestFailures('Error: Failed to load config\n  at FAIL  x\nFAIL  no leading space\n FAIL one space\n')).toEqual([]);
    expect(vitestFailures('⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\n\nVitest caught 2 unhandled errors during the test run.\n')).toEqual([]);
  });
});

describe('failureExcerpt (a vitest run)', () => {
  test('names the failing test and its error, then both files', () => {
    expect(lines(failed(vitest, captured('one')))).toEqual([
      'one/sum.test.js > sum > adds two numbers',
      '  AssertionError: expected 3 to be 4 // Object.is equality',
      BOTH_FILES,
    ]);
    expect(lines(failed(vitest, captured('colour')))).toEqual(lines(failed(vitest, captured('one'))));
  });

  test('names four failures, two lines each, then how many more failed', () => {
    expect(lines(failed(vitest, captured('many')))).toEqual([
      'many/many.test.js > many > one',
      '  AssertionError: expected 1 to be 2 // Object.is equality',
      'many/many.test.js > many > two',
      '  Error: boom two',
      'many/many.test.js > many > three',
      "  TypeError: Cannot read properties of null (reading 'x')",
      'many/many.test.js > many > four',
      '  AssertionError: expected { a: 1 } to deeply equal { a: 2 }',
      '… and 2 more',
      BOTH_FILES,
    ]);
  });

  test('names a failed suite and an error outside any test', () => {
    expect(lines(failed(vitest, captured('suite'))).slice(2)).toEqual(['suite/throws.test.js [ suite/throws.test.js ]', '  Error: setup exploded', BOTH_FILES]);
    expect(lines(failed(vitest, captured('unhandled')))).toEqual(['Unhandled Rejection', '  Error: late rejection', 'Uncaught Exception', '  Error: late throw', BOTH_FILES]);
  });

  test('cuts a long name or error at 200 characters', () => {
    const [name, error] = lines(failed(vitest, ` FAIL  a.test.js > ${'n'.repeat(300)}\nError: ${'e'.repeat(300)}\n`));
    expect(name).toBe(`a.test.js > ${'n'.repeat(187)}…`);
    expect(error).toBe(`  Error: ${'e'.repeat(190)}…`);
  });

  test('a failure with no error line is named alone, and a run with no stdout names stderr’s file', () => {
    expect(lines(failed(vitest, ' FAIL  a.test.js > one\n', ''))).toEqual(['a.test.js > one', 'full output: .check/test.stderr.txt']);
  });

  test('a run it reads no failure in shows both streams’ last lines, as any other check does', () => {
    const crash = 'failed to load config from /repo/vitest.config.ts\nError: Cannot find module vite\n';
    expect(lines(failed(vitest, crash, 'RUN v5.0.3\n'))).toEqual([
      'stderr:',
      '  failed to load config from /repo/vitest.config.ts',
      '  Error: Cannot find module vite',
      'stdout:',
      '  RUN v5.0.3',
      BOTH_FILES,
    ]);
    expect(lines(failed(vitest, '', 'FAIL src/a.test.ts > adds\n'))).toEqual(['FAIL src/a.test.ts > adds', 'full output: .check/test.stdout.txt']);
    expect(failureExcerpt(failed(vitest, '', ''))).toEqual([`${INDENT}no output captured (exit 1)`]);
  });

  test('a custom command that runs vitest is read as any custom command', () => {
    const custom = fakeAdapter({ name: 'unit', slot: 'unit', command: 'pnpm', args: ['exec', 'vitest', 'run'] });
    const shown = lines(failed(custom, captured('one')));
    expect(shown.at(0)).toBe('stderr:');
    expect(shown.join('\n')).not.toContain('AssertionError');
  });

  test('a check whose reason line states its cause prints the pointer alone', () => {
    expect(lines({ ...failed(vitest, captured('one')), stated: true })).toEqual(['full output: .check/test.stdout.txt']);
  });
});
