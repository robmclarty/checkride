/**
 * The excerpt a red check prints beneath its status line: its first findings
 * where its tool has a parser, its last lines where it has none, and the file
 * that holds all of its output. Pure over a run and its summary entry.
 */

import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import type { Failure } from '../excerpt.js';
import { EXCERPT_FINDINGS, EXCERPT_LINE_CHARS, EXCERPT_TAIL_LINES, failureExcerpt, findingLine, plain, shownOf, visibleKey } from '../excerpt.js';
import type { SummaryCheck } from '../index.js';

const INDENT = '           ';

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

const oxlint = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json', command: 'pnpm', args: ['exec', 'oxlint', '--format=json'] });
const custom = fakeAdapter({ name: 'deploy', slot: 'deploy' });

/** An oxlint report of `count` errors, the nth in `f<n>.ts` at line n, under rule `no-<n>`. */
function report(count: number, severity = 'error'): string {
  const diagnostics = Array.from({ length: count }, (_, i) => ({
    filename: `f${i + 1}.ts`, code: `no-${i + 1}`, message: `bad ${i + 1}`, severity, labels: [{ span: { line: i + 1, column: 7 } }],
  }));
  return JSON.stringify({ diagnostics });
}

/** A failed check of `adapter` that printed `streams`, as a run hands it to the excerpt. */
function failed(adapter: Adapter, streams: { stdout?: string; stderr?: string }, over: Partial<Failure> & { entry?: Partial<SummaryCheck> } = {}): Failure {
  const { entry, ...rest } = over;
  const outcome = { ok: false, exit_code: 1, stdout: '', stderr: '', ...streams };
  const json = adapter.outputFile !== null && outcome.stdout.trim() !== '';
  const check: SummaryCheck = {
    name: adapter.slot, adapter: adapter.name, description: adapter.name, ok: false, exit_code: outcome.exit_code, duration_ms: 1,
    output_file: json ? adapter.outputFile : null, ...entry,
  };
  return {
    run: { slot: adapter.slot, adapter, outcome, name: check.name }, check, label: '.check',
    argv: [adapter.command, ...adapter.args], repoRoot: '/repo', stated: false, ...rest,
  };
}

/** The excerpt's lines, each without the indent every one of them starts with. */
function lines(failure: Failure): string[] {
  const printed = failureExcerpt(failure);
  for (const line of printed) expect(line.startsWith(INDENT)).toBe(true);
  return printed.map((line) => line.slice(INDENT.length));
}

describe('failureExcerpt (a tool with a parser)', () => {
  test('lists each finding as path:line:col, message and rule, then the file that holds them all', () => {
    expect(lines(failed(oxlint, { stdout: report(2) }))).toEqual([
      'f1.ts:1:7  bad 1  [no-1]',
      'f2.ts:2:7  bad 2  [no-2]',
      'full output: .check/lint.json',
    ]);
  });

  test('lists exactly five with no count, and past five counts the rest', () => {
    expect(lines(failed(oxlint, { stdout: report(EXCERPT_FINDINGS) }))).toHaveLength(EXCERPT_FINDINGS + 1);
    expect(lines(failed(oxlint, { stdout: report(EXCERPT_FINDINGS) })).join('\n')).not.toContain('more');
    expect(lines(failed(oxlint, { stdout: report(12) }))).toEqual([
      'f1.ts:1:7  bad 1  [no-1]',
      'f2.ts:2:7  bad 2  [no-2]',
      'f3.ts:3:7  bad 3  [no-3]',
      'f4.ts:4:7  bad 4  [no-4]',
      'f5.ts:5:7  bad 5  [no-5]',
      '… and 7 more',
      'full output: .check/lint.json',
    ]);
  });

  test('lists only findings that can fail the check, and falls back to its output when none can', () => {
    const mixed = JSON.stringify({
      diagnostics: [
        { filename: 'a.ts', code: 'no-x', message: 'only advice', severity: 'warning' },
        { filename: 'b.ts', code: 'no-y', message: 'an error', severity: 'error' },
      ],
    });
    expect(lines(failed(oxlint, { stdout: mixed }))).toEqual(['b.ts  an error  [no-y]', 'full output: .check/lint.json']);
    // Warnings alone can't have failed it, so its own lines say more than a parse that lists nothing.
    const advice = report(1, 'warning');
    expect(lines(failed(oxlint, { stdout: advice, stderr: 'oxlint: config not found\n' }))).toEqual([
      'exit 1, no findings checkride can read in the JSON report',
      'stderr:',
      '  oxlint: config not found',
      'full output: .check/lint.json, .check/lint.stderr.txt',
    ]);
  });

  test('output its parser cannot read is excerpted as text', () => {
    const adapter = { ...oxlint, outputFile: null };
    expect(lines(failed(adapter, { stdout: 'thread panicked\nnot json\n' }))).toEqual(['thread panicked', 'not json', 'full output: .check/lint.stdout.txt']);
  });

  test('a parser that reads stderr points at the stderr file', () => {
    const markdownlint = fakeAdapter({ name: 'markdownlint-cli2', slot: 'docs' });
    const stderr = 'README.md:3:1 error MD018/no-missing-space-atx No space after hash on atx style heading [Context: "#Title"]\n';
    const [finding, pointer] = lines(failed(markdownlint, { stdout: 'Finding: README.md\n', stderr }));
    expect(finding).toBe('README.md:3:1  No space after hash on atx style heading [Context: "#Title"]  [MD018]');
    expect(pointer).toBe('full output: .check/docs.stderr.txt');
    // With its cause already stated, the pointer still names the file its findings sit in.
    expect(lines(failed(markdownlint, { stdout: 'Finding: README.md\n', stderr }, { stated: true }))).toEqual(['full output: .check/docs.stderr.txt']);
  });
});

