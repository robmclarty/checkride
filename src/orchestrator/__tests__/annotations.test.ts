/**
 * A run that writes annotations, through an injected runner: they land on
 * stderr below the report and footer, beside `--json` too, a green run
 * writes none, and nothing else about the run changes. Their paths are named
 * from the git top level, which the last tests here check in a real work
 * tree.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import type { Baseline } from '../../baseline/index.js';
import type { CheckrideConfig } from '../../config.js';
import { suiteNamed } from '../../suite.js';
import type { CheckRunner, Out, RunOptions, RunResult, Summary } from '../index.js';
import { runChecks } from '../index.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

type Finding = [file: string, code: string, message: string];

/** An oxlint `--format=json` payload with one error per finding, the nth on line n. */
function oxlint(findings: readonly Finding[]): string {
  return JSON.stringify({
    diagnostics: findings.map(([filename, code, message], i) => ({ filename, code, message, severity: 'error', labels: [{ span: { line: i + 1, column: 2 } }] })),
  });
}

const A: Finding = ['src/a.ts', 'no-x', 'bad'];
const B: Finding = ['src/b.ts', 'no-y', 'worse'];
const LINE_A = '::error file=src/a.ts,line=1,col=2,title=lint%3A no-x::bad';
const LINE_B = '::error file=src/b.ts,line=2,col=2,title=lint%3A no-y::worse';

/** What each check of a run prints, by slot: lint's findings, and any other slot's outcome as given. */
function runner(lint: readonly Finding[], others: Record<string, Awaited<ReturnType<CheckRunner>>> = {}): CheckRunner {
  return (r) => Promise.resolve(others[r.slot] ?? { ok: lint.length === 0, exit_code: lint.length === 0 ? 0 : 1, stdout: oxlint(lint), stderr: '' });
}

/** Write an empty file at each of `paths` under `dir`: an annotation names a file only where one is on disk. */
async function touch(dir: string, ...paths: string[]): Promise<void> {
  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of small files, written in turn.
    await mkdir(dirname(join(dir, path)), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- as above.
    await writeFile(join(dir, path), '');
  }
}

/** `count` findings, the nth in `src/f<n>.ts`. */
function many(count: number): Finding[] {
  return Array.from({ length: count }, (_, i): Finding => [`src/f${i}.ts`, 'no-x', `bad ${i}`]);
}

/** The annotation lines in what a run wrote to stderr. */
function annotations(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('::'));
}

/** A summary without the two fields that differ between any two runs. */
function stable(summary: Summary): unknown {
  return { ...summary, timestamp: '', total_duration_ms: 0, checks: summary.checks.map((c) => ({ ...c, duration_ms: 0 })) };
}

/** A run's report with every duration the same, so two runs' can be compared. */
function durations(text: string): string {
  return text.replaceAll(/\d+ms/g, 'Nms');
}

/** The annotations a `--only lint` run from `cwd` writes. */
async function annotated(cwd: string, over: Partial<RunOptions>): Promise<string[]> {
  const stderr = sink();
  await runChecks({ cwd, baseline: null, stdout: sink().out, stderr: stderr.out, annotate: 'github', only: ['lint'], ...over });
  return annotations(stderr.text());
}

const slots = [{ name: 'lint' }];
const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' })];
/** A catalogue with a test slot the vitest adapter fills, for the runs that fail tests. */
const withTests = { slots: [...slots, { name: 'test' }], adapters: [...adapters, fakeAdapter({ name: 'vitest', slot: 'test' })] };
const config: CheckrideConfig = { checks: { lint: 'oxlint', deploy: { command: 'node', args: ['deploy.mjs'] } } };
const PASSED = { ok: true, exit_code: 0, stdout: '', stderr: '' };

