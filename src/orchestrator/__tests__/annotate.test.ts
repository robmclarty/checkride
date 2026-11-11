/**
 * A run's GitHub annotations as lines: what each red check yields, how a path
 * is named from the git top level, how a line is escaped, and the cap. Pure
 * over the red checks a run hands it, but for whether a test's file exists,
 * which each test here answers itself.
 */

import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import type { AnnotateScope, Fresh, RedCheck } from '../annotate.js';
import { ANNOTATE_ENV, annotateFormat, annotateScope, ANNOTATION_CAP, annotationLines, escapeMessage, escapeProperty, repoPath } from '../annotate.js';
import { failureExcerpt, shownOf } from '../excerpt.js';
import type { SummaryCheck } from '../index.js';

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

const oxlint = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json', command: 'pnpm', args: ['exec', 'oxlint', '--format=json'] });
const custom = fakeAdapter({ name: 'deploy', slot: 'deploy' });
const vitest = fakeAdapter({ name: 'vitest', slot: 'test' });
const goTest = fakeAdapter({ name: 'go-test', slot: 'test', outputFile: 'test.jsonl' });

type Diagnostic = { filename: string; code?: string; message: string; line?: number; column?: number; severity?: string };

/** An oxlint report of `diagnostics`, each an error, with a place where it gives a line. */
function report(diagnostics: readonly Diagnostic[]): string {
  return JSON.stringify({
    diagnostics: diagnostics.map(({ filename, code, message, line, column, severity = 'error' }) => ({
      filename, message, severity, ...(code === undefined ? {} : { code }),
      ...(line === undefined ? {} : { labels: [{ span: { line, ...(column === undefined ? {} : { column }) } }] }),
    })),
  });
}

/** `count` findings, the nth in `f<n>.ts` at line n, column 7, under rule `no-<n>`. */
function numbered(count: number): Diagnostic[] {
  return Array.from({ length: count }, (_, i) => ({ filename: `f${i + 1}.ts`, code: `no-${i + 1}`, message: `bad ${i + 1}`, line: i + 1, column: 7 }));
}

/** `cause`: the reason is the whole of why it failed, as a timeout's is. `fresh`: the keys a baseline doesn't grandfather. */
type Over = { reason?: string; cause?: boolean; fresh?: Fresh | string[]; entry?: Partial<SummaryCheck>; root?: string; exit?: number; label?: string; repoRoot?: string };

/** What a test gave as `fresh`: new keys alone, as a baseline that holds none of them leaves them, or the whole of it. */
function freshOf(given: Fresh | string[] | undefined): Fresh | null {
  if (given === undefined) return null;
  return Array.isArray(given) ? { keys: new Set(given), excess: new Map() } : given;
}

/** The summary entry of a failed check of `adapter` that exited `exit`, its JSON artifact written when it printed any stdout. */
function entryOf(adapter: Adapter, exit: number, stdout: string, over: Partial<SummaryCheck> = {}): SummaryCheck {
  const json = adapter.outputFile !== null && stdout.trim() !== '';
  return { name: adapter.slot, adapter: adapter.name, description: adapter.name, ok: false, exit_code: exit, duration_ms: 1, output_file: json ? adapter.outputFile : null, ...over };
}

/** A work tree whose top is `top`, where each path is a regular file whose real path is `files`' entry for it, else itself. */
function tree(top: string, files: Record<string, string> = {}): AnnotateScope {
  return { top, summary: '', realFile: (path) => files[path] ?? path };
}

/** What the report lists beneath a red check's status line: the excerpt's lines, without the indent or the pointer. */
function listed(check: RedCheck): string[] {
  return failureExcerpt(check.failure, check.shown).map((line) => line.trim()).filter((line) => !line.startsWith('full output:'));
}

/** A red check of `adapter` that printed `streams`, as a run hands it to its annotations. */
function red(adapter: Adapter, streams: { stdout?: string; stderr?: string }, over: Over = {}): RedCheck {
  const { exit = 1, label = '.check', repoRoot = '/repo', cause = false, reason = null } = over;
  const outcome = { ok: false, exit_code: exit, stdout: '', stderr: '', ...streams };
  const check = entryOf(adapter, exit, outcome.stdout, over.entry);
  const fresh = freshOf(over.fresh);
  const run = { slot: adapter.slot, adapter, outcome, name: check.name, ...(over.root === undefined ? {} : { root: over.root }) };
  const failure = { run, check, label, argv: [adapter.command, ...adapter.args], repoRoot, stated: cause || fresh !== null };
  return { failure, shown: shownOf(failure), reason, fresh };
}