/** `count` lines named `<name> 1` to `<name> <count>`. */
function numbered(name: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${name} ${i + 1}\n`).join('');
}

describe('failureExcerpt (a tool with no parser)', () => {
  test('shows the one stream that holds anything, unlabelled, and names its file', () => {
    expect(lines(failed(custom, { stderr: 'error: no healthcheck\n' }))).toEqual(['error: no healthcheck', 'full output: .check/deploy.stderr.txt']);
    expect(lines(failed(custom, { stdout: 'FAIL src/a.test.ts > adds\n', stderr: ' \n' }))).toEqual([
      'FAIL src/a.test.ts > adds',
      'full output: .check/deploy.stdout.txt',
    ]);
  });

  test('shows both streams when both hold something, each under its name, and names both files', () => {
    expect(lines(failed(custom, { stdout: 'FAILED tests/test_a.py::test_adds\n', stderr: 'npm warn deprecated\n' }))).toEqual([
      'stderr:',
      '  npm warn deprecated',
      'stdout:',
      '  FAILED tests/test_a.py::test_adds',
      'full output: .check/deploy.stdout.txt, .check/deploy.stderr.txt',
    ]);
  });

  test('two long streams share the eight lines, four and four', () => {
    expect(lines(failed(custom, { stdout: numbered('out', 20), stderr: numbered('err', 20) })).slice(0, -1)).toEqual([
      'stderr:', '  err 17', '  err 18', '  err 19', '  err 20',
      'stdout:', '  out 17', '  out 18', '  out 19', '  out 20',
    ]);
  });

  test('a short stream leaves its unused lines to the other', () => {
    expect(lines(failed(custom, { stdout: numbered('out', 20), stderr: numbered('err', 1) })).slice(0, -1)).toEqual([
      'stderr:', '  err 1',
      'stdout:', '  out 14', '  out 15', '  out 16', '  out 17', '  out 18', '  out 19', '  out 20',
    ]);
    expect(lines(failed(custom, { stdout: numbered('out', 2), stderr: numbered('err', 20) })).slice(0, -1)).toEqual([
      'stderr:', '  err 15', '  err 16', '  err 17', '  err 18', '  err 19', '  err 20',
      'stdout:', '  out 1', '  out 2',
    ]);
  });

  test('a tool its failOnOutput verdict failed shows stdout alone, the cause', () => {
    const gofmt = fakeAdapter({ name: 'gofmt', slot: 'format', failOnOutput: true });
    const listed = failed(gofmt, { stdout: 'a.go\nb.go\n', stderr: 'go: downloading\n' });
    const byOutput = { ...listed, run: { ...listed.run, outcome: { ...listed.run.outcome, exit_code: 0 } } };
    expect(lines(byOutput)).toEqual(['a.go', 'b.go', 'full output: .check/format.stdout.txt']);
    // One that exited non-zero failed on its own, so both streams may hold why.
    expect(lines(listed)).toEqual(['stderr:', '  go: downloading', 'stdout:', '  a.go', '  b.go', 'full output: .check/format.stdout.txt, .check/format.stderr.txt']);
  });

  test('shows the last eight lines that hold anything, and all of fewer', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n\n   \n`).join('');
    const shown = lines(failed(custom, { stderr: many }));
    expect(shown).toHaveLength(EXCERPT_TAIL_LINES + 1);
    expect(shown.slice(0, EXCERPT_TAIL_LINES)).toEqual(['line 13', 'line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20']);
    expect(lines(failed(custom, { stderr: '\none\n\ntwo\n\n' }))).toEqual(['one', 'two', 'full output: .check/deploy.stderr.txt']);
  });

  test('strips escape sequences and control characters, and keeps a line’s indent', () => {
    const stderr = '\u001B[31merror\u001B[0m: bad\u0007 thing\r\n\u001B[2K\u001B[1G\n  at a.ts:1\u0000\n\tat b.ts:2\n';
    expect(lines(failed(custom, { stderr })).slice(0, -1)).toEqual(['error: bad thing', '  at a.ts:1', '  at b.ts:2']);
  });

  test('a carriage return breaks a line, so progress output never buries the error after it', () => {
    const progress = Array.from({ length: 50 }, (_, i) => `building ${i + 1}/50 ${'.'.repeat(20)}\r`).join('');
    const shown = lines(failed(custom, { stderr: `${progress}error: link failed\r\nexit status 1\n` })).slice(0, -1);
    expect(shown.slice(-3)).toEqual([`building 50/50 ${'.'.repeat(20)}`, 'error: link failed', 'exit status 1']);
    expect(shown).toHaveLength(EXCERPT_TAIL_LINES);
  });

  test('cuts a long line at 200 characters, the ellipsis included', () => {
    const [line] = lines(failed(custom, { stderr: `${'x'.repeat(500)}\n` }));
    expect(line).toBe(`${'x'.repeat(EXCERPT_LINE_CHARS - 1)}…`);
    const [exact] = lines(failed(custom, { stderr: `${'y'.repeat(EXCERPT_LINE_CHARS)}\n` }));
    expect(exact).toBe('y'.repeat(EXCERPT_LINE_CHARS));
  });

  test('reads only the end of a long stream, from the start of a whole line', () => {
    // 4,000 lines of 49 characters and a newline: the window opens inside one of them.
    const long = Array.from({ length: 4000 }, (_, i) => `${String(i + 1).padStart(4, '0')} \u001B[2m${'x'.repeat(40)}\u001B[0m\n`).join('');
    const shown = lines(failed(custom, { stdout: long })).slice(0, -1);
    expect(shown).toEqual(['3993', '3994', '3995', '3996', '3997', '3998', '3999', '4000'].map((n) => `${n} ${'x'.repeat(40)}`));
    // A single line longer than the window is shown as far as the window holds it.
    const [one] = lines(failed(custom, { stdout: 'y'.repeat(50_000) }));
    expect(one).toBe(`${'y'.repeat(EXCERPT_LINE_CHARS - 1)}…`);
    // A short tail after megabytes of noise is still found.
    expect(lines(failed(custom, { stdout: `${'z'.repeat(200_000)}\nboom\n` })).slice(0, -1)).toEqual(['boom']);
  });

  test('a check that captured nothing says so, and names no file', () => {
    expect(failureExcerpt(failed(custom, {}))).toEqual([`${INDENT}no output captured (exit 1)`]);
    expect(failureExcerpt(failed(custom, { stdout: '\n', stderr: '  ' }))).toEqual([`${INDENT}no output captured (exit 1)`]);
  });
});

