/**
 * A run's GitHub step summary: the format the flag and variable name, the
 * keys counted against the base through an injected git, the table drawn
 * from a summary, and the append with its two warnings.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { writeBaseline } from '../../baseline/index.js';
import type { GitResult, GitRunner } from '../../git.js';
import type { Summary, SummaryCheck } from '../index.js';
import type { BaseKeys } from '../step-summary.js';
import { baseKeysOf, stepSummaryFormat, stepSummaryText, SUMMARY_ENV, writeStepSummary } from '../step-summary.js';

const SHA = 'c'.repeat(40);

/** A git that resolves every ref to {@link SHA} and holds `committed` as the baseline there, or no file when it's `null`. */
function fakeGit(committed: string | null, fail?: GitResult): GitRunner {
  return (args) => {
    if (fail !== undefined) return Promise.resolve(fail);
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return Promise.resolve({ ok: true, stdout: '/repo\n\nfalse\n' });
    if (args[0] === 'rev-parse') return Promise.resolve({ ok: true, stdout: `${SHA}\n` });
    if (args[0] === 'ls-tree') return Promise.resolve({ ok: true, stdout: committed === null ? '' : `${args[5] ?? ''}\n` });
    return Promise.resolve({ ok: true, stdout: committed ?? '' });
  };
}

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

const check = (over: Partial<SummaryCheck> & { name: string }): SummaryCheck => ({
  adapter: null, description: over.name, ok: true, exit_code: 0, duration_ms: 1234, output_file: null, ...over,
});

const summaryOf = (checks: SummaryCheck[], over: Partial<Summary> = {}): Summary => ({
  schema_version: 1, timestamp: '2026-11-13T00:00:00.000Z', ok: checks.every((c) => c.ok), checks_run: checks.length,
  total_duration_ms: 4567, run: { partial: false }, checks, ...over,
});

const READ: BaseKeys = { ok: true, ref: 'origin/main', sha: SHA, added: { lint: ['x', 'y'] }, removed: { struct: ['z'] } };

describe('stepSummaryFormat', () => {
  test('github is the one format, nothing asked is none, and any other value names what asked for it', () => {
    expect(stepSummaryFormat({ value: 'github', from: '--summary' })).toBe('github');
    expect(stepSummaryFormat(null)).toBeNull();
    expect(() => stepSummaryFormat({ value: 'gitlab', from: SUMMARY_ENV })).toThrow("invalid CHECKRIDE_SUMMARY 'gitlab' (expected github)");
  });
});

describe('stepSummaryText', () => {
  test('a green run: the heading, the verdict, the base, a row per check, and the skipped named once', () => {
    const text = stepSummaryText(summaryOf([check({ name: 'lint' }), check({ name: 'struct', duration_ms: 40 }), check({ name: 'types', skipped: true })]), READ);
    expect(text).toBe([
      '### checkride: default suite',
      '',
      '**✔ passed**: 2 check(s) ran in 4.6s',
      '',
      'Baseline against `origin/main` (ccccccc): 2 key(s) added, 1 removed.',
      '',
      '| Check | Status | Time | New findings | Keys added | Keys removed |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      '| `lint` | ✔ pass | 1.2s | 0 | 2 | 0 |',
      '| `struct` | ✔ pass | 40ms | 0 | 0 | 1 |',
      '',
      'Skipped: `types`.',
      '',
      '',
    ].join('\n'));
  });

  test('a red run counts its failures, a check a baseline masked shows its new findings, and one no baseline masked shows none counted', () => {
    const text = stepSummaryText(summaryOf([check({ name: 'lint', ok: false, new_count: 3 }), check({ name: 'deploy', ok: false })], { suite: 'evals', run: { partial: true } }), READ);
    expect(text).toContain('### checkride: suite evals\n');
    expect(text).toContain('**✘ failed**: 2 of 2 check(s) failed in 4.6s, a partial run\n');
    expect(text).toContain('| `lint` | ✘ fail | 1.2s | 3 | 2 | 0 |');
    expect(text).toContain('| `deploy` | ✘ fail | 1.2s | - | 0 | 0 |');
    expect(text).not.toContain('Skipped');
  });

  test('a base that can’t be read drops the two key columns and says why', () => {
    const text = stepSummaryText(summaryOf([check({ name: 'lint' })]), { ok: false, ref: 'origin/main', why: 'no such ref' });
    expect(text).toContain("Baseline keys not counted: the base `origin/main` can't be read (no such ref).\n");
    expect(text).toContain('| Check | Status | Time | New findings |\n| --- | --- | ---: | ---: |\n| `lint` | ✔ pass | 1.2s | 0 |\n');
  });
});

describe('baseKeysOf', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-step-summary-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('counts the keys added and removed per check against the base', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a', 'c'] } });
    const keys = await baseKeysOf(fakeGit(JSON.stringify({ schema_version: 1, slots: { lint: ['a', 'b'] } })), dir, 'origin/main', 'checkride.baseline.json');
    expect(keys).toEqual({ ok: true, ref: 'origin/main', sha: SHA, added: { lint: ['c'] }, removed: { lint: ['b'] } });
  });

  test('a base with no file and a working tree with none read as empty', async () => {
    expect(await baseKeysOf(fakeGit(null), dir, 'HEAD', 'checkride.baseline.json')).toMatchObject({ ok: true, added: {}, removed: {} });
  });

  test('a git that fails is the reason, not a throw, with the diff command’s prefix dropped', async () => {
    const keys = await baseKeysOf(fakeGit(null, { ok: false, error: 'missing', detail: 'git not found on PATH' }), dir, 'HEAD', 'checkride.baseline.json');
    expect(keys).toEqual({ ok: false, ref: 'HEAD', why: 'git is required but was not found on PATH' });
  });

  test('a working-tree file that can’t be parsed is the reason', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{');
    expect(await baseKeysOf(fakeGit(null), dir, 'HEAD', 'checkride.baseline.json')).toEqual({ ok: false, ref: 'HEAD', why: "checkride.baseline.json in the working tree can't be parsed" });
  });
});

describe('writeStepSummary', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-step-summary-write-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const scope = (stderr: { write: (t: string) => boolean }): Parameters<typeof writeStepSummary>[2] => ({
    cwd: dir, baselineFile: 'checkride.baseline.json', baseRef: 'HEAD', git: fakeGit(null), stderr,
  });

  test('appends to the file, so a second table lands beneath the first', async () => {
    const file = join(dir, 'summary.md');
    await writeFile(file, 'earlier step\n');
    const err = capture();
    await writeStepSummary({ format: 'github', file }, summaryOf([check({ name: 'lint' })]), scope(err));
    await writeStepSummary({ format: 'github', file }, summaryOf([check({ name: 'lint' })]), scope(err));
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('earlier step\n### checkride: default suite\n')).toBe(true);
    expect(text.split('### checkride').length).toBe(3);
    expect(err.text()).toBe('');
  });

  test('no file named warns and writes nothing', async () => {
    const err = capture();
    await writeStepSummary({ format: 'github', file: null }, summaryOf([]), scope(err));
    expect(err.text()).toBe('--summary github: GITHUB_STEP_SUMMARY is not set, so no step summary is written\n');
  });

  test('a file that can’t be written warns, and nothing throws', async () => {
    const err = capture();
    await writeStepSummary({ format: 'github', file: join(dir, 'missing', 'summary.md') }, summaryOf([]), scope(err));
    expect(err.text()).toMatch(/^--summary github: can't append to .*summary\.md \(ENOENT/);
  });
});
