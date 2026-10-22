import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { Baseline, Observation, RanWith, Tally } from '../baseline/index.js';
import {
  applyBaseline,
  BASELINE_SCHEMA_VERSION,
  baselineDrift,
  baselinesEqual,
  copyNamed,
  fingerprint,
  isFingerprintable,
  loadBaseline,
  parseBaseline,
  ratchet,
  readBaselineStatus,
  entryFor,
  renameBaselineSlots,
  rerecordCopies,
  tally,
  writeBaseline,
} from '../baseline/index.js';
import { runBaseline, runBaselineDiff, runBaselineVersions } from '../baseline-command.js';
import { runCli } from '../cli.js';
import type { GitResult, GitRunner } from '../git.js';
import type { CheckRunner, Out } from '../orchestrator/index.js';

/** A run's tally of `keys`, each found once unless a key repeats. */
function tallyOf(...keys: string[]): Tally {
  const counted = new Map<string, number>();
  for (const key of keys) counted.set(key, (counted.get(key) ?? 0) + 1);
  return counted;
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const OXLINT = read('baseline-oxlint.json');
const AST_GREP = read('baseline-ast-grep.json');
const CSPELL = read('baseline-cspell.txt');
const VALE = read('baseline-vale.json');
const VALE_ERROR = read('baseline-vale-error.json');

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

/**
 * What each fingerprintable slot's tool prints on a clean run: a JSON tool's
 * empty report, not empty output, which its parser reads as a run that never
 * finished.
 */
const CLEAN: Record<string, string> = { lint: '{"diagnostics":[]}', struct: '[]', spell: '' };

/** Every slot passes, printing its clean payload. */
const GREEN: CheckRunner = (r) => Promise.resolve({ ok: true, exit_code: 0, stdout: CLEAN[r.slot] ?? '', stderr: '' });

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
      cwd: dir, slots, adapters, config: null, runner: GREEN, stdout: sink(), stderr: sink(),
    });
    const written = await readBaseline();
    // Every fingerprintable slot that ran is present; each is empty since nothing failed.
    expect(written.slots).toEqual({ lint: [], struct: [], spell: [] });
  });

  test('an unrun check keeps its previous keys', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink() });
    const before = await readBaseline();
    // Re-captured, but cspell refuses this time: exit 1 and nothing on stdout,
    // which its line-based parser can't tell from a clean run.
    const refusing: CheckRunner = (r, ctx) =>
      r.slot === 'spell' ? Promise.resolve({ ok: false, exit_code: 1, stdout: '', stderr: 'cspell refused' }) : RED(r, ctx);
    const warnings: string[] = [];
    await runBaseline({
      cwd: dir, slots, adapters, config: null, runner: refusing, stdout: sink(),
      stderr: { write: (text: string) => { warnings.push(text); return true; } },
    });
    const after = await readBaseline();

    expect(before.slots['spell']?.length).toBeGreaterThan(0);
    expect(after.slots['spell']).toEqual(before.slots['spell']);
    expect(after.slots['lint']).toEqual(before.slots['lint']);
    expect(warnings.join('')).toContain(`baseline: spell didn't run to a verdict`);
  });

  test('a red prose slot is captured, and the capture masks it green', async () => {
    const proseSlots = [{ name: 'lint' }, { name: 'prose' }];
    const proseAdapters = [...adapters, fakeAdapter({ name: 'vale', slot: 'prose', outputFile: 'prose.json' })];
    await runBaseline({
      cwd: dir,
      slots: proseSlots,
      adapters: proseAdapters,
      config: null,
      runner: runnerFor({ lint: OXLINT, prose: VALE }),
      stdout: sink(),
      stderr: sink(),
    });
    const keys = (await readBaseline()).slots['prose'] ?? [];
    const current = tally('vale', VALE) ?? new Map<string, number>();

    expect(new Set(keys)).toEqual(new Set(current.keys()));
    expect(applyBaseline(current, entryFor(await readBaseline(), 'prose'), false)).toEqual({ ok: true, baselined: 8, newKeys: [], excess: [], newFindings: 0 });
  });

  test('a prose run vale could not read is omitted, never captured as clean', async () => {
    // An E201 report reads as an alert report with zero alerts unless the
    // extractor is shape-aware; capturing `prose: []` from one would grandfather
    // nothing and prune everything the next ratchet touched.
    const proseSlots = [{ name: 'lint' }, { name: 'prose' }];
    const proseAdapters = [...adapters, fakeAdapter({ name: 'vale', slot: 'prose', outputFile: 'prose.json' })];
    await runBaseline({
      cwd: dir,
      slots: proseSlots,
      adapters: proseAdapters,
      config: null,
      runner: runnerFor({ lint: OXLINT, prose: VALE_ERROR }),
      stdout: sink(),
      stderr: sink(),
    });
    const written = await readBaseline();

    // `lint` proves the run happened; `prose` is absent rather than empty.
    expect(written.slots['lint']?.length).toBeGreaterThan(0);
    expect(written.slots).not.toHaveProperty('prose');
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
    const adj = applyBaseline(tallyOf('a', 'b'), { keys: ['a', 'b'] }, false);
    expect(adj).toEqual({ ok: true, baselined: 2, newKeys: [], excess: [], newFindings: 0 });
  });

  test('a new diagnostic keeps the slot failing and lists only the new key', () => {
    const adj = applyBaseline(tallyOf('a', 'b', 'c'), { keys: ['a', 'b'] }, false);
    expect(adj).toEqual({ ok: false, baselined: 2, newKeys: ['c'], excess: [], newFindings: 1 });
  });

  test('never masks a failure with no parseable diagnostics (a crash stays red)', () => {
    const adj = applyBaseline(new Map(), { keys: ['a'] }, false);
    expect(adj).toEqual({ ok: false, baselined: 0, newKeys: [], excess: [], newFindings: 0 });
  });

  test('a clean run stays green whatever the baseline holds', () => {
    expect(applyBaseline(new Map(), { keys: ['a'] }, true).ok).toBe(true);
  });

  test('newKeys are returned sorted, order-independent of the input set', () => {
    expect(applyBaseline(tallyOf('z', 'a', 'm'), { keys: [] }, false).newKeys).toEqual(['a', 'm', 'z']);
  });

  /** A key names a finding by what it is, so two of one finding in a file share it (#14). */
  test('a counted entry grandfathers as many findings of a key as it counts, and no more', () => {
    const twice = tallyOf('a', 'a', 'b');
    expect(applyBaseline(twice, { keys: ['a', 'b'], counts: { a: 2 } }, false)).toEqual({ ok: true, baselined: 3, newKeys: [], excess: [], newFindings: 0 });
    const thrice = tallyOf('a', 'a', 'a', 'b', 'b', 'c');
    expect(applyBaseline(thrice, { keys: ['a', 'b'], counts: { a: 2 } }, false)).toEqual({
      ok: false,
      baselined: 3,
      newKeys: ['c'],
      excess: [{ key: 'a', found: 3, allowed: 2 }, { key: 'b', found: 2, allowed: 1 }],
      newFindings: 3,
    });
  });

  test('an entry captured before counts grandfathers any number of a key, as it always did', () => {
    expect(applyBaseline(tallyOf('a', 'a', 'a'), { keys: ['a'] }, false)).toEqual({ ok: true, baselined: 3, newKeys: [], excess: [], newFindings: 0 });
  });
});