describe('failureExcerpt (a JSON report with nothing to list)', () => {
  const said = 'exit 1, no findings checkride can read in the JSON report';

  test('a parsed tool that failed on warnings alone says so in one line, never the JSON', () => {
    expect(lines(failed(oxlint, { stdout: report(3, 'warning') }))).toEqual([said, 'full output: .check/lint.json']);
  });

  test('a tool with no parser that printed JSON says the same, whether or not the run captured it as an artifact', () => {
    const audit = fakeAdapter({ name: 'pnpm-audit', slot: 'security', outputFile: 'security.json' });
    const pretty = JSON.stringify({ advisories: { 1: { severity: 'high' } }, metadata: {} }, null, 2);
    expect(lines(failed(audit, { stdout: pretty }))).toEqual([said, 'full output: .check/security.json']);
    expect(lines(failed(custom, { stdout: `\n${pretty}\n` }))).toEqual([said, 'full output: .check/deploy.stdout.txt']);
    expect(lines(failed(custom, { stdout: '{"a":1}\n{"b":2}\n' }))).toEqual([said, 'full output: .check/deploy.stdout.txt']);
    expect(lines(failed(custom, { stdout: '[1, 2]' }, { entry: { exit_code: 2 } })).at(0)).toBe(said);
  });

  test('text that only starts like JSON is shown as text', () => {
    expect(lines(failed(custom, { stdout: '[vite] build failed\n{ not json\n' }))).toEqual(['[vite] build failed', '{ not json', 'full output: .check/deploy.stdout.txt']);
  });

  test('stderr beside the report is shown under its name, with all eight lines to itself', () => {
    const shown = lines(failed(oxlint, { stdout: report(1, 'warning'), stderr: numbered('err', 12) }));
    expect(shown).toEqual([said, 'stderr:', ...[5, 6, 7, 8, 9, 10, 11, 12].map((n) => `  err ${n}`), 'full output: .check/lint.json, .check/lint.stderr.txt']);
  });
});