describe('runChecks with annotate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-annotate-'));
    await touch(dir, 'src/a.ts', 'src/b.ts', ...many(12).map(([file]) => file));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function run(over: Partial<RunOptions>): Promise<{ result: RunResult; stdout: string; stderr: string }> {
    const stdout = sink();
    const stderr = sink();
    const result = await runChecks({ cwd: dir, slots, adapters, config, baseline: null, stdout: stdout.out, stderr: stderr.out, ...over });
    return { result, stdout: stdout.text(), stderr: stderr.text() };
  }

  test('a run that wasn’t asked writes none, and one that was writes them last, below the report and footer', async () => {
    const plain = await run({ runner: runner([A, B], { deploy: PASSED }) });
    expect(annotations(plain.stderr)).toEqual([]);

    const asked = await run({ runner: runner([A, B], { deploy: PASSED }), annotate: 'github' });
    expect(annotations(asked.stderr)).toEqual([LINE_A, LINE_B]);
    expect(asked.stderr.endsWith(`report: .check/summary.json\n\n${LINE_A}\n${LINE_B}\n`)).toBe(true);
    const before = asked.stderr.slice(0, asked.stderr.indexOf('::error'));
    expect(before).toContain('✘ one or more checks failed');
    expect(before).toContain('src/a.ts:1:2  bad  [no-x]');
  });

  test('under --digest they come after the footer and before the digest, which stays the last thing printed', async () => {
    const { stderr } = await run({ runner: runner([A, B], { deploy: PASSED }), annotate: 'github', digest: true });
    const digest = await readFile(join(dir, '.check', 'digest.md'), 'utf8');
    expect(stderr.endsWith(`report: .check/summary.json\ndigest: .check/digest.md\n\n${LINE_A}\n${LINE_B}\n\n${digest}\n`)).toBe(true);
    // The digest's own text holds no annotation, so the two lines above it are the only ones.
    expect(annotations(stderr)).toEqual([LINE_A, LINE_B]);
  });

  test('a notice beneath the footer comes before them too', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '{ not json');
    // No baseline is handed in, so the run reads the file.
    const out = sink();
    await runChecks({ cwd: dir, slots, adapters, config, stdout: sink().out, stderr: out.out, runner: runner([A], { deploy: PASSED }), annotate: 'github', digest: true });
    const stderr = out.text();
    const notice = stderr.indexOf('checkride.baseline.json is present but unparseable');
    expect(notice).toBeGreaterThan(stderr.indexOf('digest: .check/digest.md'));
    expect(stderr.indexOf(LINE_A)).toBeGreaterThan(notice);
    expect(stderr.indexOf('# ', stderr.indexOf(LINE_A))).toBeGreaterThan(stderr.indexOf(LINE_A));
  });

  test('nothing else about the run changes: the same exit code, summary, digest and report', async () => {
    const failing = runner([A], { deploy: { ok: false, exit_code: 3, stdout: '', stderr: 'boom\n' } });
    // One check at a time, so both runs print their status lines in one order.
    const plain = await run({ runner: failing, digest: true, concurrency: 1 });
    const plainDigest = await readFile(join(dir, '.check', 'digest.md'), 'utf8');
    const asked = await run({ runner: failing, digest: true, concurrency: 1, annotate: 'github' });
    expect(asked.result.exitCode).toBe(plain.result.exitCode);
    expect(stable(asked.result.summary)).toEqual(stable(plain.result.summary));
    expect(await readFile(join(dir, '.check', 'digest.md'), 'utf8')).toBe(plainDigest);
    // The report is the plain run's, with the annotations, and the blank line that sets the digest off from them, taken out.
    const report = asked.stderr.replace(/(?:^::.*\n)+\n/m, '');
    expect(durations(report)).toBe(durations(plain.stderr));
    expect(annotations(asked.stderr)).toEqual([LINE_A, '::error title=deploy::boom']);
  });

  test('a green run writes nothing', async () => {
    const { result, stderr } = await run({ runner: runner([], { deploy: PASSED }), annotate: 'github' });
    expect(result.exitCode).toBe(0);
    expect(stderr).not.toContain('::');
  });

  test('under --json, stdout is the summary alone and stderr the annotations alone', async () => {
    const { result, stdout, stderr } = await run({ runner: runner([A, B], { deploy: PASSED }), annotate: 'github', json: true });
    expect(result.exitCode).toBe(1);
    expect((JSON.parse(stdout) as Summary).ok).toBe(false);
    expect(stdout).not.toContain('::error');
    expect(stderr).toBe(`${LINE_A}\n${LINE_B}\n`);
  });

  test('--strict’s line on a run of zero checks comes before them, and there are none to write', async () => {
    const { result, stderr } = await run({ runner: runner([]), annotate: 'github', strict: true, config: { checks: { lint: false } } });
    expect(result.exitCode).toBe(2);
    expect(annotations(stderr)).toEqual([]);
  });

  test('a baseline that masks some leaves only the new findings annotated', async () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['src/a.ts:no-x:bad'] } };
    const { stderr } = await run({ runner: runner([A, B], { deploy: PASSED }), annotate: 'github', baseline, only: ['lint'] });
    expect(stderr).toContain('1 baselined (grandfathered)');
    expect(annotations(stderr)).toEqual([LINE_B]);
  });

  test('a key found more often than the baseline grandfathers is one annotation, on its first occurrence, with both counts', async () => {
    const again: Finding = ['src/a.ts', 'no-x', 'bad'];
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['src/a.ts:no-x:bad'] }, counts: { lint: { 'src/a.ts:no-x:bad': 3 } } };
    const { stderr } = await run({ runner: runner([A, again, B, again, again], { deploy: PASSED }), annotate: 'github', baseline, only: ['lint'] });
    expect(stderr).toContain('src/a.ts:no-x:bad (4 found, 3 grandfathered)');
    expect(annotations(stderr)).toEqual([
      '::error file=src/a.ts,line=1,col=2,title=lint%3A no-x::bad (4 found, 3 grandfathered)',
      '::error file=src/b.ts,line=3,col=2,title=lint%3A no-y::worse',
    ]);
  });

  test('a finding in a file that isn’t on disk, and a line of 0, keep the annotation and lose the property', async () => {
    const stdout = JSON.stringify({
      diagnostics: [
        { filename: 'lodash', code: 'unused-dependency', message: 'never imported', severity: 'error', labels: [{ span: { line: 1, column: 1 } }] },
        { filename: 'src', code: 'no-dir', message: 'a directory', severity: 'error', labels: [{ span: { line: 1, column: 1 } }] },
        { filename: 'src/a.ts', code: 'no-x', message: 'whole file', severity: 'error', labels: [{ span: { line: 0, column: 0 } }] },
        { filename: 'src/a.ts', code: 'no-y', message: 'no column', severity: 'error', labels: [{ span: { line: 4, column: 0 } }] },
      ],
    });
    const { stderr } = await run({ runner: runner([], { lint: { ok: false, exit_code: 1, stdout, stderr: '' }, deploy: PASSED }), annotate: 'github' });
    expect(annotations(stderr)).toEqual([
      '::error title=lint%3A unused-dependency::never imported',
      '::error title=lint%3A no-dir::a directory',
      '::error file=src/a.ts,title=lint%3A no-x::whole file',
      '::error file=src/a.ts,line=4,title=lint%3A no-y::no column',
    ]);
  });

  test('a baseline that masks every finding leaves the check green and unannotated', async () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['src/a.ts:no-x:bad'] } };
    const { result, stderr } = await run({ runner: runner([A], { deploy: PASSED }), annotate: 'github', baseline, only: ['lint'] });
    expect(result.exitCode).toBe(0);
    expect(annotations(stderr)).toEqual([]);
  });

  test('a check that timed out is one annotation naming it, not its partial findings', async () => {
    const timedOut = { ok: false, exit_code: -1, stdout: oxlint([A]), stderr: 'timed out after 5s\n' };
    const { stderr } = await run({ runner: runner([], { lint: timedOut, deploy: PASSED }), annotate: 'github' });
    expect(annotations(stderr)).toEqual(['::error title=lint::timed out after 5s']);
  });

  test('a check refused before its tool ran is one annotation holding the refusal', async () => {
    const refused = { ok: false, exit_code: -1, stdout: '', stderr: '', refusal: 'requirePins: node resolves from PATH with no pin' };
    const { stderr } = await run({ runner: runner([], { deploy: refused }), annotate: 'github' });
    expect(annotations(stderr)).toEqual(['::error title=deploy::requirePins: node resolves from PATH with no pin']);
  });

  test('a failing vitest run is one annotation per test, with the file where its name gives a real one', async () => {
    await touch(dir, 'src/sum.test.ts');
    const failed = {
      ok: false, exit_code: 1, stdout: '',
      stderr: [' FAIL  src/sum.test.ts > sum > adds', 'AssertionError: expected 3 to be 4', '', ' FAIL  src/gone.test.ts > gone', 'Error: boom', ''].join('\n'),
    };
    const { stderr } = await run({ runner: runner([], { test: failed }), annotate: 'github', ...withTests, config: { checks: { test: 'vitest' } } });
    expect(annotations(stderr)).toEqual([
      '::error file=src/sum.test.ts,title=test%3A src/sum.test.ts > sum > adds::AssertionError: expected 3 to be 4',
      '::error title=test%3A src/gone.test.ts > gone::Error: boom',
    ]);
  });

  test('past ten, the first ten in the run’s order and one notice naming the summary', async () => {
    const { stderr } = await run({ runner: runner(many(12), { deploy: { ok: false, exit_code: 1, stdout: '', stderr: 'boom\n' } }), annotate: 'github' });
    const lines = annotations(stderr);
    expect(lines).toHaveLength(11);
    expect(lines.slice(0, 10).every((line) => line.startsWith('::error '))).toBe(true);
    expect(lines[10]).toBe('::notice title=checkride::3 more finding(s) not annotated; see .check/summary.json');
  });

  test('a named suite’s run annotates its own checks and names its own summary', async () => {
    const { result, stderr } = await run({ runner: runner(many(11)), annotate: 'github', suite: suiteNamed('evals'), config: { checks: { lint: 'oxlint' } } });
    expect(result.summary.suite).toBe('evals');
    const lines = annotations(stderr);
    expect(lines[0]).toBe('::error file=src/f0.ts,line=1,col=2,title=lint%3A no-x::bad 0');
    expect(lines.at(-1)).toBe('::notice title=checkride::1 more finding(s) not annotated; see .check/suites/evals/summary.json');
  });
});