describe('ratchet (the pruning invariant)', () => {
  test('drops fixed keys from observed slots, preserves unobserved ones', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'], spell: ['x'] } };
    const observed = new Map([['lint', tallyOf('a')]]); // spell never ran this pass
    const pruned = ratchet(baseline, observed);
    expect(pruned.slots['lint']).toEqual(['a']); // b was fixed → pruned
    expect(pruned.slots['spell']).toEqual(['x']); // unobserved → preserved intact
  });

  test('never grows: a new current key is not grandfathered', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a'] } };
    const pruned = ratchet(baseline, new Map([['lint', tallyOf('a', 'b')]]));
    expect(pruned.slots['lint']).toEqual(['a']);
  });

  test('an observed slot with everything fixed collapses to an empty set', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] } };
    const pruned = ratchet(baseline, new Map([['lint', tallyOf()]]));
    expect(pruned.slots['lint']).toEqual([]);
  });

  test('a counted key falls to what the run found, never rises, and a check captured before counts stays uncounted', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b', 'c'], spell: ['x'] }, counts: { lint: { a: 3, b: 2 } } };
    const pruned = ratchet(baseline, new Map([['lint', tallyOf('a', 'a', 'b', 'b', 'b')], ['spell', tallyOf('x', 'x')]]));
    expect(pruned).toEqual({ schema_version: 1, slots: { lint: ['a', 'b'], spell: ['x'] }, counts: { lint: { a: 2, b: 2 } } });
    const fewer = ratchet(pruned, new Map([['lint', tallyOf('a', 'b')]]));
    expect(fewer.counts).toEqual({ lint: {} });
    expect(baselinesEqual(baseline, ratchet(baseline, new Map([['lint', tallyOf('a', 'a', 'a', 'b', 'b', 'c')]])))).toBe(true);
  });
});

/** `runner`, recording on each outcome the pin its slot's tool resolved through, as a real runner does. */
function pinnedBy(runner: CheckRunner, pins: Record<string, RanWith>): CheckRunner {
  return async (r, ctx) => ({ ...(await runner(r, ctx)), ...pins[r.slot] }) as Awaited<ReturnType<CheckRunner>>;
}

/**
 * `captured_with`: how `checkride baseline` captured each check's keys. A tool
 * upgrade re-keys findings, so a run with another copy than the one recorded
 * is held back from the ratchet; everything that rewrites the file keeps the
 * record as it was.
 */