/** One `go test -json` event of package `example.com/a`: a test's, or the package's own for `null`. */
function event(Action: string, Test: string | null, Output?: string): string {
  return JSON.stringify({ Action, Package: 'example.com/a', ...(Test === null ? {} : { Test }), ...(Output === undefined ? {} : { Output }) });
}

describe('failureExcerpt (a go test run)', () => {
  const goTest = fakeAdapter({ name: 'go-test', slot: 'test', outputFile: 'test.jsonl' });
  const stdout = [
    event('run', 'TestAdds'),
    event('output', 'TestAdds', '=== RUN   TestAdds\n'),
    event('output', 'TestAdds', '    a_test.go:9: \u001B[31mgot 3\u001B[0m, want 4\n'),
    event('output', 'TestAdds', '--- FAIL: TestAdds (0.00s)\n'),
    event('fail', 'TestAdds'),
    event('run', 'TestSubs'),
    event('output', 'TestSubs', `    a_test.go:20: ${'x'.repeat(300)}\n`),
    event('fail', 'TestSubs'),
    event('run', 'TestHangs'),
    event('fail', null),
    '',
  ].join('\n');

  test('names the failing tests, then the lines they printed, the first failing test first', () => {
    expect(failureExcerpt(failed(goTest, { stdout }))).toEqual([
      `${INDENT}2 failing test(s):`,
      `${INDENT}  example.com/a TestAdds`,
      `${INDENT}  example.com/a TestSubs`,
      `${INDENT}    a_test.go:9: got 3, want 4`,
      `${INDENT}--- FAIL: TestAdds (0.00s)`,
      `${INDENT}    a_test.go:20: ${'x'.repeat(EXCERPT_LINE_CHARS - 19)}…`,
      `${INDENT}1 still running when it stopped:`,
      `${INDENT}  example.com/a TestHangs`,
      `${INDENT}full output: .check/test.jsonl`,
    ]);
  });

  test('prints at most eight lines of test output, and its tests even where the reason line states the cause', () => {
    const noisy = Array.from({ length: 4 }, (_, t) => [
      event('run', `Test${t}`),
      ...Array.from({ length: 5 }, (_unused, i) => event('output', `Test${t}`, `    t${t} line ${i}\n`)),
      event('fail', `Test${t}`),
    ]).flat().join('\n');
    const printed = failureExcerpt(failed(goTest, { stdout: noisy }, { stated: true }));
    expect(printed.filter((line) => / t\d line /.test(line))).toEqual([
      ...[0, 1, 2, 3, 4].map((i) => `${INDENT}    t0 line ${i}`),
      ...[0, 1, 2].map((i) => `${INDENT}    t1 line ${i}`),
    ]);
    expect(printed.at(0)).toBe(`${INDENT}4 failing test(s):`);
    expect(printed.at(-1)).toBe(`${INDENT}full output: .check/test.jsonl`);
  });

  test('a run that names no test falls back to the line for a JSON report', () => {
    const passed = [event('run', 'TestAdds'), event('pass', 'TestAdds'), event('pass', null), ''].join('\n');
    expect(lines(failed(goTest, { stdout: passed }))).toEqual(['exit 1, no findings checkride can read in the JSON report', 'full output: .check/test.jsonl']);
  });
});