/** Is a real git usable here? The real-repository cases skip without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('annotation paths in a real work tree', () => {
  let top: string;
  beforeEach(async () => {
    top = await mkdtemp(join(tmpdir(), 'checkride-annotate-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: top, stdio: 'pipe' });
  });
  afterEach(async () => { await rm(top, { recursive: true, force: true }); });

  const targets: CheckrideConfig = { targets: { web: { lang: 'ts', root: 'apps/web', checks: { lint: 'oxlint' } } } };

  test('a target’s finding is named from the repo root, under the name the run prints', async () => {
    await touch(top, 'apps/web/src/a.ts');
    expect(await annotated(top, { config: targets, runner: runner([A]) })).toEqual(['::error file=apps/web/src/a.ts,line=1,col=2,title=web%3Alint%3A no-x::bad']);
  });

  test('a run from a subdirectory of the top level names its paths from the top', async () => {
    const cwd = join(top, 'services/api');
    await touch(cwd, 'apps/web/src/a.ts');
    await touch(top, 'services/shared/a.ts');
    expect(await annotated(cwd, { config: targets, runner: runner([A]) })).toEqual([
      '::error file=services/api/apps/web/src/a.ts,line=1,col=2,title=web%3Alint%3A no-x::bad',
    ]);
    // A path above the run's directory is still inside the repository; one above the top level is not.
    const up: Finding[] = [['../shared/a.ts', 'no-x', 'in the repo'], ['../../../elsewhere/a.ts', 'no-y', 'outside it']];
    expect(await annotated(cwd, { slots, adapters, config, runner: runner(up) })).toEqual([
      '::error file=services/shared/a.ts,line=1,col=2,title=lint%3A no-x::in the repo',
      '::error title=lint%3A no-y::outside it',
    ]);
  });

  test('a run started through a symlink to a directory of the work tree names its paths from the real top', async () => {
    await touch(top, 'services/api/src/a.ts');
    const link = join(await mkdtemp(join(tmpdir(), 'checkride-annotate-link-')), 'api');
    await symlink(join(top, 'services/api'), link);
    try {
      expect(await annotated(link, { slots, adapters, config, runner: runner([A]) })).toEqual([
        '::error file=services/api/src/a.ts,line=1,col=2,title=lint%3A no-x::bad',
      ]);
      // A path the tool printed absolute, through the link, lands on the same file.
      expect(await annotated(link, { slots, adapters, config, runner: runner([[join(link, 'src/a.ts'), 'no-x', 'bad']]) })).toEqual([
        '::error file=services/api/src/a.ts,line=1,col=2,title=lint%3A no-x::bad',
      ]);
    } finally {
      await rm(dirname(link), { recursive: true, force: true });
    }
  });
});

describe('annotation paths outside a git repository', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-annotate-bare-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('the run’s directory stands in for the top level', async () => {
    const stderr = sink();
    await touch(dir, 'src/a.ts');
    const found: Finding[] = [A, ['../up.ts', 'no-y', 'above']];
    await runChecks({ cwd: dir, slots, adapters, config, baseline: null, stdout: sink().out, stderr: stderr.out, annotate: 'github', only: ['lint'], runner: runner(found) });
    expect(annotations(stderr.text())).toEqual([LINE_A, '::error title=lint%3A no-y::above']);
  });
});

describe('the lines beneath a red status line (a tool’s own text)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-printable-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baseline: Baseline = { schema_version: 1, slots: { lint: ['src/a.ts:no-x:bad'] } };

  async function printed(over: Partial<RunOptions>): Promise<string> {
    const stderr = sink();
    await runChecks({ cwd: dir, slots, adapters, config, baseline, stdout: sink().out, stderr: stderr.out, ...over });
    return stderr.text();
  }

  test('a reason line loses its escape sequences and control characters, and nothing else', async () => {
    const timedOut = { ok: false, exit_code: -1, stdout: '', stderr: '\u001B[31mtimed\tout\u001B[0m  after 5s\u0007\n' };
    const text = await printed({ runner: runner([], { deploy: timedOut }) });
    // Its tab and its doubled space are as the tool printed them.
    expect(text).toContain('           timed\tout  after 5s\n');
    expect(text).not.toMatch(/[^\P{Cc}\n\t]/u);
  });

  test('a new key keeps every printable character, spacing included, so it matches the baseline file', async () => {
    // The parser has already collapsed the message's whitespace into the key; the report adds nothing to that.
    const spaced: Finding = ['src/b  c.ts ', ' no-y', 'worse   than  before'];
    const text = await printed({ runner: runner([A, spaced], { deploy: PASSED }) });
    expect(text).toContain('             src/b  c.ts : no-y:worse than before\n');
  });

  test('a control character in a key is printed as the baseline file’s JSON writes it, never acted on or dropped', async () => {
    const dirty: Finding = ['src/\u001B[31mb\u001B[0m\t.ts', 'no-\u0007y', 'here\u007F'];
    const text = await printed({ runner: runner([A, dirty], { deploy: PASSED }) });
    expect(text).toContain(`${String.raw`             src/\u001b[31mb\u001b[0m\t.ts:no-\u0007y:here\u007f`}\n`);
    expect(text).not.toMatch(/[^\P{Cc}\n]/u);
    // The printed key is the text between the quotes of the key a capture would write.
    const key = 'src/\u001B[31mb\u001B[0m\t.ts:no-\u0007y:here\u007F';
    expect(JSON.parse(String.raw`"src/\u001b[31mb\u001b[0m\t.ts:no-\u0007y:here\u007f"`)).toBe(key);
  });
});
