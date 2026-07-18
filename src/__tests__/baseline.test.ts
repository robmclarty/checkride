import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import {
  applyBaseline,
  baselinesEqual,
  fingerprint,
  isFingerprintable,
  loadBaseline,
  ratchet,
  runBaseline,
  writeBaseline,
} from '../baseline/index.js';
import type { CheckRunner, Out } from '../orchestrator.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const OXLINT = read('baseline-oxlint.json');
const AST_GREP = read('baseline-ast-grep.json');
const CSPELL = read('baseline-cspell.txt');

function sink(): Out {
  return { write: () => true };
}

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

/** The three fingerprintable slots plus `types`, whose adapter (tsc) sits out. */
const slots = [{ name: 'lint' }, { name: 'struct' }, { name: 'spell' }, { name: 'types' }];
const adapters = [
  fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' }),
  fakeAdapter({ name: 'ast-grep', slot: 'struct', outputFile: 'struct.json' }),
  fakeAdapter({ name: 'cspell', slot: 'spell' }),
  fakeAdapter({ name: 'tsc', slot: 'types' }),
];

/** Feed each slot its fixture on stdout; an empty payload passes (green). */
function runnerFor(payloads: Record<string, string>): CheckRunner {
  return (r) => {
    const stdout = payloads[r.slot] ?? '';
    return Promise.resolve({ ok: stdout === '', exit_code: stdout === '' ? 0 : 1, stdout, stderr: '' });
  };
}

const RED = runnerFor({ lint: OXLINT, struct: AST_GREP, spell: CSPELL });

describe('runBaseline', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function readBaseline(): Promise<Baseline> {
    return JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as Baseline;
  }

  test('writes checkride.baseline.json with per-slot fingerprint key sets', async () => {
    const result = await runBaseline({
      cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink(),
    });
    const written = await readBaseline();

    expect(written.schema_version).toBe(1);
    expect(new Set(written.slots['lint'])).toEqual(fingerprint('oxlint', OXLINT));
    expect(new Set(written.slots['struct'])).toEqual(fingerprint('ast-grep', AST_GREP));
    expect(new Set(written.slots['spell'])).toEqual(fingerprint('cspell', CSPELL));
    expect(result.baseline).toEqual(written);
    expect(result.exitCode).toBe(0);
  });

  test('a slot with no extractor never appears in the baseline', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink() });
    const written = await readBaseline();
    // tsc ran (types) but has no fingerprint extractor, so it is omitted entirely.
    expect(Object.keys(written.slots).toSorted()).toEqual(['lint', 'spell', 'struct']);
  });

  test('keys are stored sorted and order-independent', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink() });
    const lint = (await readBaseline()).slots['lint'] ?? [];
    expect(lint).toEqual([...lint].toSorted());
    expect(lint.length).toBeGreaterThan(0);
  });

  test('a fingerprintable-but-clean slot records an empty array (opted in, no debt)', async () => {
    await runBaseline({
      cwd: dir, slots, adapters, config: null, runner: runnerFor({}), stdout: sink(), stderr: sink(),
    });
    const written = await readBaseline();
    // Every fingerprintable slot that ran is present; each is empty since nothing failed.
    expect(written.slots).toEqual({ lint: [], struct: [], spell: [] });
  });

  test('skipped slots contribute nothing (no adapter, no output)', async () => {
    await runBaseline({
      cwd: dir,
      slots,
      adapters,
      // Disable spell in config → resolves to skipped, so it never runs or fingerprints.
      config: { checks: { spell: false } },
      runner: RED,
      stdout: sink(),
      stderr: sink(),
    });
    const written = await readBaseline();
    expect(written.slots).not.toHaveProperty('spell');
    expect(Object.keys(written.slots).toSorted()).toEqual(['lint', 'struct']);
  });
});

describe('applyBaseline (masking)', () => {
  test('all diagnostics grandfathered → flips a fail to a pass and counts them', () => {
    const adj = applyBaseline(new Set(['a', 'b']), ['a', 'b'], false);
    expect(adj).toEqual({ ok: true, baselined: 2, newKeys: [] });
  });

  test('a new diagnostic keeps the slot failing and lists only the new key', () => {
    const adj = applyBaseline(new Set(['a', 'b', 'c']), ['a', 'b'], false);
    expect(adj).toEqual({ ok: false, baselined: 2, newKeys: ['c'] });
  });

  test('never masks a failure with no parseable diagnostics (a crash stays red)', () => {
    const adj = applyBaseline(new Set(), ['a'], false);
    expect(adj).toEqual({ ok: false, baselined: 0, newKeys: [] });
  });

  test('a clean run stays green whatever the baseline holds', () => {
    expect(applyBaseline(new Set(), ['a'], true).ok).toBe(true);
  });

  test('newKeys are returned sorted, order-independent of the input set', () => {
    expect(applyBaseline(new Set(['z', 'a', 'm']), [], false).newKeys).toEqual(['a', 'm', 'z']);
  });
});

describe('ratchet (the pruning invariant)', () => {
  test('drops fixed keys from observed slots, preserves unobserved ones', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'], spell: ['x'] } };
    const observed = new Map([['lint', new Set(['a'])]]); // spell never ran this pass
    const pruned = ratchet(baseline, observed);
    expect(pruned.slots['lint']).toEqual(['a']); // b was fixed → pruned
    expect(pruned.slots['spell']).toEqual(['x']); // unobserved → preserved intact
  });

  test('never grows: a new current key is not grandfathered', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a'] } };
    const pruned = ratchet(baseline, new Map([['lint', new Set(['a', 'b'])]]));
    expect(pruned.slots['lint']).toEqual(['a']);
  });

  test('an observed slot with everything fixed collapses to an empty set', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] } };
    const pruned = ratchet(baseline, new Map([['lint', new Set<string>()]]));
    expect(pruned.slots['lint']).toEqual([]);
  });
});

describe('baselinesEqual', () => {
  test('order-independent across slot and key ordering', () => {
    const a: Baseline = { schema_version: 1, slots: { lint: ['b', 'a'], spell: ['x'] } };
    const b: Baseline = { schema_version: 1, slots: { spell: ['x'], lint: ['a', 'b'] } };
    expect(baselinesEqual(a, b)).toBe(true);
  });

  test('detects a pruned key', () => {
    const a: Baseline = { schema_version: 1, slots: { lint: ['a'] } };
    const b: Baseline = { schema_version: 1, slots: { lint: [] } };
    expect(baselinesEqual(a, b)).toBe(false);
  });
});

describe('loadBaseline / writeBaseline', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-store-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('round-trips a baseline through disk', async () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] } };
    await writeBaseline(dir, baseline);
    expect(loadBaseline(dir)).toEqual(baseline);
  });

  test('returns null when the file is absent', () => {
    expect(loadBaseline(dir)).toBeNull();
  });

  test('coerces a malformed file rather than throwing (never breaks a run)', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '{ not json');
    expect(loadBaseline(dir)).toBeNull();
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: ['a', 5, 'b'] } }));
    expect(loadBaseline(dir)?.slots['lint']).toEqual(['a', 'b']); // non-strings dropped
  });
});

describe('isFingerprintable', () => {
  test('true for adapters with an extractor, false for the rest', () => {
    expect(isFingerprintable('oxlint')).toBe(true);
    expect(isFingerprintable('ast-grep')).toBe(true);
    expect(isFingerprintable('cspell')).toBe(true);
    expect(isFingerprintable('fallow')).toBe(true);
    expect(isFingerprintable('tsc')).toBe(false);
    expect(isFingerprintable('knip')).toBe(false);
  });
});