describe('failureExcerpt (what a tool printed is never trusted to be printable)', () => {
  const ESC = '\u001B';

  test('a finding’s path and rule lose their escape sequences and control characters, and stay on one line', () => {
    const stdout = JSON.stringify({
      diagnostics: [{
        filename: `src/${ESC}[31ma${ESC}[0m\n${ESC}[2Kb.ts\u0007`, code: `no-${ESC}[1mx${ESC}[0m\r\ny\u0000`, message: `${ESC}[1mbad${ESC}[0m\nsecond`,
        severity: 'error', labels: [{ span: { line: 1, column: 2 } }],
      }],
    });
    const printed = failureExcerpt(failed(oxlint, { stdout }));
    expect(printed).toEqual([`${INDENT}src/a b.ts:1:2  bad  [no-x y]`, `${INDENT}full output: .check/lint.json`]);
    // No line the excerpt prints holds an escape, a control character, or a break of its own.
    for (const line of printed) expect(line).not.toMatch(/[\p{Cc}]/u);
  });

  test('findingLine cleans every field it prints, the path and the rule as well as the message', () => {
    const dirty = { file: `${ESC}]0;title\u0007a.ts\nb`, line: 3, column: 7, rule: `${ESC}[31mno-x${ESC}[0m\nmore\t`, message: `${ESC}[1mbad${ESC}[0m\rnext`, key: 'k' };
    expect(findingLine(dirty)).toBe('a.ts b:3:7  bad  [no-x more]');
    // A message that is only escapes is no message, so the rule stands bare.
    expect(findingLine({ ...dirty, message: `${ESC}[0m` })).toBe('a.ts b:3:7  no-x more');
  });

  test('a vitest name and its error lose theirs', () => {
    const vitest = fakeAdapter({ name: 'vitest', slot: 'test' });
    const stderr = ` FAIL  src/a.test.ts > ${ESC}[31mred${ESC}[0m\u0007 name\t>\u0000 case\n${ESC}[1mError: boom${ESC}[0m\u0007\n`;
    const printed = failureExcerpt(failed(vitest, { stderr }));
    expect(printed).toEqual([`${INDENT}src/a.test.ts > red name  > case`, `${INDENT}  Error: boom`, `${INDENT}full output: .check/test.stderr.txt`]);
    for (const line of printed) expect(line).not.toMatch(/[\p{Cc}]/u);
  });

  test('a go test’s name loses its escape sequences and its line breaks, where it is named and where it still ran', () => {
    const goTest = fakeAdapter({ name: 'go-test', slot: 'test', outputFile: 'test.jsonl' });
    const bad = `Test${ESC}[31mBad${ESC}[0m\nName\u0007`;
    const hung = `Test${ESC}[2JHangs\r\nStill`;
    const stdout = [event('run', bad), event('output', bad, `    ${ESC}[31mgot 3${ESC}[0m\n`), event('fail', bad), event('run', hung), event('fail', null), ''].join('\n');
    const printed = failureExcerpt(failed(goTest, { stdout }));
    expect(printed).toEqual([
      `${INDENT}1 failing test(s):`,
      `${INDENT}  example.com/a TestBad Name`,
      `${INDENT}    got 3`,
      `${INDENT}1 still running when it stopped:`,
      `${INDENT}  example.com/a TestHangs Still`,
      `${INDENT}full output: .check/test.jsonl`,
    ]);
    for (const line of printed) expect(line).not.toMatch(/[\p{Cc}]/u);
  });

  test('the pointer is one printable line, whatever the output directory or the check is named', () => {
    const printed = failureExcerpt(failed(custom, { stderr: 'boom\n' }, { label: `/tmp/${ESC}[31mout${ESC}[0m\ndir`, entry: { name: `deploy${ESC}[0m` } }));
    expect(printed.at(-1)).toBe(`${INDENT}full output: /tmp/out dir/deploy.stderr.txt`);
  });
});