/** A work tree at `/repo` where every path is a regular file, and its own real path. */
const TOP: AnnotateScope = { top: '/repo', summary: '.check/summary.json', realFile: (path) => path };
/** The same tree with no file in it. */
const EMPTY: AnnotateScope = { ...TOP, realFile: () => null };

describe('annotateFormat', () => {
  test('github is the one value, from the flag or the variable, and neither asks for none', () => {
    expect(ANNOTATE_ENV).toBe('CHECKRIDE_ANNOTATE');
    expect(annotateFormat(null)).toBeNull();
    expect(annotateFormat({ value: 'github', from: '--annotate' })).toBe('github');
    expect(annotateFormat({ value: 'github', from: ANNOTATE_ENV })).toBe('github');
  });

  test('any other value is a usage error naming what gave it and the accepted value', () => {
    expect(() => annotateFormat({ value: 'gitlab', from: '--annotate' })).toThrow("invalid --annotate 'gitlab' (expected github)");
    expect(() => annotateFormat({ value: 'GitHub', from: ANNOTATE_ENV })).toThrow("invalid CHECKRIDE_ANNOTATE 'GitHub' (expected github)");
    expect(() => annotateFormat({ value: '', from: '--annotate' })).toThrow("invalid --annotate '' (expected github)");
  });
});

describe('escaping', () => {
  test('a message escapes %, CR and LF, and leaves a colon and a comma', () => {
    expect(escapeMessage('100% of a,b: done\r\nnext')).toBe('100%25 of a,b: done%0D%0Anext');
    // `%` first, so an escape it writes is never escaped again.
    expect(escapeMessage('%0A')).toBe('%250A');
  });

  test('a property value also escapes a colon and a comma', () => {
    expect(escapeProperty('100% of a,b: done\r\nnext')).toBe('100%25 of a%2Cb%3A done%0D%0Anext');
  });

  test('a finding carries each escape into its line', () => {
    const found = [{ filename: 'src/a,b:c%.ts', code: 'ns:rule,x%', message: '50% of a,b: c', line: 1 }];
    expect(annotationLines([red(oxlint, { stdout: report(found) })], TOP)).toEqual([
      '::error file=src/a%2Cb%3Ac%25.ts,line=1,title=lint%3A ns%3Arule%2Cx%25::50%25 of a,b: c',
    ]);
  });

  test('escape sequences and control characters are stripped from the path, the title and the message, and each stays one line', () => {
    const found = [{ filename: 'src/\u001B[31ma\u001B[0m\n.ts', code: 'no-\u001B[1mx\u001B[0m\r\ny\u0007', message: '\u001B[1mbad\u001B[0m\u0000\nsecond line', line: 2, column: 3 }];
    expect(annotationLines([red(oxlint, { stdout: report(found) })], TOP)).toEqual([
      '::error file=src/a .ts,line=2,col=3,title=lint%3A no-x y::bad',
    ]);
  });

  test('a reason line is a tool’s text too, and is stripped the same way', () => {
    const lines = annotationLines([red(custom, { stderr: 'x\n' }, { reason: '\u001B[31mtimed out\u001B[0m after 5s\u0007', cause: true, exit: -1 })], TOP);
    expect(lines).toEqual(['::error title=deploy::timed out after 5s']);
  });

  test('a message is cut at 200 characters, as an excerpt’s line is', () => {
    const [line = ''] = annotationLines([red(oxlint, { stdout: report([{ filename: 'a.ts', message: 'x'.repeat(300) }]) })], TOP);
    expect(line).toBe(`::error file=a.ts,title=lint::${'x'.repeat(199)}…`);
  });
});

