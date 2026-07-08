import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import { fingerprint, runBaseline } from '../baseline/index.js';
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
