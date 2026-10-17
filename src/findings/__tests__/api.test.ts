/**
 * `checkride/findings` (R12.1): `parseFindings` over raw text, `findingsFor`
 * over a run directory, and `isParseable`. Each finding carries its adapter
 * and slot, 1-based positions, verbatim severity and `gates` per R12.3, with
 * paths rebased per R12.4.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { FindingsCheck } from '../api.js';
import { findingsFor, isParseable, parseFindings } from '../api.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const read = (name: string): Promise<string> => readFile(join(FIXTURES, name), 'utf8');

/** An oxlint report with one error diagnostic on `filename`. */
function oxlintOn(filename: string): string {
  return JSON.stringify({ diagnostics: [{ filename, code: 'eslint(x)', message: 'm', severity: 'error' }] });
}

/** The file one oxlint finding on `file` names, run from `apps/web`, with `repoRoot` when given. */
function rebased(file: string, repoRoot?: string): string | undefined {
  return parseFindings('oxlint', oxlintOn(file), { root: 'apps/web', ...(repoRoot !== undefined ? { repoRoot } : {}) })?.[0]?.file;
}

/** A summary entry for `adapter`, named `name`, with the fields a run records. */
function entry(name: string, adapter: string | null, extra: Partial<FindingsCheck> = {}): FindingsCheck {
  return { name, adapter, output_file: null, ...extra };
}

describe('isParseable', () => {
  test('names the adapters with a parser, and no others', () => {
    const parseable = ['oxlint', 'ast-grep', 'cspell', 'vale', 'fallow', 'golangci-lint', 'staticcheck', 'clippy', 'cargo-check', 'shellcheck'];
    for (const adapter of parseable) expect(isParseable(adapter), adapter).toBe(true);
    for (const adapter of ['tsc', 'vitest', 'knip', 'biome', 'constructor']) expect(isParseable(adapter), adapter).toBe(false);
  });
});