describe('captured_with', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-captured-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const PINS: Record<string, RanWith> = { lint: { pin_source: 'js-lockfile', tool_version: '1.87.0' }, struct: { pin_source: 'path' } };
  const raw = (): Promise<string> => readFile(join(dir, 'checkride.baseline.json'), 'utf8');

  test('a capture records each check’s pin source and version after the slots, and nothing for a check that resolved through none', async () => {
    const result = await runBaseline({ cwd: dir, slots, adapters, config: null, runner: pinnedBy(RED, PINS), stdout: sink(), stderr: sink() });
    const text = await raw();
    const written = JSON.parse(text) as Baseline;
    expect(written.captured_with).toEqual({ lint: { pin_source: 'js-lockfile', tool_version: '1.87.0' }, struct: { pin_source: 'path' } });
    // A capture counts every check it observed: `counts` comes last, naming each check that holds a key.
    expect(Object.keys(written)).toEqual(['schema_version', 'slots', 'captured_with', 'counts']);
    expect(Object.keys(written.counts ?? {})).toEqual(Object.keys(written.slots).filter((check) => (written.slots[check] ?? []).length > 0));
    expect(text).toContain('"lint": {\n      "pin_source": "js-lockfile",\n      "tool_version": "1.87.0"\n    }');
    expect(result.baseline).toEqual(written);
  });

  test('a capture where no check resolved through a pin source writes no captured_with', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink() });
    expect(JSON.parse(await raw())).not.toHaveProperty('captured_with');
  });

  test('a check the capture didn’t observe keeps its previous record with its previous keys', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: pinnedBy(RED, PINS), stdout: sink(), stderr: sink() });
    const refusing: CheckRunner = (r, ctx) =>
      r.slot === 'lint' ? Promise.resolve({ ok: false, exit_code: 1, stdout: '', stderr: 'refused' }) : RED(r, ctx);
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: pinnedBy(refusing, { lint: { pin_source: 'path' } }), stdout: sink(), stderr: sink() });
    expect((JSON.parse(await raw()) as Baseline).captured_with).toEqual({ lint: { pin_source: 'js-lockfile', tool_version: '1.87.0' } });
  });

  test('the ratchet carries the record as it is, and an unchanged run is no write', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] }, captured_with: { lint: { pin_source: 'nix', tool_version: '2.11.4' } } };
    const pruned = ratchet(baseline, new Map([['lint', tallyOf('a')]]));
    expect(pruned).toEqual({ schema_version: 1, slots: { lint: ['a'] }, captured_with: { lint: { pin_source: 'nix', tool_version: '2.11.4' } } });
    expect(baselinesEqual(baseline, ratchet(baseline, new Map([['lint', tallyOf('a', 'b')]])))).toBe(true);
  });

  test('a rename moves counts with their keys, and two entries merged stay counted only when both were', () => {
    const baseline: Baseline = {
      schema_version: 1,
      slots: { lint: ['a'], spell: ['x'], 'app:spell': ['y'], docs: ['d'], 'app:docs': ['e'] },
      counts: { lint: { a: 2 }, spell: { x: 3 }, 'app:spell': { x: 2, y: 4 }, docs: {} },
    };
    const renamed = renameBaselineSlots(baseline, new Map([['lint', 'app:lint'], ['spell', 'app:spell'], ['docs', 'app:docs']]));
    expect(renamed.counts).toEqual({ 'app:lint': { a: 2 }, 'app:spell': { x: 3, y: 4 } });
  });

  test('a rename moves each record with its keys, and a check already under the new name keeps its own', () => {
    const baseline: Baseline = {
      schema_version: 1,
      slots: { lint: ['a'], spell: ['x'], 'app:spell': ['y'] },
      captured_with: { lint: { pin_source: 'path' }, spell: { pin_source: 'mise' }, 'app:spell': { pin_source: 'js-lockfile', tool_version: '9.0.0' } },
    };
    const renamed = renameBaselineSlots(baseline, new Map([['lint', 'app:lint'], ['spell', 'app:spell']]));
    expect(renamed.captured_with).toEqual({ 'app:lint': { pin_source: 'path' }, 'app:spell': { pin_source: 'js-lockfile', tool_version: '9.0.0' } });
  });

  test('reads tolerantly: an entry with no pin source, a bad version, or no keys under it is dropped', () => {
    const parsed = parseBaseline(JSON.stringify({
      schema_version: 1,
      slots: { lint: ['a'], spell: [], docs: [] },
      captured_with: { lint: { pin_source: 'nix', tool_version: 7 }, spell: { tool_version: '1.0.0' }, docs: 'path', gone: { pin_source: 'path' } },
    }));
    expect(parsed).toEqual({ schema_version: 1, slots: { lint: ['a'], spell: [], docs: [] }, captured_with: { lint: { pin_source: 'nix' } } });
    expect(parseBaseline(JSON.stringify({ schema_version: 1, slots: {}, captured_with: [] }))).toEqual({ schema_version: 1, slots: {} });
  });

  test('a check of a pack with a toolchain records its release last, and the ratchet and a rename keep it', async () => {
    const lint = { pin_source: 'nix', tool_version: '2.11.4', toolchain_version: '1.25.3' };
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: pinnedBy(RED, { ...PINS, lint }), stdout: sink(), stderr: sink() });
    const text = await raw();
    expect(text).toContain('"lint": {\n      "pin_source": "nix",\n      "tool_version": "2.11.4",\n      "toolchain_version": "1.25.3"\n    }');
    const written = JSON.parse(text) as Baseline;
    expect(ratchet(written, new Map([['lint', tallyOf()]])).captured_with?.['lint']).toEqual(lint);
    expect(renameBaselineSlots(written, new Map([['lint', 'api:lint']])).captured_with?.['api:lint']).toEqual(lint);
  });

  test('reads a toolchain release tolerantly, and writes it after the tool version whatever order it came in', async () => {
    const parsed = parseBaseline(JSON.stringify({
      schema_version: 1,
      slots: { lint: [], spell: [] },
      captured_with: { lint: { toolchain_version: '1.25.3', pin_source: 'path' }, spell: { pin_source: 'path', toolchain_version: 125 } },
    }));
    expect(parsed?.captured_with).toEqual({ lint: { pin_source: 'path', toolchain_version: '1.25.3' }, spell: { pin_source: 'path' } });
    await writeBaseline(dir, { schema_version: 1, slots: { lint: [] }, captured_with: { lint: { toolchain_version: '1.25.3', tool_version: '2.11.4', pin_source: 'nix' } } });
    expect(await raw()).toContain('"pin_source": "nix",\n      "tool_version": "2.11.4",\n      "toolchain_version": "1.25.3"');
  });

  test('writes canonical: checks sorted, records only for checks the slots hold, none when there are none', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { spell: [], lint: [] }, captured_with: { spell: { tool_version: '9.0.0', pin_source: 'js-lockfile' }, gone: { pin_source: 'path' } } });
    expect(await raw()).toBe(`${JSON.stringify({ schema_version: 1, slots: { lint: [], spell: [] }, captured_with: { spell: { pin_source: 'js-lockfile', tool_version: '9.0.0' } } }, null, 2)}\n`);
    await writeBaseline(dir, { schema_version: 1, slots: { lint: [] }, captured_with: {} });
    expect(JSON.parse(await raw())).not.toHaveProperty('captured_with');
  });
});

describe('baselineDrift', () => {
  test('another version is another copy', () => {
    expect(baselineDrift({ pin_source: 'nix', tool_version: '2.14.0' }, { pin_source: 'nix', tool_version: '2.11.4' })).toBe(true);
    expect(baselineDrift({ pin_source: 'path' }, { pin_source: 'nix', tool_version: '2.11.4' })).toBe(true);
    expect(baselineDrift({ pin_source: 'nix', tool_version: '2.11.4' }, { pin_source: 'path' })).toBe(true);
  });

  test('where neither side names a version, another pin source is another copy, and the same one never is', () => {
    expect(baselineDrift({ pin_source: 'mise' }, { pin_source: 'path' })).toBe(true);
    expect(baselineDrift({ pin_source: 'mise' }, { pin_source: 'mise' })).toBe(false);
  });

  test('the same version through another source is the same copy', () => {
    expect(baselineDrift({ pin_source: 'js-lockfile', tool_version: '5.0.0' }, { pin_source: 'override', tool_version: '5.0.0' })).toBe(false);
  });

  test('where only one side names a version, the pin source decides, so a mise record from before mise named one never drifts', () => {
    expect(baselineDrift({ pin_source: 'mise' }, { pin_source: 'mise', tool_version: '2.14.0' })).toBe(false);
    expect(baselineDrift({ pin_source: 'mise', tool_version: '2.14.0' }, { pin_source: 'mise' })).toBe(false);
    expect(baselineDrift({ pin_source: 'mise', tool_version: '2.14.0' }, { pin_source: 'mise', tool_version: '2.11.4' })).toBe(true);
    expect(baselineDrift({ pin_source: 'mise', tool_version: '2.14.0' }, { pin_source: 'path' })).toBe(true);
  });

  test('names a copy by its version and source, or where it came from', () => {
    expect(copyNamed({ pin_source: 'nix', tool_version: '2.11.4' })).toBe('2.11.4 (nix)');
    expect(copyNamed({ pin_source: 'path' })).toBe('from PATH');
    expect(copyNamed({ pin_source: 'mise' })).toBe('through mise');
    expect(copyNamed({})).toBe('with no pin source');
  });

  test('a toolchain on another minor line is another copy, though the tool matches; a patch release, or a side that names none, is not', () => {
    const lint = { pin_source: 'nix', tool_version: '2.11.4' };
    expect(baselineDrift({ ...lint, toolchain_version: '1.25.3' }, { ...lint, toolchain_version: '1.25.5' })).toBe(false);
    expect(baselineDrift({ ...lint, toolchain_version: '1.25.3' }, { ...lint, toolchain_version: '1.26.0' })).toBe(true);
    expect(baselineDrift({ ...lint, toolchain_version: '1.25' }, { ...lint, toolchain_version: '1.26' })).toBe(true);
    expect(baselineDrift({ ...lint, toolchain_version: '1.27rc1' }, { ...lint, toolchain_version: '1.27.0' })).toBe(false);
    expect(baselineDrift(lint, { ...lint, toolchain_version: '1.26.0' })).toBe(false);
    expect(baselineDrift({ ...lint, toolchain_version: '1.25.3' }, lint)).toBe(false);
    expect(baselineDrift({ ...lint, toolchain_version: '1.25.3' }, { pin_source: 'nix', tool_version: '2.14.0', toolchain_version: '1.25.3' })).toBe(true);
    expect(baselineDrift({ pin_source: 'path', toolchain_version: '1.25.3' }, { pin_source: 'path', toolchain_version: '1.26.1' })).toBe(true);
  });

  test("names the toolchain release a copy ran on, by the toolchain's name", () => {
    expect(copyNamed({ pin_source: 'nix', tool_version: '2.11.4', toolchain_version: '1.25.3' }, 'go')).toBe('2.11.4 (nix) on go 1.25.3');
    expect(copyNamed({ pin_source: 'path', toolchain_version: '1.26.1' }, 'go')).toBe('from PATH on go 1.26.1');
    expect(copyNamed({ pin_source: 'path', toolchain_version: '1.26.1' })).toBe('from PATH on its toolchain 1.26.1');
    expect(copyNamed({ pin_source: 'nix', tool_version: '2.11.4' }, 'go')).toBe('2.11.4 (nix)');
  });
});