describe('plain and visibleKey (the lines the report printed before any excerpt)', () => {
  test('plain drops escape sequences and control characters, and nothing else', () => {
    expect(plain('\u001B[31m  a\tb  \u001B[0m\u0007 c \n d\u0000')).toBe('  a\tb   c \n d');
    expect(plain(' untouched  spacing ')).toBe(' untouched  spacing ');
  });

  test('visibleKey leaves a printable key exactly as it is', () => {
    for (const key of ['src/a.ts:no-x:bad', ' src/b  c.ts : rule :  spaced  ', 'ünïcode/文件.ts:règle:message 😀', String.raw`back\slash:"quoted":x`]) {
      expect(visibleKey(key)).toBe(key);
    }
  });

  test('visibleKey writes each control character as JSON does, so nothing is acted on or lost', () => {
    expect(visibleKey('a\u001B[31mb\nc\td\u0007e\u007Ff\u0085g')).toBe(String.raw`a\u001b[31mb\nc\td\u0007e\u007ff\u0085g`);
    expect(visibleKey('a\u001B[31mb\nc')).not.toMatch(/\p{Cc}/u);
  });
});

describe('shownOf (the one decision the excerpt and the annotations share)', () => {
  const vitest = fakeAdapter({ name: 'vitest', slot: 'test' });

  test('names what a failure shows, first that applies', () => {
    expect(shownOf(failed(custom, {})).kind).toBe('uncaptured');
    expect(shownOf(failed(custom, {}, { stated: true })).kind).toBe('stated');
    expect(shownOf(failed(oxlint, { stdout: report(2) }, { stated: true })).kind).toBe('stated');
    expect(shownOf(failed(vitest, { stderr: ' FAIL  a.test.ts > one\nError: boom\n' })).kind).toBe('vitest');
    expect(shownOf(failed(oxlint, { stdout: report(2) })).kind).toBe('findings');
    expect(shownOf(failed(custom, { stderr: 'boom\n' })).kind).toBe('output');
  });

  test('the excerpt formats what it is handed, so a check is read once', () => {
    const failure = failed(oxlint, { stdout: report(2) });
    const shown = shownOf(failure);
    expect(failureExcerpt(failure, shown)).toEqual(failureExcerpt(failure));
    // Handed another failure's reading, it prints that one's findings: nothing is read again.
    expect(failureExcerpt(failed(oxlint, { stdout: report(1) }), shown)).toEqual(failureExcerpt(failure));
  });

  test('a vitest run of projects gives each test its file after the project, and keeps the whole name', () => {
    const shown = shownOf(failed(vitest, { stderr: ' FAIL  |unit| src/a.test.ts > one\nError: boom\n\n FAIL  |web app| src/b.test.ts [ src/b.test.ts ]\nError: bang\n\n FAIL  src/c.test.ts > |not a project| > x\nError: pow\n' }));
    expect(shown).toEqual({
      kind: 'vitest',
      tests: [
        { name: '|unit| src/a.test.ts > one', error: 'Error: boom', file: 'src/a.test.ts' },
        { name: '|web app| src/b.test.ts [ src/b.test.ts ]', error: 'Error: bang', file: 'src/b.test.ts' },
        { name: 'src/c.test.ts > |not a project| > x', error: 'Error: pow', file: 'src/c.test.ts' },
      ],
    });
  });
});