describe('parseFindings', () => {
  test('an adapter with no parser returns null (F45)', () => {
    expect(parseFindings('tsc', 'src/a.ts(1,1): error TS2322: nope')).toBeNull();
    expect(parseFindings('knip', '[]')).toBeNull();
  });

  test("an oxlint finding carries its adapter, slot, position and severity, and gates under the registry's args", async () => {
    const findings = parseFindings('oxlint', await read('baseline-oxlint.json'));
    expect(findings).toHaveLength(4);
    expect(findings?.find((f) => f.gates)).toEqual({
      adapter: 'oxlint',
      slot: 'lint',
      file: 'src/config.ts',
      line: 12,
      column: 9,
      rule: 'typescript(no-unused-vars)',
      message: 'Variable is assigned a value but never used.',
      severity: 'error',
      gates: true,
    });
    expect(findings?.filter((f) => f.gates === false).map((f) => f.severity)).toEqual(['warning', 'warning', 'warning']);
  });

  test('the argv that ran decides gates in place of the registry args', async () => {
    const raw = await read('baseline-oxlint.json');
    expect(parseFindings('oxlint', raw, { argv: ['oxlint', '--deny-warnings'] })?.every((f) => f.gates)).toBe(true);
  });

  test("fallow's slot comes from its report, and an explicit slot wins", async () => {
    const raw = await read('baseline-fallow-dupes.json');
    expect(parseFindings('fallow', raw)?.map((f) => f.slot)).toEqual(['dupes']);
    expect(parseFindings('fallow', raw, { slot: 'web:dupes' })?.map((f) => f.slot)).toEqual(['web:dupes']);
  });

  test('a clean run is an empty array, and output its parser can\'t trust is null', async () => {
    expect(parseFindings('oxlint', '{"diagnostics":[]}')).toEqual([]);
    expect(parseFindings('vale', await read('baseline-vale-error.json'))).toBeNull();
    expect(parseFindings('fallow', 'boom: fatal error')).toBeNull();
  });

  test('a tool-relative path joins the root, and a root of the repo normalizes it (R12.4)', () => {
    expect(parseFindings('oxlint', oxlintOn('./src/a.ts'), { root: '' })?.[0]?.file).toBe('src/a.ts');
    expect(parseFindings('oxlint', oxlintOn('src/a.ts'), { root: 'apps/web' })?.[0]?.file).toBe('apps/web/src/a.ts');
  });

  test('an absolute path inside repoRoot is made relative to it, and one outside, or without repoRoot, stays absolute', () => {
    expect(rebased('/repo/apps/web/src/a.ts', '/repo')).toBe('apps/web/src/a.ts');
    expect(rebased('/repo/apps/web/src/a.ts')).toBe('/repo/apps/web/src/a.ts');
    expect(rebased('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts');
    expect(rebased('/repo', '/repo')).toBe('/repo');
    expect(rebased('/repo-other/a.ts', '/repo')).toBe('/repo-other/a.ts');
  });

  test('a finding never carries its baseline key', async () => {
    for (const f of parseFindings('cspell', await read('baseline-cspell.txt')) ?? []) expect(f).not.toHaveProperty('key');
  });
});

describe('findingsFor', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-findings-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('opens the output_file the summary names', async () => {
    await writeFile(join(dir, 'lint.json'), await read('baseline-oxlint.json'));
    const findings = findingsFor(entry('lint', 'oxlint', { output_file: 'lint.json' }), dir, { repoRoot: '/repo' });
    expect(findings?.filter((f) => f.gates).map((f) => [f.slot, f.file])).toEqual([['lint', 'src/config.ts']]);
  });

  test("a target's check reads under its directory, rebases from its cwd, and keeps its slot", async () => {
    await mkdir(join(dir, 'web'));
    await writeFile(join(dir, 'web', 'lint.json'), oxlintOn('src/a.ts'));
    const check = entry('web:lint', 'oxlint', { target: 'web', slot: 'lint', cwd: 'apps/web', output_file: 'web/lint.json' });
    expect(findingsFor(check, dir, { repoRoot: '/repo' })?.map((f) => [f.slot, f.file])).toEqual([['lint', 'apps/web/src/a.ts']]);
  });

  test('a text parser reads the stream it declares, and a JSON parser falls back to stdout when no artifact was written', async () => {
    await writeFile(join(dir, 'spell.stdout.txt'), await read('baseline-cspell.txt'));
    expect(findingsFor(entry('spell', 'cspell'), dir, { repoRoot: '/repo' })).toHaveLength(4);
    await writeFile(join(dir, 'lint.stdout.txt'), `preamble line\n${oxlintOn('src/b.ts')}`);
    expect(findingsFor(entry('lint', 'oxlint'), dir, { repoRoot: '/repo' })?.map((f) => f.file)).toEqual(['src/b.ts']);
  });

  test("a stream the run left empty, and so wrote no file for, reads as the tool's empty output", () => {
    expect(findingsFor(entry('spell', 'cspell'), dir, { repoRoot: '/repo' })).toEqual([]);
  });

  test("the entry's argv decides gates, and without one the registry args do", async () => {
    await writeFile(join(dir, 'lint.json'), await read('baseline-oxlint.json'));
    const ran = entry('lint', 'oxlint', { output_file: 'lint.json', argv: ['npx', '--no-install', 'oxlint', '--max-warnings=0'] });
    expect(findingsFor(ran, dir, { repoRoot: '/repo' })?.every((f) => f.gates)).toBe(true);
    expect(findingsFor(entry('lint', 'oxlint', { output_file: 'lint.json' }), dir, { repoRoot: '/repo' })?.filter((f) => f.gates)).toHaveLength(1);
  });

  test('a skipped check, one with no adapter or no parser, and an artifact it cannot read are all null', async () => {
    await mkdir(join(dir, 'lint.json'));
    expect(findingsFor(entry('lint', 'oxlint', { output_file: 'lint.json' }), dir, { repoRoot: '/repo' })).toBeNull();
    expect(findingsFor(entry('lint', 'oxlint', { skipped: true }), dir, { repoRoot: '/repo' })).toBeNull();
    expect(findingsFor(entry('links', null), dir, { repoRoot: '/repo' })).toBeNull();
    expect(findingsFor(entry('types', 'tsc'), dir, { repoRoot: '/repo' })).toBeNull();
  });
});