describe('repoPath', () => {
  test('a path from the repo root is named from the top of the work tree, with forward slashes', () => {
    expect(repoPath('src/a.ts', '/repo', TOP)).toBe('src/a.ts');
    expect(repoPath('./src/a.ts', '/repo', TOP)).toBe('src/a.ts');
    expect(repoPath('src/a.ts', '/top/services/api', tree('/top'))).toBe('services/api/src/a.ts');
  });

  test('an absolute path is named from the top too', () => {
    expect(repoPath('/repo/src/a.ts', '/repo', TOP)).toBe('src/a.ts');
    expect(repoPath('/top/lib/a.ts', '/top/services/api', tree('/top'))).toBe('lib/a.ts');
  });

  test('a path above the run’s directory is still in the work tree when the top level is higher', () => {
    expect(repoPath('../shared/a.ts', '/top/services/api', tree('/top'))).toBe('services/shared/a.ts');
  });

  test('no path, and a path outside the work tree, name no file', () => {
    expect(repoPath('', '/repo', TOP)).toBeNull();
    expect(repoPath('../other/a.ts', '/repo', TOP)).toBeNull();
    expect(repoPath('/elsewhere/a.ts', '/repo', TOP)).toBeNull();
    expect(repoPath('../../../a.ts', '/top/services/api', tree('/top'))).toBeNull();
    // The top level itself is a directory, never a file to point at.
    expect(repoPath('.', '/repo', TOP)).toBeNull();
  });

  test('a path that is no regular file names none: a package name where a path goes, a directory, a file since deleted', () => {
    expect(repoPath('lodash', '/repo', EMPTY)).toBeNull();
    expect(repoPath('src', '/repo', EMPTY)).toBeNull();
    expect(repoPath('@scope/pkg', '/repo', EMPTY)).toBeNull();
  });

  test('real paths are compared, so a root reached through a symlink sits beneath the top it links to', () => {
    // `/link` is a symlink to `/real/top/api`, and git names the top level by its real path.
    const linked = tree('/real/top', { '/link/src/a.ts': '/real/top/api/src/a.ts' });
    expect(repoPath('src/a.ts', '/link', linked)).toBe('api/src/a.ts');
    // A file inside the tree that links out of it is outside it.
    expect(repoPath('src/a.ts', '/repo', tree('/repo', { '/repo/src/a.ts': '/etc/passwd' }))).toBeNull();
  });
});

describe('annotateScope', () => {
  test('the top level git gave is the top, and the run’s own root where it gave none', () => {
    expect(annotateScope('/no/such/top', '/no/such/top/sub', 's')).toEqual({ top: '/no/such/top', summary: 's' });
    expect(annotateScope(null, '/no/such/root', 's')).toEqual({ top: '/no/such/root', summary: 's' });
  });
});

