/**
 * The `pnpm-audit` parser, read against the report pnpm 11.28.5 printed
 * (C9): `pnpm audit --audit-level=high --json` over this repo on 2026-11-18,
 * five high advisories across four packages, one of them, picomatch's, with
 * two installed versions and no fixed release.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { KeyedFinding } from '../index.js';
import { baselineParserFor, parserFor } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const REPORT = readFileSync(join(FIXTURES, 'findings-pnpm-audit.json'), 'utf8');
const REGISTRY = ['pnpm', 'audit', '--audit-level=high', '--json'];

/** What the parser makes of `raw` under `argv`: its findings, or `null`. */
function attempt(raw: string, argv?: readonly string[]): readonly KeyedFinding[] | null | undefined {
  return parserFor('pnpm-audit')?.parse(raw, { argv, root: undefined });
}

/** A report holding `advisories`, as pnpm prints one. */
function report(advisories: Record<string, unknown>): string {
  return JSON.stringify({ advisories, metadata: { vulnerabilities: {} } });
}

const zod = { module_name: 'zod', title: 'Zod can exhaust memory', severity: 'moderate', github_advisory_id: 'GHSA-mrhx-c7xc-m3w5', patched_versions: '>=4.6.6', findings: [{ version: '4.4.3' }] };

/** Whether zod's advisory, at `severity`, gates under `argv`. */
function gates(argv?: readonly string[], severity = 'moderate'): boolean | undefined {
  return attempt(report({ 1: { ...zod, severity } }), argv)?.[0]?.gates;
}

describe('pnpm audit', () => {
  test('it reads the JSON artifact, and never keys the baseline', () => {
    expect(parserFor('pnpm-audit')?.stream).toBe('artifact');
    expect(baselineParserFor('pnpm-audit')).toBeUndefined();
  });

  test('each advisory is one finding: its package and installed versions, its title and its fix, under its GHSA id, with no file', () => {
    const findings = attempt(REPORT, REGISTRY) ?? [];
    expect(findings.map((f) => [f.rule, f.message])).toEqual([
      ['GHSA-r7fv-28h4-cvq7', 'markdown-it 15.0.1: markdown-it: Quadratic complexity in smartquotes with unmatched closing quotes (fixed in >=15.0.2)'],
      ['GHSA-587h-7wmj-h5pm', 'vite 8.0.16: launch-editor: `fs.existsSync()` existence check can be bypassed on Windows (fixed in >=8.1.6)'],
      ['GHSA-gfr2-rv44-r23c', 'markdown-it 15.0.1: markdown-it: Quadratic-time rendering of a single multi-line link reference definition with default options (regression since 14.0) (fixed in >=15.0.3)'],
      ['GHSA-mrhx-c7xc-m3w5', 'zod 4.4.3: Zod can exhaust memory while validating oversized constrained collections (fixed in >=4.6.6)'],
      ['GHSA-fc5q-39xc-vjpf', 'picomatch 4.0.7, 2.3.2: picomatch vulnerable to ReDoS through single-branch repeated extglobs (no fixed release)'],
    ]);
    expect(findings.every((f) => f.file === '' && f.line === undefined && f.severity === 'high' && f.gates === true)).toBe(true);
    expect(findings[4]?.key).toBe(`:GHSA-fc5q-39xc-vjpf:${findings[4]?.message}`);
  });

  test('an advisory gates at or above the argv’s --audit-level, as the built-in’s verdict does', () => {
    expect(gates(REGISTRY)).toBe(false);
    expect(gates(['pnpm', 'audit', '--audit-level=moderate', '--json'])).toBe(true);
    expect(gates(['pnpm', 'audit', '--json'])).toBe(true);
    expect(gates(['/opt/bin/pnpm', 'audit', '--audit-level=critical'], 'critical')).toBe(true);
    // `info` never gates, and neither does a level pnpm doesn't name.
    expect(gates(['pnpm', 'audit', '--json'], 'info')).toBe(false);
    expect(gates(['pnpm', 'audit', '--json'], 'severe')).toBe(false);
    // No argv: the registry's own `--audit-level=high`.
    expect(gates(undefined)).toBe(false);
    expect(gates(undefined, 'high')).toBe(true);
    // A wrapper hides pnpm's flags.
    expect(gates(['sh', '-c', 'pnpm audit --json'], 'high')).toBeUndefined();
  });

  test('an advisory with no GHSA id is named by pnpm’s own, and one with no version, title or fix still reads', () => {
    const bare = attempt(report({ 7: { id: 7, module_name: 'left-pad', severity: 'high', patched_versions: '<0.0.0', findings: [{}, 'x'] } }));
    expect(bare?.map((f) => [f.rule, f.message])).toEqual([['7', 'left-pad: advisory (no fixed release)']]);
    expect(attempt(report({ 7: { module_name: 'left-pad', severity: 'high' } }))?.[0]?.rule).toBe('');
    const twice = attempt(report({ 1: { ...zod, findings: [{ version: '4.4.3' }, { version: '4.4.3' }, { version: '3.9.0' }] } }));
    expect(twice?.[0]?.message).toBe('zod 4.4.3, 3.9.0: Zod can exhaust memory (fixed in >=4.6.6)');
  });

  test('a clean report is empty, and output that is no audit report, or holds an entry it can’t read, is null', () => {
    expect(attempt(report({}))).toEqual([]);
    expect(attempt('{"error":{"code":23,"message":"The operation was aborted due to timeout"}}')).toBeNull();
    expect(attempt('')).toBeNull();
    expect(attempt('[]')).toBeNull();
    expect(attempt(JSON.stringify({ advisories: {} }))).toBeNull();
    expect(attempt(JSON.stringify({ advisories: [], metadata: {} }))).toBeNull();
    expect(attempt(report({ 1: zod, 2: { severity: 'high' } }))).toBeNull();
    expect(attempt(report({ 1: zod, 2: { module_name: 'zod' } }))).toBeNull();
    expect(attempt(report({ 1: 'zod' }))).toBeNull();
  });
});