/** A run that saw lint report `keys`, or reach no verdict for `null`, through `ran`. */
function seen(keys: string[] | null, ran: RanWith): ReadonlyMap<string, Observation> {
  return new Map([['lint', { keys: keys === null ? null : tallyOf(...keys), ran }]]);
}

/**
 * `baseline --versions` records the copy each check's tool ran and prunes the
 * keys that copy no longer reports, but only for a check that ran to a
 * verdict, reported no key its entry lacks, and ran a copy a pin of the
 * repo's chose; every other check is left as it was. It never adds a key.
 */
describe('rerecordCopies', () => {
  const OLD = { pin_source: 'js-lockfile', tool_version: '1.87.0' };
  const NEW = { pin_source: 'js-lockfile', tool_version: '1.88.0' };
  const committed: Baseline = { schema_version: 1, slots: { lint: ['a', 'b', 'c'] }, captured_with: { lint: OLD } };

  const cases: { label: string; baseline?: Baseline; observed: ReadonlyMap<string, Observation>; slots: string[]; record: RanWith | undefined; outcome: Record<string, unknown> }[] = [
    { label: 'another copy reporting a subset is re-recorded, the rest pruned', observed: seen(['a', 'c'], NEW), slots: ['a', 'c'], record: NEW, outcome: { outcome: 'rerecorded', from: OLD, to: NEW, pruned: 1 } },
    { label: 'another copy reporting every key is re-recorded, nothing pruned', observed: seen(['c', 'a', 'b'], NEW), slots: ['a', 'b', 'c'], record: NEW, outcome: { outcome: 'rerecorded', from: OLD, to: NEW, pruned: 0 } },
    { label: 'a key the entry lacks leaves the check', observed: seen(['a', 'd'], NEW), slots: ['a', 'b', 'c'], record: OLD, outcome: { outcome: 'new-keys', newKeys: 1, ran: NEW } },
    { label: 'a check the run didn’t observe is left', observed: new Map(), slots: ['a', 'b', 'c'], record: OLD, outcome: { outcome: 'not-run' } },
    { label: 'a check that reached no verdict is left', observed: seen(null, NEW), slots: ['a', 'b', 'c'], record: OLD, outcome: { outcome: 'no-verdict' } },
    { label: 'a copy from PATH is left, its fixed keys too', observed: seen(['a'], { pin_source: 'path' }), slots: ['a', 'b', 'c'], record: OLD, outcome: { outcome: 'unpinned', ran: { pin_source: 'path' } } },
    { label: 'a tool that resolved through no pin source is left', observed: seen(['a'], {}), slots: ['a', 'b', 'c'], record: OLD, outcome: { outcome: 'unpinned', ran: {} } },
    {
      label: 'a pinned tool on a toolchain no pin chose is left: CI may run another',
      observed: seen(['a'], { ...NEW, toolchain_version: '1.27.2', toolchain_pinned: false }),
      slots: ['a', 'b', 'c'],
      record: OLD,
      outcome: { outcome: 'unpinned', ran: { ...NEW, toolchain_version: '1.27.2', toolchain_pinned: false } },
    },
    {
      label: 'a pinned tool on a toolchain a pin chose is re-recorded, the toolchain with it',
      observed: seen(['a'], { ...NEW, toolchain_version: '1.27.2', toolchain_pinned: true }),
      slots: ['a'],
      record: { ...NEW, toolchain_version: '1.27.2' },
      outcome: { outcome: 'rerecorded', from: OLD, to: { ...NEW, toolchain_version: '1.27.2' }, pruned: 2 },
    },
    { label: 'the copy it was captured with, reporting every key, is unchanged', observed: seen(['a', 'b', 'c'], OLD), slots: ['a', 'b', 'c'], record: OLD, outcome: { outcome: 'unchanged' } },
    { label: 'the copy it was captured with, reporting a subset, is pruned', observed: seen(['b'], OLD), slots: ['b'], record: OLD, outcome: { outcome: 'rerecorded', from: OLD, to: OLD, pruned: 2 } },
    {
      label: 'a check with no record takes one, pinned',
      baseline: { schema_version: 1, slots: { lint: ['a'] } },
      observed: seen(['a'], { pin_source: 'nix', tool_version: '2.11.4', toolchain_version: '1.25.3' }),
      slots: ['a'],
      record: { pin_source: 'nix', tool_version: '2.11.4', toolchain_version: '1.25.3' },
      outcome: { outcome: 'rerecorded', to: { pin_source: 'nix', tool_version: '2.11.4', toolchain_version: '1.25.3' }, pruned: 0 },
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const { baseline, results } = rerecordCopies(c.baseline ?? committed, c.observed);
      expect(baseline.slots['lint']).toEqual(c.slots);
      expect(baseline.captured_with?.['lint']).toEqual(c.record);
      expect(results).toEqual([{ check: 'lint', ...c.outcome }]);
    });
  }

  /** Counts (#14): a finding past a key's count is new, and a count only falls, as a pruned key does. */
  test('a run with more findings of a key than it counts leaves the check, and one with fewer lowers the count', () => {
    const counted: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] }, captured_with: { lint: OLD }, counts: { lint: { a: 3 } } };
    const twoMore = new Map<string, Observation>([['lint', { keys: tallyOf('a', 'a', 'a', 'b', 'b'), ran: NEW }]]);
    expect(rerecordCopies(counted, twoMore).results).toEqual([{ check: 'lint', outcome: 'new-keys', newKeys: 1, ran: NEW }]);
    const fewer = new Map<string, Observation>([['lint', { keys: tallyOf('a', 'a', 'b'), ran: NEW }]]);
    const { baseline } = rerecordCopies(counted, fewer);
    expect(baseline).toEqual({ schema_version: 1, slots: { lint: ['a', 'b'] }, captured_with: { lint: NEW }, counts: { lint: { a: 2 } } });
    const same = new Map<string, Observation>([['lint', { keys: tallyOf('a', 'a', 'a', 'b'), ran: OLD }]]);
    expect(rerecordCopies(counted, same).results).toEqual([{ check: 'lint', outcome: 'unchanged' }]);
  });

  test('a check with no record that the run left keeps none, and other checks keep theirs', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a'], spell: ['x'] }, captured_with: { spell: { pin_source: 'js-lockfile', tool_version: '9.0.0' } } };
    const observed = new Map<string, Observation>([['lint', { keys: tallyOf('a'), ran: { pin_source: 'path' } }], ['spell', { keys: tallyOf('x'), ran: { pin_source: 'js-lockfile', tool_version: '9.1.0' } }]]);
    const next = rerecordCopies(baseline, observed);
    expect(next.baseline).toEqual({ schema_version: 1, slots: { lint: ['a'], spell: ['x'] }, captured_with: { spell: { pin_source: 'js-lockfile', tool_version: '9.1.0' } } });
    expect(next.results.map((r) => r.outcome)).toEqual(['unpinned', 'rerecorded']);
  });

  test('never adds a key, over every subset and superset a run could report', () => {
    const held = ['a', 'b', 'c', 'd'];
    const pool = [...held, 'e', 'f'];
    for (let mask = 0; mask < 2 ** pool.length; mask += 1) {
      const reported = pool.filter((_, i) => (mask >> i) % 2 === 1);
      for (const ran of [NEW, OLD, { pin_source: 'path' }]) {
        const { baseline } = rerecordCopies({ schema_version: 1, slots: { lint: held }, captured_with: { lint: OLD } }, seen(reported, ran));
        for (const key of baseline.slots['lint'] ?? []) expect(held, `${reported.join(',')} under ${JSON.stringify(ran)}`).toContain(key);
      }
    }
  });
});