describe('annotationLines (a check with findings)', () => {
  test('each finding is an error at its place, titled with the check and its rule', () => {
    expect(annotationLines([red(oxlint, { stdout: report(numbered(2)) })], TOP)).toEqual([
      '::error file=f1.ts,line=1,col=7,title=lint%3A no-1::bad 1',
      '::error file=f2.ts,line=2,col=7,title=lint%3A no-2::bad 2',
    ]);
  });

  test('col is left out without a column, and line without a line', () => {
    const found = [
      { filename: 'a.ts', code: 'no-x', message: 'no column', line: 4 },
      { filename: 'b.ts', code: 'no-x', message: 'no line' },
    ];
    expect(annotationLines([red(oxlint, { stdout: report(found) })], TOP)).toEqual([
      '::error file=a.ts,line=4,title=lint%3A no-x::no column',
      '::error file=b.ts,title=lint%3A no-x::no line',
    ]);
  });

  test('a finding with no rule is titled with the check’s name alone', () => {
    expect(annotationLines([red(oxlint, { stdout: report([{ filename: 'a.ts', message: 'bad', line: 1 }]) })], TOP)).toEqual([
      '::error file=a.ts,line=1,title=lint::bad',
    ]);
  });

  test('a target’s check is titled as the run prints it, its paths from the repo root', () => {
    const web = red(oxlint, { stdout: report(numbered(1)) }, { entry: { name: 'web:lint', target: 'web', slot: 'lint', output_file: 'web/lint.json' }, root: 'packages/web' });
    expect(annotationLines([web], TOP)).toEqual(['::error file=packages/web/f1.ts,line=1,col=7,title=web%3Alint%3A no-1::bad 1']);
  });

  test('a run from a subdirectory of the git top level names its paths from the top', () => {
    const scope = { ...TOP, top: '/top' };
    expect(annotationLines([red(oxlint, { stdout: report(numbered(1)) }, { root: 'web', repoRoot: '/top/services/api' })], scope)).toEqual([
      '::error file=services/api/web/f1.ts,line=1,col=7,title=lint%3A no-1::bad 1',
    ]);
  });

  test('a finding outside the repository keeps its annotation and loses its place', () => {
    const found = [{ filename: '../elsewhere/a.ts', code: 'no-x', message: 'bad', line: 3, column: 1 }];
    // The file exists, above the top level.
    expect(annotationLines([red(oxlint, { stdout: report(found) })], TOP)).toEqual(['::error title=lint%3A no-x::bad']);
  });

  test('a finding that can only advise is never annotated', () => {
    const found = [{ filename: 'a.ts', code: 'no-x', message: 'only advice', line: 1, severity: 'warning' }, { filename: 'b.ts', code: 'no-y', message: 'an error', line: 2 }];
    expect(annotationLines([red(oxlint, { stdout: report(found) })], TOP)).toEqual(['::error file=b.ts,line=2,title=lint%3A no-y::an error']);
  });

  test('where a baseline masked some, only the findings it doesn’t grandfather are annotated', () => {
    const masked = red(oxlint, { stdout: report(numbered(4)) }, { fresh: ['f2.ts:no-2:bad 2', 'f4.ts:no-4:bad 4'] });
    expect(annotationLines([masked], TOP)).toEqual([
      '::error file=f2.ts,line=2,col=7,title=lint%3A no-2::bad 2',
      '::error file=f4.ts,line=4,col=7,title=lint%3A no-4::bad 4',
    ]);
  });
});