describe('failureExcerpt (a check whose cause is already stated)', () => {
  test('prints the pointer alone, whatever its output holds', () => {
    expect(lines(failed(oxlint, { stdout: report(3) }, { stated: true }))).toEqual(['full output: .check/lint.json']);
    expect(lines(failed(custom, { stdout: 'partial\n', stderr: 'timed out after 60s\n' }, { stated: true }))).toEqual(['full output: .check/deploy.stdout.txt']);
    expect(lines(failed(custom, { stderr: 'checkride: oxlint is not installed\n' }, { stated: true }))).toEqual(['full output: .check/deploy.stderr.txt']);
  });

  test('prints nothing when it captured nothing', () => {
    expect(failureExcerpt(failed(custom, {}, { stated: true }))).toEqual([]);
  });
});

describe('failureExcerpt (where the pointer leads)', () => {
  test("a target's check points under its <target>/ directory, with its paths from the repo root", () => {
    const entry = { name: 'api:lint', target: 'api', slot: 'lint', output_file: 'api/lint.json' };
    const failure = failed(oxlint, { stdout: report(1) }, { entry });
    expect(lines({ ...failure, run: { ...failure.run, name: 'api:lint', root: 'apps/api' } })).toEqual([
      'apps/api/f1.ts:1:7  bad 1  [no-1]',
      'full output: .check/api/lint.json',
    ]);
    const text = failed(custom, { stderr: 'boom\n' }, { entry: { name: 'api:deploy', target: 'api', slot: 'deploy' } });
    expect(lines(text)).toEqual(['boom', 'full output: .check/api/deploy.stderr.txt']);
  });

  test("a named suite's check points into the suite's output directory", () => {
    const label = '.check/suites/evals';
    expect(lines(failed(oxlint, { stdout: report(1) }, { label })).at(-1)).toBe('full output: .check/suites/evals/lint.json');
    expect(lines(failed(custom, { stdout: 'boom\n' }, { label })).at(-1)).toBe('full output: .check/suites/evals/deploy.stdout.txt');
  });

  test('an output directory outside the repo is named as the run names it', () => {
    expect(lines(failed(custom, { stderr: 'boom\n' }, { label: '/tmp/out' })).at(-1)).toBe('full output: /tmp/out/deploy.stderr.txt');
  });
});

describe('findingLine', () => {
  const finding = { file: 'a.ts', line: 3, column: 7, rule: 'no-x', message: 'bad', key: 'a.ts:no-x:bad' };

  test('leaves out what the tool did not give', () => {
    expect(findingLine(finding)).toBe('a.ts:3:7  bad  [no-x]');
    // A column says where on the line, so it's kept whenever the tool gave one, and never without a line.
    expect(findingLine({ file: 'a.ts', line: 3, rule: 'no-x', message: 'bad', key: 'k' })).toBe('a.ts:3  bad  [no-x]');
    expect(findingLine({ file: 'a.ts', column: 7, rule: 'no-x', message: 'bad', key: 'k' })).toBe('a.ts  bad  [no-x]');
    expect(findingLine({ file: 'a.ts', rule: 'no-x', message: 'bad', key: 'k' })).toBe('a.ts  bad  [no-x]');
    expect(findingLine({ ...finding, rule: '' })).toBe('a.ts:3:7  bad');
    expect(findingLine({ ...finding, file: '' })).toBe('bad  [no-x]');
  });

  test('a finding with no message names its rule bare, as fallow’s unused file does', () => {
    expect(findingLine({ file: 'src/unused.ts', rule: 'unused_files', message: '', key: 'k' })).toBe('src/unused.ts  unused_files');
  });

  test('shows the first line of a message, without its escape sequences', () => {
    expect(findingLine({ ...finding, message: '\u001B[1mbad\u001B[0m\nsecond line' })).toBe('a.ts:3:7  bad  [no-x]');
  });

  test('cuts at 200 characters, and never splits a character that takes two UTF-16 units', () => {
    expect(findingLine({ ...finding, message: 'x'.repeat(300) })).toBe(`a.ts:3:7  ${'x'.repeat(EXCERPT_LINE_CHARS - 11)}…`);
    // "a.ts:3:7  " is 10 units, so the emoji's first unit lands on the 199th, the last kept before `…`.
    expect(findingLine({ ...finding, message: `${'x'.repeat(188)}😀${'x'.repeat(50)}` })).toBe(`a.ts:3:7  ${'x'.repeat(188)}…`);
  });
});