/** An oxlint report of the given `[file, rule, message]` findings, each keyed `file:rule:message`. */
function oxlintReport(findings: readonly (readonly [string, string, string])[]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message })) });
}

/** oxlint's report of one finding, keyed `a.ts:no-x:bad`. */
const LINT_A = ['a.ts', 'no-x', 'bad'] as const;

/** A runner whose lint reports `lint` under oxlint `version`, and whose spell reports `spell` from PATH. */
function ranUnder(lint: readonly (readonly [string, string, string])[], version: string, spell = 'docs/old.md:3:7 - teh\n'): CheckRunner {
  return pinnedBy(runnerFor({ lint: oxlintReport(lint), spell }), { lint: { pin_source: 'js-lockfile', tool_version: version }, spell: { pin_source: 'path' } });
}

/** {@link ranUnder} at oxlint 1.88.0 for every slot but lint, whose tool refuses, and so reaches no verdict. */
const refusing: CheckRunner = (r, ctx) => (r.slot === 'lint' ? Promise.resolve({ ok: false, exit_code: 1, stdout: '', stderr: 'refused' }) : ranUnder([], '1.88.0')(r, ctx));

/**
 * `checkride baseline --versions`: a capture's run, then the rule
 * `rerecordCopies` applies, written only when a check was re-recorded, and a
 * line for each check it re-recorded or left.
 */