/** The one annotation of a finding in `a.ts` at `line` and `column`, each left out when not given. */
function at(line: number | undefined, column?: number): string {
  const finding = { filename: 'a.ts', message: 'bad', ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
  return annotationLines([red(oxlint, { stdout: report([finding]) })], TOP)[0] ?? '';
}

describe('annotationLines (what a finding points at)', () => {
  test('a finding whose file is no regular file in the work tree keeps its annotation and loses its place', () => {
    const found = [{ filename: 'lodash', code: 'unused-dependency', message: 'never imported', line: 1, column: 1 }];
    expect(annotationLines([red(oxlint, { stdout: report(found) })], EMPTY)).toEqual(['::error title=lint%3A unused-dependency::never imported']);
  });

  test('line is written only from 1 up, and col only from 1 up and beside a line', () => {
    expect(at(3, 7)).toBe('::error file=a.ts,line=3,col=7,title=lint::bad');
    expect(at(1, 1)).toBe('::error file=a.ts,line=1,col=1,title=lint::bad');
    expect(at(3, 0)).toBe('::error file=a.ts,line=3,title=lint::bad');
    expect(at(3, -2)).toBe('::error file=a.ts,line=3,title=lint::bad');
    expect(at(0, 7)).toBe('::error file=a.ts,title=lint::bad');
    expect(at(-1)).toBe('::error file=a.ts,title=lint::bad');
    expect(at(undefined)).toBe('::error file=a.ts,title=lint::bad');
    expect(at(1.5, 2)).toBe('::error file=a.ts,title=lint::bad');
  });
});

describe('annotationLines (a baseline key found more often than it grandfathers)', () => {
  const twice = [
    { filename: 'a.ts', code: 'no-x', message: 'bad', line: 3, column: 1 },
    { filename: 'b.ts', code: 'no-y', message: 'new', line: 1, column: 1 },
    { filename: 'a.ts', code: 'no-x', message: 'bad', line: 9, column: 1 },
    { filename: 'a.ts', code: 'no-x', message: 'bad', line: 20, column: 1 },
    { filename: 'a.ts', code: 'no-x', message: 'bad', line: 31, column: 1 },
  ];

  test('is one annotation, on its first occurrence, with both counts after the message', () => {
    const fresh: Fresh = { keys: new Set(['b.ts:no-y:new']), excess: new Map([['a.ts:no-x:bad', { found: 4, allowed: 3 }]]) };
    expect(annotationLines([red(oxlint, { stdout: report(twice) }, { fresh })], TOP)).toEqual([
      '::error file=a.ts,line=3,col=1,title=lint%3A no-x::bad (4 found, 3 grandfathered)',
      '::error file=b.ts,line=1,col=1,title=lint%3A no-y::new',
    ]);
  });

  test('the counts follow a message cut at 200 characters, and are never cut with it', () => {
    const long = [1, 2].map((line) => ({ filename: 'a.ts', code: 'no-x', message: 'x'.repeat(300), line }));
    const fresh: Fresh = { keys: new Set(), excess: new Map([[`a.ts:no-x:${'x'.repeat(300)}`, { found: 2, allowed: 1 }]]) };
    expect(annotationLines([red(oxlint, { stdout: report(long) }, { fresh })], TOP)).toEqual([
      `::error file=a.ts,line=1,title=lint%3A no-x::${'x'.repeat(199)}… (2 found, 1 grandfathered)`,
    ]);
  });
});

describe('annotationLines (the same thing the report prints)', () => {
  const vitestErr = ' FAIL  src/sum.test.ts > sum > adds\nAssertionError: expected 3 to be 4\n';

  test('a check that lists its failing tests is annotated with them', () => {
    const check = red(vitest, { stderr: vitestErr });
    expect(listed(check)).toEqual(['src/sum.test.ts > sum > adds', 'AssertionError: expected 3 to be 4']);
    expect(annotationLines([check], TOP)).toEqual(['::error file=src/sum.test.ts,title=test%3A src/sum.test.ts > sum > adds::AssertionError: expected 3 to be 4']);
  });

  test('where the report lists new findings and no test, the findings are annotated and the tests are not', () => {
    // A check under the vitest adapter's name whose output a parser also reads: its stderr names a failing test, its stdout findings.
    const both = { ...oxlint, name: 'oxlint' };
    const check = red(both, { stdout: report(numbered(2)), stderr: vitestErr }, { fresh: ['f2.ts:no-2:bad 2'] });
    // The excerpt prints nothing of its own: the new findings are listed above it.
    expect(listed(check)).toEqual([]);
    expect(annotationLines([check], TOP)).toEqual(['::error file=f2.ts,line=2,col=7,title=lint%3A no-2::bad 2']);
  });

  test('a vitest run whose cause the report states gets the reason, not the tests its partial output names', () => {
    const check = red(vitest, { stderr: `${vitestErr}timed out after 5s\n` }, { reason: 'timed out after 5s', cause: true, exit: -1 });
    expect(listed(check)).toEqual([]);
    expect(annotationLines([check], TOP)).toEqual(['::error title=test::timed out after 5s']);
  });

  test('a go test run lists its failing tests even beside a stated cause, so they are annotated there too', () => {
    const stdout = [event('run', 'TestAdds'), event('output', 'TestAdds', '    a_test.go:9: got 3\n'), event('fail', 'TestAdds'), event('fail', null), ''].join('\n');
    const check = red(goTest, { stdout, stderr: 'timed out after 5s\n' }, { reason: 'timed out after 5s', cause: true, exit: -1 });
    expect(listed(check)).toContain('example.com/a TestAdds');
    expect(annotationLines([check], TOP)).toEqual(['::error title=test%3A example.com/a TestAdds::a_test.go:9: got 3']);
  });

  test('a go test run that only names tests still running gets its one line', () => {
    const stdout = [event('run', 'TestHangs'), ''].join('\n');
    const check = red(goTest, { stdout, stderr: 'timed out after 5s\n' }, { reason: 'timed out after 5s', cause: true, exit: -1 });
    expect(annotationLines([check], TOP)).toEqual(['::error title=test::timed out after 5s']);
  });

  test('new findings whose keys no finding of this run carries fall back to the one line', () => {
    const check = red(oxlint, { stdout: report(numbered(1)) }, { fresh: ['gone.ts:no-z:gone'], reason: '1 finding(s)' });
    expect(annotationLines([check], TOP)).toEqual(['::error title=lint::1 finding(s)']);
  });
});

describe('annotationLines (a check with nothing to point at)', () => {
  test('a custom command gets one annotation with no file: the first line of its excerpt', () => {
    expect(annotationLines([red(custom, { stdout: 'loaded\n', stderr: 'warning 1\nerror: no healthcheck\n' })], TOP)).toEqual([
      '::error title=deploy::warning 1',
    ]);
    expect(annotationLines([red(custom, { stdout: 'only stdout\n' })], TOP)).toEqual(['::error title=deploy::only stdout']);
  });

  test('its stated reason comes first when it has one', () => {
    const hinted = red(custom, { stderr: 'boom\n' }, { reason: 'run `pnpm install` first' });
    expect(annotationLines([hinted], TOP)).toEqual(['::error title=deploy::run `pnpm install` first']);
  });

  test('a check that captured nothing says so', () => {
    expect(annotationLines([red(custom, {}, { exit: 3 })], TOP)).toEqual(['::error title=deploy::no output captured (exit 3)']);
  });

  test('a check whose output holds no printable line points at the file that holds it', () => {
    expect(annotationLines([red(custom, { stderr: '\u0007\n' })], TOP)).toEqual(['::error title=deploy::failed; see .check/deploy.stderr.txt']);
  });

  test('a parser’s tool whose report holds no finding it can read gets the one line', () => {
    expect(annotationLines([red(oxlint, { stdout: '{"diagnostics":[]}' })], TOP)).toEqual([
      '::error title=lint::exit 1, no findings checkride can read in the JSON report',
    ]);
  });

  test('a timeout or a refusal is one annotation naming it, whatever findings its partial output holds', () => {
    const timedOut = red(oxlint, { stdout: report(numbered(3)), stderr: 'timed out after 60s\n' }, { reason: 'timed out after 60s', cause: true, exit: -1 });
    const refused = red(custom, {}, { reason: 'refused: the tool is not pinned', cause: true, exit: -1 });
    expect(annotationLines([timedOut, refused], TOP)).toEqual([
      '::error title=lint::timed out after 60s',
      '::error title=deploy::refused%3A the tool is not pinned'.replace('%3A', ':'),
    ]);
  });
});

/** One `go test -json` event of package `example.com/a`: a test's, or the package's own for `null`. */
function event(Action: string, Test: string | null, Output?: string): string {
  return JSON.stringify({ Action, Package: 'example.com/a', ...(Test === null ? {} : { Test }), ...(Output === undefined ? {} : { Output }) });
}

describe('annotationLines (failing tests)', () => {
  const stderr = [
    ' FAIL  src/sum.test.ts > sum > adds two numbers',
    'AssertionError: expected 3 to be 4 // Object.is equality',
    '',
    ' FAIL  src/broken.test.ts [ src/broken.test.ts ]',
    "Error: Cannot find module './missing.js'",
    '',
    ' FAIL  src/gone.test.ts > gone',
    'Error: 100% wrong',
    '',
  ].join('\n');

  test('each failing vitest test is one annotation, with its file only where its name gives a real one', () => {
    const seen: string[] = [];
    const scope = { ...TOP, realFile: (path: string) => { seen.push(path); return path.includes('gone') ? null : path; } };
    expect(annotationLines([red(vitest, { stderr })], scope)).toEqual([
      '::error file=src/sum.test.ts,title=test%3A src/sum.test.ts > sum > adds two numbers::AssertionError: expected 3 to be 4 // Object.is equality',
      "::error file=src/broken.test.ts,title=test%3A src/broken.test.ts [ src/broken.test.ts ]::Error: Cannot find module './missing.js'",
      '::error title=test%3A src/gone.test.ts > gone::Error%3A 100%25 wrong'.replace('Error%3A', 'Error:'),
    ]);
    expect(seen).toEqual(['/repo/src/sum.test.ts', '/repo/src/broken.test.ts', '/repo/src/gone.test.ts']);
  });

  test('a target’s test file is looked for beneath its root and named from the top level', () => {
    const seen: string[] = [];
    const scope = { ...TOP, top: '/mono', realFile: (path: string) => { seen.push(path); return path; } };
    const web = red(vitest, { stderr }, { entry: { name: 'web:test' }, root: 'packages/web', repoRoot: '/mono/repo' });
    expect(annotationLines([web], scope)[0]).toBe(
      '::error file=repo/packages/web/src/sum.test.ts,title=web%3Atest%3A src/sum.test.ts > sum > adds two numbers::AssertionError: expected 3 to be 4 // Object.is equality',
    );
    expect(seen[0]).toBe('/mono/repo/packages/web/src/sum.test.ts');
  });

  test('a test name’s escape sequences and control characters never reach the line', () => {
    const dirty = ' FAIL  src/a.test.ts > \u001B[31mred\u001B[0m\u0007 name\nError: \u001B[1mboom\u001B[0m\u0000\n';
    expect(annotationLines([red(vitest, { stderr: dirty })], EMPTY)).toEqual(['::error title=test%3A src/a.test.ts > red name::Error: boom']);

  });

  test('in a run of projects, the file follows the project and the title keeps the whole name', () => {
    const projects = [' FAIL  |unit| src/broken.test.js [ src/broken.test.js ]', "Error: Cannot find module './missing.js'", '', ' FAIL  |web app| src/sum.test.js > sum > adds two numbers', 'AssertionError: expected 3 to be 4', ''].join('\n');
    expect(annotationLines([red(vitest, { stderr: projects })], TOP)).toEqual([
      "::error file=src/broken.test.js,title=test%3A |unit| src/broken.test.js [ src/broken.test.js ]::Error: Cannot find module './missing.js'",
      '::error file=src/sum.test.js,title=test%3A |web app| src/sum.test.js > sum > adds two numbers::AssertionError: expected 3 to be 4',
    ]);
  });

  test('a failing go test is titled with its package and name, with the line that says why and no file', () => {
    const stdout = [
      event('run', 'TestAdds'),
      event('output', 'TestAdds', '=== RUN   TestAdds\n'),
      event('output', 'TestAdds', '    a_test.go:9: \u001B[31mgot 3\u001B[0m, want 4\n'),
      event('output', 'TestAdds', '--- FAIL: TestAdds (0.00s)\n'),
      event('fail', 'TestAdds'),
      event('run', 'Test\u001B[31mBad\u001B[0m\nName'),
      event('fail', 'Test\u001B[31mBad\u001B[0m\nName'),
      event('fail', null),
      '',
    ].join('\n');
    expect(annotationLines([red(goTest, { stdout })], TOP)).toEqual([
      '::error title=test%3A example.com/a TestAdds::a_test.go:9: got 3, want 4',
      '::error title=test%3A example.com/a TestBad Name::failed',
    ]);
  });
});

describe('annotationLines (the cap)', () => {
  test('a run with no red check writes nothing', () => {
    expect(annotationLines([], TOP)).toEqual([]);
  });

  test('exactly the cap writes no notice', () => {
    const lines = annotationLines([red(oxlint, { stdout: report(numbered(ANNOTATION_CAP)) })], TOP);
    expect(lines).toHaveLength(ANNOTATION_CAP);
    expect(lines.every((line) => line.startsWith('::error '))).toBe(true);
  });

  test('past the cap, the first ten in the run’s order, then one notice counting the rest', () => {
    expect(ANNOTATION_CAP).toBe(10);
    const lines = annotationLines([red(oxlint, { stdout: report(numbered(8)) }), red(custom, { stderr: 'boom\n' }), red(oxlint, { stdout: report(numbered(6)) }, { entry: { name: 'web:lint' } })], TOP);
    expect(lines).toHaveLength(ANNOTATION_CAP + 1);
    expect(lines[7]).toBe('::error file=f8.ts,line=8,col=7,title=lint%3A no-8::bad 8');
    expect(lines[8]).toBe('::error title=deploy::boom');
    expect(lines[9]).toBe('::error file=f1.ts,line=1,col=7,title=web%3Alint%3A no-1::bad 1');
    expect(lines[10]).toBe('::notice title=checkride::5 more finding(s) not annotated; see .check/summary.json');
  });

  test('the notice names the summary the run wrote, a suite’s among them', () => {
    const lines = annotationLines([red(oxlint, { stdout: report(numbered(11)) }, { label: '.check/suites/evals' })], { ...TOP, summary: '.check/suites/evals/summary.json' });
    expect(lines.at(-1)).toBe('::notice title=checkride::1 more finding(s) not annotated; see .check/suites/evals/summary.json');
  });
});
