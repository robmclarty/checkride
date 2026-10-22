/**
 * Reading `go test -json` for the tests a red run names (#13): its tail is
 * package summaries, so the events are what say which test failed, and which
 * one was still running when a timeout killed the run.
 */

import { describe, expect, test } from 'vitest';

import { caseName, goTestReport } from '../index.js';

/** One `go test -json` event line. */
function event(action: string, pkg: string, name?: string, output?: string): string {
  return JSON.stringify({ Time: '2026-10-21T00:00:00Z', Action: action, Package: pkg, ...(name !== undefined ? { Test: name } : {}), ...(output !== undefined ? { Output: output } : {}) });
}

describe('goTestReport', () => {
  test('names each failing leaf test with its last output lines, not the parent a subtest failed', () => {
    const stdout = [
      event('start', 'example.com/a'),
      event('run', 'example.com/a', 'TestAdd'),
      event('output', 'example.com/a', 'TestAdd', '=== RUN   TestAdd\n'),
      event('run', 'example.com/a', 'TestAdd/zero'),
      event('output', 'example.com/a', 'TestAdd/zero', '    add_test.go:12: got 1, want 0\n'),
      event('output', 'example.com/a', 'TestAdd/zero', '--- FAIL: TestAdd/zero (0.00s)\n'),
      event('fail', 'example.com/a', 'TestAdd/zero'),
      event('fail', 'example.com/a', 'TestAdd'),
      event('run', 'example.com/a', 'TestOK'),
      event('pass', 'example.com/a', 'TestOK'),
      event('fail', 'example.com/a'),
      'not an event',
    ].join('\n');
    expect(goTestReport(stdout)).toEqual({
      failed: [{ pkg: 'example.com/a', test: 'TestAdd/zero', output: ['    add_test.go:12: got 1, want 0', '--- FAIL: TestAdd/zero (0.00s)'] }],
      running: [],
    });
  });

  test('a test that ran and never finished is running, its paused siblings and finished parents are not', () => {
    const stdout = [
      event('run', 'example.com/b', 'TestHang'),
      event('run', 'example.com/b', 'TestHang/forever'),
      event('output', 'example.com/b', 'TestHang/forever', 'waiting on the lock\n'),
      event('run', 'example.com/b', 'TestParallel'),
      event('pause', 'example.com/b', 'TestParallel'),
      event('run', 'example.com/b', 'TestResumed'),
      event('pause', 'example.com/b', 'TestResumed'),
      event('cont', 'example.com/b', 'TestResumed'),
    ].join('\n');
    expect(goTestReport(stdout)?.running.map(caseName)).toEqual(['example.com/b TestHang/forever', 'example.com/b TestResumed']);
  });

  test('a package that failed with no failing test, a build failure or a panic in TestMain, is named by its package', () => {
    const stdout = [
      event('output', 'example.com/c', undefined, '# example.com/c\n'),
      event('output', 'example.com/c', undefined, 'c.go:3:1: syntax error: unexpected }\n'),
      event('fail', 'example.com/c'),
      event('run', 'example.com/d', 'TestX'),
      event('fail', 'example.com/d', 'TestX'),
      event('fail', 'example.com/d'),
    ].join('\n');
    const report = goTestReport(stdout);
    expect(report?.failed.map(caseName)).toEqual(['example.com/d TestX', 'example.com/c (package)']);
    expect(report?.failed[1]?.output).toEqual(['# example.com/c', 'c.go:3:1: syntax error: unexpected }']);
  });

  /** Go 1.24 and later report a build apart, under `ImportPath`; verbatim from go 1.27.2. */
  test('a package that failed to build names its compile error, which go reports under the import path', () => {
    const stdout = [
      '{"ImportPath":"example.com/c [example.com/c.test]","Action":"build-output","Output":"# example.com/c [example.com/c.test]\\n"}',
      '{"ImportPath":"example.com/c [example.com/c.test]","Action":"build-output","Output":"./c.go:4:1: syntax error: unexpected EOF, expected }\\n"}',
      '{"ImportPath":"example.com/c [example.com/c.test]","Action":"build-fail"}',
      '{"Action":"start","Package":"example.com/c"}',
      '{"Action":"output","Package":"example.com/c","Output":"FAIL\\texample.com/c [build failed]\\n","OutputType":"frame"}',
      '{"Action":"fail","Package":"example.com/c","Elapsed":0,"FailedBuild":"example.com/c [example.com/c.test]"}',
    ].join('\n');
    expect(goTestReport(stdout)).toEqual({
      failed: [{ pkg: 'example.com/c', test: null, output: ['# example.com/c [example.com/c.test]', './c.go:4:1: syntax error: unexpected EOF, expected }', 'FAIL\texample.com/c [build failed]'] }],
      running: [],
    });
  });

  test('output that holds no event is no report, and keeps only the last five lines a test printed', () => {
    expect(goTestReport('# example.com/e\ne.go:1:1: expected package\n')).toBeNull();
    const chatty = [event('run', 'p', 'T'), ...Array.from({ length: 8 }, (_, i) => event('output', 'p', 'T', `line ${i}\n`)), event('fail', 'p', 'T')].join('\n');
    expect(goTestReport(chatty)?.failed[0]?.output).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
  });
});