describe('runBaselineVersions', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-versions-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const file = (): string => join(dir, 'checkride.baseline.json');
  const committed: Baseline = {
    schema_version: 1,
    slots: { lint: ['a.ts:no-x:bad', 'b.ts:no-y:worse'], spell: ['docs/old.md::teh'] },
    captured_with: { lint: { pin_source: 'js-lockfile', tool_version: '1.87.0' }, spell: { pin_source: 'path' } },
  };

  test('records a pinned copy that moved, prunes the keys it no longer reports, and names what it did', async () => {
    await writeBaseline(dir, committed);
    const err = capture();
    const result = await runBaselineVersions({ cwd: dir, slots, adapters, config: null, runner: ranUnder([LINT_A], '1.88.0'), stdout: sink(), stderr: err.out });
    expect(result).toMatchObject({ ok: true, exitCode: 0, written: true });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      schema_version: 1,
      slots: { lint: ['a.ts:no-x:bad'], spell: ['docs/old.md::teh'] },
      captured_with: { lint: { pin_source: 'js-lockfile', tool_version: '1.88.0' }, spell: { pin_source: 'path' } },
    });
    expect(err.text()).toContain('baseline --versions: lint re-recorded: oxlint 1.87.0 (js-lockfile) → 1.88.0 (js-lockfile); 1 key(s) pruned\n');
    expect(err.text()).toContain('baseline --versions: wrote checkride.baseline.json: 1 re-recorded, 0 left, 1 unchanged; review it with `git diff checkride.baseline.json`\n');
    expect(err.text()).not.toContain('baseline --versions: spell');
  });

  test('a check whose toolchain no pin chose is left, named with that toolchain release', async () => {
    await writeBaseline(dir, committed);
    const before = await readFile(file(), 'utf8');
    const err = capture();
    const machineGo = pinnedBy(runnerFor({ lint: oxlintReport([LINT_A]), spell: 'docs/old.md:3:7 - teh\n' }), {
      lint: { pin_source: 'js-lockfile', tool_version: '1.88.0', toolchain_version: '1.27.2', toolchain_pinned: false },
      spell: { pin_source: 'path' },
    });
    await runBaselineVersions({ cwd: dir, slots, adapters, config: null, runner: machineGo, stdout: sink(), stderr: err.out });
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(err.text()).toContain("baseline --versions: lint left: it ran on its toolchain 1.27.2, which no pin of the repo's chose; pin it, or run in the repo's dev shell\n");
  });

  test('a check with a new key, and one from PATH, are left as they were, and nothing is written', async () => {
    await writeBaseline(dir, committed);
    const before = await readFile(file(), 'utf8');
    const err = capture();
    const result = await runBaselineVersions({
      cwd: dir, slots, adapters, config: null, runner: ranUnder([LINT_A, ['c.ts', 'no-z', 'new']], '1.88.0', ''), stdout: sink(), stderr: err.out,
    });
    expect(result).toMatchObject({ exitCode: 0, written: false });
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(err.text()).toContain(
      'baseline --versions: lint left: 1 key(s) new or found past their count under oxlint 1.88.0 (js-lockfile); fix them, or have a human review them and run `checkride baseline`\n',
    );
    expect(err.text()).toContain('baseline --versions: spell left: it ran an unpinned copy from PATH\n');
    expect(err.text()).toContain('baseline --versions: checkride.baseline.json is unchanged: 0 re-recorded, 2 left, 0 unchanged\n');
  });

  test('a check that didn\'t run, or ran to no verdict, is left with its keys and record', async () => {
    await writeBaseline(dir, committed);
    const err = capture();
    await runBaselineVersions({ cwd: dir, slots: slots.filter((s) => s.name !== 'spell'), adapters, config: null, runner: refusing, stdout: sink(), stderr: err.out });
    expect(err.text()).toContain("baseline --versions: lint left: it didn't run to a verdict (refused, timed out or crashed)\n");
    expect(err.text()).toContain("baseline --versions: spell left: it didn't run\n");
    expect(loadBaseline(dir)).toEqual(committed);
  });

  test('refuses before anything runs: no baseline, one that can\'t be parsed, a --config outside the repo', async () => {
    let runs = 0;
    const counting: CheckRunner = (r, ctx) => { runs += 1; return GREEN(r, ctx); };
    const versions = (configPath?: string) =>
      runBaselineVersions({ cwd: dir, slots, adapters, config: null, runner: counting, stdout: sink(), stderr: sink(), ...(configPath !== undefined ? { configPath } : {}) });
    await expect(versions()).rejects.toThrow("there's no checkride.baseline.json to re-record; capture one with `checkride baseline`");
    await writeFile(file(), '<<<<<<< HEAD\n{');
    await expect(versions()).rejects.toThrow("checkride.baseline.json can't be parsed, or comes from a newer checkride; restore it with `checkride recover`");
    await writeBaseline(dir, committed);
    await expect(versions(join(dir, '..', 'elsewhere.json'))).rejects.toThrow(/--config names .*elsewhere\.json, outside the repo/);
    expect(runs).toBe(0);
    await versions(join(dir, 'checkride.config.json'));
    expect(runs).toBeGreaterThan(0);
  });

  test('the CLI takes --versions, and exits 2 for a stray argument, a missing baseline or an outside --config', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'checkride-versions-outside-'));
    try {
      await writeFile(join(outside, 'checkride.config.json'), '{}');
      const deps = (stderr: Out) => ({ cwd: dir, stdout: sink(), stderr, env: {} });
      const missing = capture();
      expect(await runCli(['baseline', '--versions'], deps(missing.out))).toBe(2);
      expect(missing.text()).toContain('capture one with `checkride baseline`');
      await writeBaseline(dir, committed);
      expect(await runCli(['baseline', '--versions', 'lint'], deps(sink()))).toBe(2);
      const far = capture();
      expect(await runCli(['baseline', '--versions', '--config', join(outside, 'checkride.config.json')], deps(far.out))).toBe(2);
      expect(far.text()).toContain('outside the repo');
      const ok = capture();
      expect(await runCli(['baseline', '--versions'], deps(ok.out))).toBe(0);
      expect(ok.text()).toContain('baseline --versions: checkride.baseline.json is unchanged:');
      expect(loadBaseline(dir)).toEqual(committed);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

  /**
   * `slots` is a map from slot name to keys. An array passed the old guard
   * (`typeof [] === 'object'`), and `Object.entries` then keyed the baseline by
   * array *index* — a file that masked nothing while looking like it loaded.
   */
  test('rejects a slots array instead of keying it by index', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: [['a']] }));
    expect(loadBaseline(dir)).toBeNull();
  });

  /**
   * Fail closed on a baseline from a newer checkride: the fields this version
   * cannot see are the ones that say what is masked and why. Dropping it
   * re-surfaces the real diagnostics (more red), where guessing risks masking
   * findings the author never grandfathered.
   */
  test('drops a baseline from a newer schema version rather than half-reading it', async () => {
    const path = join(dir, 'checkride.baseline.json');
    await writeFile(path, JSON.stringify({ schema_version: BASELINE_SCHEMA_VERSION + 1, slots: { lint: ['a'] } }));
    expect(loadBaseline(dir)).toBeNull();
    // The current version, and an older one, still load.
    await writeFile(path, JSON.stringify({ schema_version: BASELINE_SCHEMA_VERSION, slots: { lint: ['a'] } }));
    expect(loadBaseline(dir)?.slots['lint']).toEqual(['a']);
  });

  /**
   * Canonical on disk: two branches that grandfather the same debt must produce
   * byte-identical files, whatever order their runs discovered the slots in —
   * otherwise insertion order alone manufactures merge conflicts.
   */
  test('writes canonically: sorted slots and unique keys, byte-stable across construction order', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { spell: ['z', 'a', 'a'], lint: ['b'] } });
    const raw = await readFile(join(dir, 'checkride.baseline.json'), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    expect(Object.keys(parsed.slots)).toEqual(['lint', 'spell']);
    // Sorted, and the key a merge doubled is written once — slots are sets.
    expect(parsed.slots['spell']).toEqual(['a', 'z']);
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['b'], spell: ['a', 'z'] } });
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(raw);
  });

  test('parseBaseline applies the same tolerance to raw text (a git-show blob)', () => {
    expect(parseBaseline('{ not json')).toBeNull();
    expect(parseBaseline(JSON.stringify({ schema_version: 1, slots: { lint: ['a', 5] } }))?.slots['lint']).toEqual(['a']);
  });
});

describe('readBaselineStatus', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-status-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /**
   * Absent and unparseable both mask nothing, but they are different diagnoses:
   * absent is a repo without a baseline, unparseable is a file somebody (often
   * a merge) mangled. The run's warning hangs off this distinction.
   */
  test('distinguishes absent, ok, and unparseable', async () => {
    expect(readBaselineStatus(dir)).toEqual({ baseline: null, state: 'absent' });
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{ mangled\n');
    expect(readBaselineStatus(dir)).toEqual({ baseline: null, state: 'unparseable' });
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a'] } });
    expect(readBaselineStatus(dir).state).toBe('ok');
  });
});

