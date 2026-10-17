/**
 * The parser registry and what each parser returns beside its keys: the
 * stream it declares (D49), every finding it read with whether that finding
 * gates, its 1-based position, and the fields a reader sees. The keys
 * themselves are held by the golden in
 * `src/__tests__/baseline-fingerprint.test.ts` (F46).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { KeyedFinding } from '../index.js';
import { parseFallowReport, parserFor, streamText } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** `adapter`'s findings over `raw`, failing loudly when it has no parser or can't trust the output. */
function parse(adapter: string, raw: string, argv?: readonly string[], root?: string): readonly KeyedFinding[] {
  const findings = parserFor(adapter)?.parse(raw, { argv, root, repoRoot: undefined });
  if (!findings) throw new Error(`${adapter} returned no findings`);
  return findings;
}

describe('parserFor', () => {
  test.each([
    ['oxlint', 'artifact'],
    ['ast-grep', 'artifact'],
    ['vale', 'artifact'],
    ['fallow', 'artifact'],
    ['cspell', 'stdout'],
  ])('%s declares the %s stream', (adapter, stream) => {
    expect(parserFor(adapter)?.stream).toBe(stream);
  });

  test('an adapter with no parser, or a name only an object prototype carries, has none', () => {
    for (const adapter of ['vitest', 'knip', 'biome', 'constructor', 'toString', '__proto__']) {
      expect(parserFor(adapter), adapter).toBeUndefined();
    }
  });
});

describe('streamText', () => {
  const output = { stdout: 'out', stderr: 'err' };

  test('a stderr parser is handed stderr', () => {
    expect(streamText(output, 'stderr')).toBe('err');
  });

  test('a stdout or artifact parser is handed stdout, which holds the artifact', () => {
    expect(streamText(output, 'stdout')).toBe('out');
    expect(streamText(output, 'artifact')).toBe('out');
  });
});

describe('parsers return every finding, and say which gate', () => {
  const OXLINT_ARGV = ['oxlint', '--format=json'];

  test('oxlint returns its warnings beside its errors, marked as not gating', () => {
    const findings = parse('oxlint', read('baseline-oxlint.json'), OXLINT_ARGV);
    expect(findings).toHaveLength(4);
    expect(findings.filter((f) => f.gates).map((f) => f.rule)).toEqual(['typescript(no-unused-vars)']);
    expect(findings.find((f) => f.gates)).toEqual({
      file: 'src/config.ts',
      line: 12,
      column: 9,
      rule: 'typescript(no-unused-vars)',
      message: 'Variable is assigned a value but never used.',
      severity: 'error',
      gates: true,
      key: 'src/config.ts:typescript(no-unused-vars):Variable is assigned a value but never used.',
    });
  });

  test('oxlint under --deny-warnings, or with no argv, marks every finding as gating', () => {
    expect(parse('oxlint', read('baseline-oxlint.json'), [...OXLINT_ARGV, '--deny-warnings']).every((f) => f.gates)).toBe(true);
    expect(parse('oxlint', read('baseline-oxlint.json')).every((f) => f.gates)).toBe(true);
  });

  test('ast-grep marks its warning and hint matches as not gating, and counts its positions from 0', () => {
    const findings = parse('ast-grep', read('baseline-ast-grep-severities.json'), ['ast-grep', 'scan', '--json=compact']);
    expect(findings.map((f) => [f.rule, f.severity, f.gates, f.line, f.column])).toEqual([
      ['no-class', 'error', true, 1, 8],
      ['no-var', 'warning', false, 1, 1],
      ['no-console', 'hint', false, 2, 1],
    ]);
  });

  test('vale returns its warnings, and only error-severity alerts gate', () => {
    const findings = parse('vale', read('baseline-vale.json'));
    expect(findings).toHaveLength(10);
    expect(findings.filter((f) => f.gates).every((f) => f.severity === 'error')).toBe(true);
    expect(findings.filter((f) => !f.gates).every((f) => f.severity === 'warning')).toBe(true);
    expect(findings[0]).toMatchObject({ file: 'docs/tools.md', line: 1, column: 1, rule: 'Repo.ThereIs' });
  });

  test('vale returns null for its runtime-error report', () => {
    expect(parserFor('vale')?.parse(read('baseline-vale-error.json'), { argv: undefined, root: undefined })).toBeNull();
  });

  test('cspell names no rule and no severity, and every unknown word gates', () => {
    const findings = parse('cspell', read('baseline-cspell.txt'), undefined, 'apps/web');
    expect(findings).toHaveLength(4);
    expect(findings[0]).toEqual({
      file: 'apps/web/src/cli.ts',
      line: 35,
      column: 37,
      rule: '',
      message: 'Unknown word (oxlint)',
      gates: true,
      key: 'apps/web/src/cli.ts::Unknown word (oxlint)',
    });
  });

  test('a finding with no file or no message is not a finding', () => {
    const raw = JSON.stringify({ diagnostics: [{ filename: '', message: 'm' }, { filename: 'a.ts', message: '' }] });
    expect(parse('oxlint', raw)).toEqual([]);
  });
});

describe('the fallow parser', () => {
  const WEB = { root: 'apps/web' };

  test('a dead-code finding names its category as its rule, its symbol as its message, and its slot', () => {
    const report = parseFallowReport(read('baseline-fallow-dead-code.json'), WEB);
    expect(report.ok && report.findings.map(({ key: _key, ...rest }) => rest)).toEqual([
      { file: 'apps/web/src/unused.ts', rule: 'unused_files', message: '', gates: true, slot: 'dead' },
      { file: 'apps/web/src/extras.ts', line: 1, column: 17, rule: 'unused_exports', message: 'extraExport', gates: true, slot: 'dead' },
    ]);
  });

  test('a clone group names its first instance and its fingerprint, and a health finding its function', () => {
    const dupes = parseFallowReport(read('baseline-fallow-dupes.json'), WEB);
    expect(dupes.ok && dupes.findings[0]).toMatchObject({
      file: 'apps/web/src/dupeA.ts',
      line: 1,
      column: 26,
      rule: 'code-duplication',
      message: 'dup:0d3e33a3',
      slot: 'dupes',
    });
    const health = parseFallowReport(read('baseline-fallow-health.json'), { root: undefined });
    expect(health.ok && health.findings[0]).toEqual({
      file: 'src/complex.ts',
      line: 1,
      column: 8,
      rule: 'complexity',
      message: 'tangled',
      severity: 'high',
      gates: true,
      slot: 'health',
      key: 'health:src/complex.ts:tangled',
    });
  });

  test('a cycle names its first file and its whole chain', () => {
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 1 },
      circular_dependencies: [{ files: ['src/b.ts', 'src/a.ts'] }],
    });
    const report = parseFallowReport(raw, { root: undefined });
    expect(report.ok && report.findings[0]).toMatchObject({ file: 'src/a.ts', message: 'src/a.ts -> src/b.ts' });
  });

  test('an unreadable report is a reason, and the parser reads it as untrustworthy', () => {
    expect(parseFallowReport('', { root: undefined })).toEqual({ ok: false, reason: 'fallow produced no JSON output' });
    expect(parserFor('fallow')?.parse('boom: fatal error', { argv: undefined, root: undefined })).toBeNull();
  });
});