describe('isFingerprintable', () => {
  test('true for adapters with an extractor, false for the rest', () => {
    expect(isFingerprintable('oxlint')).toBe(true);
    expect(isFingerprintable('ast-grep')).toBe(true);
    expect(isFingerprintable('cspell')).toBe(true);
    expect(isFingerprintable('fallow')).toBe(true);
    expect(isFingerprintable('vale')).toBe(true);
    expect(isFingerprintable('tsc')).toBe(false);
    expect(isFingerprintable('knip')).toBe(false);
  });

  test("the Go, Rust and shell linters' parsers feed the baseline, and cargo check's doesn't (D31)", () => {
    for (const adapter of ['golangci-lint', 'staticcheck', 'clippy', 'shellcheck']) expect(isFingerprintable(adapter), adapter).toBe(true);
    expect(isFingerprintable('cargo-check')).toBe(false);
  });
});

function capture(): { out: Out; text: () => string } {
  const chunks: string[] = [];
  return { out: { write: (t: string) => { chunks.push(t); return true; } }, text: () => chunks.join('') };
}

const blob = (keys: Record<string, string[]>): string => JSON.stringify({ schema_version: 1, slots: keys });

type FakeRefs = {
  prefix?: string;
  /** Ref → sha; a ref missing here names no commit. */
  refs?: Record<string, string>;
  /** Sha → the committed file's text; a sha missing here has no file. */
  files?: Record<string, string>;
  /** Per-subcommand failure overrides. */
  fail?: Record<string, GitResult>;
};

const answered = (stdout: string): GitResult => ({ ok: true, stdout });

function answerRevParse(repo: FakeRefs, args: readonly string[]): GitResult {
  if (args[1] === '--show-toplevel') return answered(`/repo\n${repo.prefix ?? ''}\nfalse\n`);
  const sha = repo.refs?.[(args[3] ?? '').replace(/\^\{commit\}$/, '')];
  return sha === undefined ? { ok: false, error: 'failed', detail: 'git rev-parse failed' } : answered(`${sha}\n`);
}

function answerShow(repo: FakeRefs, spec: string): GitResult {
  const text = repo.files?.[spec.split(':')[0] ?? ''];
  return text === undefined ? { ok: false, error: 'failed', detail: 'path does not exist' } : answered(text);
}

function answerLsTree(repo: FakeRefs, args: readonly string[]): GitResult {
  return answered(repo.files?.[args[3] ?? ''] === undefined ? '' : `${args[5] ?? ''}\n`);
}

const ANSWERS: Record<string, (repo: FakeRefs, args: readonly string[]) => GitResult> = {
  'rev-parse': answerRevParse,
  'ls-tree': answerLsTree,
  show: (repo, args) => answerShow(repo, args[1] ?? ''),
};

function answerDiff(repo: FakeRefs, args: readonly string[]): GitResult {
  const sub = args[0] ?? '';
  const answer = ANSWERS[sub];
  return repo.fail?.[sub] ?? answer?.(repo, args) ?? { ok: false, error: 'failed', detail: `unexpected: ${sub}` };
}

/** A scripted git for `baseline diff`: answers from the fixture, records every invocation. */
function diffGit(repo: FakeRefs): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    return Promise.resolve(answerDiff(repo, args));
  };
  return Object.assign(runner, { calls });
}

const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

describe('runBaselineDiff (unit, injected git)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-diff-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const writeCurrent = (keys: Record<string, string[]>): Promise<void> => writeBaseline(dir, { schema_version: 1, slots: keys });

  test('prints the keys added and removed per check, against HEAD by default', async () => {
    await writeCurrent({ lint: ['a', 'c'], struct: [] });
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({ lint: ['a', 'b'], spell: ['s'] }) } });
    const out = capture();
    const result = await runBaselineDiff({ cwd: dir, git, stdout: out.out });
    expect(result.exitCode).toBe(0);
    expect(result.diff).toEqual({
      ref: 'HEAD',
      sha: HEAD_SHA,
      added: { lint: ['c'] },
      removed: { lint: ['b'], spell: ['s'] },
      added_count: 1,
      removed_count: 2,
      recounted: {},
      recounted_count: 0,
    });
    expect(out.text()).toBe(
      [
        '# checkride baseline diff: HEAD (aaaaaaa) to the working tree',
        '',
        '1 key(s) added, 2 removed.',
        '',
        '## lint: 1 added, 1 removed',
        '',
        '+ c',
        '- b',
        '',
        '## spell: 0 added, 1 removed',
        '',
        '- s',
        '',
      ].join('\n'),
    );
  });

  /** A count that rises grandfathers one more finding under a key both copies hold, which a reviewer has to see (#14). */
  test('a key whose count changed is recounted, from and to, any for a check captured before counts', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a', 'b'], spell: ['s'] }, counts: { lint: { a: 3 }, spell: {} } });
    const before = JSON.stringify({ schema_version: 1, slots: { lint: ['a', 'b'], spell: ['s'] }, counts: { lint: { a: 2, b: 2 } } });
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: before } });
    const out = capture();
    const result = await runBaselineDiff({ cwd: dir, git, stdout: out.out });
    expect(result.diff).toMatchObject({
      added_count: 0,
      removed_count: 0,
      recounted: { lint: { a: { from: 2, to: 3 }, b: { from: 2, to: 1 } }, spell: { s: { from: null, to: 1 } } },
      recounted_count: 3,
    });
    expect(out.text()).toContain('0 key(s) added, 0 removed, 3 recounted.\n\n## lint: 0 added, 0 removed, 2 recounted\n\n~ a (2 → 3)\n~ b (2 → 1)\n');
    expect(out.text()).toContain('~ s (any → 1)');
  });

  test('--json prints the diff object and nothing else', async () => {
    await writeCurrent({ lint: ['a', 'c'] });
    const git = diffGit({ refs: { 'origin/main': OLD_SHA }, files: { [OLD_SHA]: blob({ lint: ['a'] }) } });
    const out = capture();
    const result = await runBaselineDiff({ cwd: dir, git, ref: 'origin/main', json: true, stdout: out.out });
    expect(JSON.parse(out.text())).toEqual(result.diff);
    expect(result.diff).toMatchObject({ ref: 'origin/main', sha: OLD_SHA, added: { lint: ['c'] }, removed: {} });
  });

  // F30: a ref from before the baseline existed.
  test('a ref with no baseline file reports every current key as added', async () => {
    await writeCurrent({ lint: ['a', 'b'], spell: ['s'] });
    const git = diffGit({ refs: { HEAD: HEAD_SHA } });
    const { diff } = await runBaselineDiff({ cwd: dir, git, stdout: capture().out });
    expect(diff).toMatchObject({ added: { lint: ['a', 'b'], spell: ['s'] }, removed: {}, added_count: 3, removed_count: 0 });
    // Told apart by listing the tree: the file was never `git show`n.
    expect(git.calls.some((c) => c[0] === 'show')).toBe(false);
  });

  test('a working tree with no baseline file reports every committed key as removed', async () => {
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({ lint: ['a'] }) } });
    const { diff } = await runBaselineDiff({ cwd: dir, git, stdout: capture().out });
    expect(diff).toMatchObject({ added: {}, removed: { lint: ['a'] }, added_count: 0, removed_count: 1 });
  });

  test('an unchanged file says so', async () => {
    await writeCurrent({ lint: ['a'] });
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({ lint: ['a'] }) } });
    const out = capture();
    await runBaselineDiff({ cwd: dir, git, stdout: out.out });
    expect(out.text()).toContain('No keys added or removed since HEAD.');
  });

  test('reads the committed file at its path from the git root, as a monorepo package', async () => {
    await writeCurrent({});
    const git = diffGit({ prefix: 'packages/app/', refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({}) } });
    await runBaselineDiff({ cwd: dir, git, stdout: capture().out });
    expect(git.calls).toContainEqual(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    expect(git.calls).toContainEqual(['ls-tree', '--full-tree', '--name-only', HEAD_SHA, '--', 'packages/app/checkride.baseline.json']);
    expect(git.calls).toContainEqual(['show', `${HEAD_SHA}:packages/app/checkride.baseline.json`]);
  });

  test.each<{ label: string; repo: FakeRefs; ref?: string; message: RegExp }>([
    { label: 'a ref that names no commit', repo: { refs: {} }, ref: 'nope', message: /'nope' does not name a commit/ },
    { label: 'a ref that reads as an option', repo: { refs: { HEAD: HEAD_SHA } }, ref: '--output=x', message: /'--output=x' is not a ref/ },
    { label: 'a directory outside git', repo: { fail: { 'rev-parse': { ok: false, error: 'not-a-repo', detail: 'fatal' } } }, message: /baseline diff: not inside a git repository/ },
    { label: 'a machine without git', repo: { fail: { 'rev-parse': { ok: false, error: 'missing', detail: 'git not found on PATH' } } }, message: /baseline diff: git is required/ },
    { label: 'a committed file that does not parse', repo: { refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: '<<<<<<< HEAD\n{' } }, message: /checkride\.baseline\.json at HEAD can't be parsed/ },
    { label: 'a committed file from a newer schema', repo: { refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: JSON.stringify({ schema_version: 2, slots: {} }) } }, message: /can't be parsed, or comes from a newer checkride/ },
    { label: 'a failing git show', repo: { refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({}) }, fail: { show: { ok: false, error: 'timeout', detail: 'git show timed out (>10s)' } } }, message: /baseline diff: git show timed out/ },
  ])('$label throws, which the CLI reports as exit 2', async ({ repo, ref, message }) => {
    await writeCurrent({ lint: ['a'] });
    const out = capture();
    await expect(runBaselineDiff({ cwd: dir, git: diffGit(repo), stdout: out.out, ...(ref !== undefined ? { ref } : {}) })).rejects.toThrow(message);
    expect(out.text()).toBe('');
  });

  test('a working-tree file that does not parse throws before git is asked anything', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{');
    const git = diffGit({ refs: { HEAD: HEAD_SHA } });
    await expect(runBaselineDiff({ cwd: dir, git, stdout: capture().out })).rejects.toThrow(/in the working tree can't be parsed/);
    expect(git.calls).toEqual([]);
  });
});

/** Is a real git usable here? Collected once; the integration suite skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const realGitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

describe.skipIf(!gitAvailable)('checkride baseline diff (CLI, real git)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-diff-git-'));
    realGitIn(dir, 'init', '-q');
    await writeFile(join(dir, 'README.md'), '# a repo from before the baseline\n');
    realGitIn(dir, 'add', '.');
    realGitIn(dir, 'commit', '-q', '-m', 'before the baseline');
    realGitIn(dir, 'tag', 'before');
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a', 'b'] } });
    realGitIn(dir, 'add', '.');
    realGitIn(dir, 'commit', '-q', '-m', 'adopt a baseline');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const deps = (stdout: Out, stderr: Out): { cwd: string; stdout: Out; stderr: Out } => ({ cwd: dir, stdout, stderr });

  test('diffs the working tree against HEAD and exits 0, keys added or not', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a', 'c'] } });
    const out = capture();
    expect(await runCli(['baseline', 'diff', '--json'], deps(out.out, capture().out))).toBe(0);
    const diff = JSON.parse(out.text()) as Record<string, unknown>;
    expect(diff).toMatchObject({ ref: 'HEAD', added: { lint: ['c'] }, removed: { lint: ['b'] } });
    expect(diff['sha']).toBe(realGitIn(dir, 'rev-parse', 'HEAD').trim());
  });

  test('a ref from before the baseline existed reports every key as added (F30)', async () => {
    const out = capture();
    expect(await runCli(['baseline', 'diff', 'before'], deps(out.out, capture().out))).toBe(0);
    expect(out.text()).toContain('2 key(s) added, 0 removed.');
    expect(out.text()).toContain('+ a\n+ b');
  });

  test.each<{ label: string; argv: string[]; message: RegExp }>([
    { label: 'a ref that does not resolve', argv: ['baseline', 'diff', 'no-such-ref'], message: /'no-such-ref' does not name a commit/ },
    { label: 'two refs', argv: ['baseline', 'diff', 'HEAD', 'before'], message: /takes one ref, got 2/ },
    { label: 'a flag only the capture takes', argv: ['baseline', 'diff', '--config', 'x.json'], message: /Unknown option '--config'/ },
  ])('$label exits 2', async ({ argv, message }) => {
    const out = capture();
    const err = capture();
    expect(await runCli(argv, deps(out.out, err.out))).toBe(2);
    expect(err.text()).toMatch(message);
    expect(out.text()).toBe('');
  });

  test('a stray argument to the capture exits 2 rather than rewriting the file', async () => {
    const before = await readFile(join(dir, 'checkride.baseline.json'), 'utf8');
    const err = capture();
    expect(await runCli(['baseline', '--config', 'x.json', 'diff'], deps(capture().out, err.out))).toBe(2);
    expect(err.text()).toMatch(/Unexpected argument 'diff'/);
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(before);
  });

  test('baseline --help prints its own text, naming diff', async () => {
    const out = capture();
    expect(await runCli(['baseline', 'diff', '--help'], deps(out.out, capture().out))).toBe(0);
    expect(out.text()).toContain('checkride baseline diff [<ref>] [--json]');
  });
});
