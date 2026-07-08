import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import { buildDigest, DIGEST_FILE, writeDigest } from '../digest/index.js';
import type { CheckOutcome } from '../links.js';
import type { CheckRun, CheckRunner, Out, SummaryCheck } from '../orchestrator.js';
import { runChecks } from '../orchestrator.js';

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

/** A failing check outcome; override `stdout`/`stderr` per case. */
function outcome(over: Partial<CheckOutcome> = {}): CheckOutcome {
  return { ok: false, exit_code: 1, stdout: '', stderr: '', ...over };
}

function run(adapter: Adapter, oc: CheckOutcome): CheckRun {
  return { slot: adapter.slot, adapter, outcome: oc };
}

/** A summary entry for a failing slot; override `ok`/`skipped` to vary it. */
function check(name: string, over: Partial<SummaryCheck> = {}): SummaryCheck {
  return { name, adapter: name, description: name, ok: false, exit_code: 1, duration_ms: 1, output_file: null, ...over };
}

/** An oxlint `--format=json` payload from `[file, code, message]` triples. */
function oxlint(findings: [string, string, string][]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message })) });
}

/** An ast-grep `--json=compact` payload from `[file, ruleId, message]` triples. */
function astGrep(findings: [string, string, string][]): string {
  return JSON.stringify(findings.map(([file, ruleId, message]) => ({ file, ruleId, message })));
}

function sink(): Out {
  return { write: () => true };
}

const redRunner: CheckRunner = () => Promise.resolve(outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }));
const greenRunner: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

describe('buildDigest', () => {
  const OXLINT = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' });

  test('returns null when nothing failed (green run)', () => {
    expect(buildDigest([], [])).toBeNull();
    expect(buildDigest([], [check('lint', { ok: true })])).toBeNull();
  });

  test('caps a slot at N findings and collapses the rest to a "… more" line', () => {
    const findings = Array.from({ length: 25 }, (_, i): [string, string, string] => [`f${i}.ts`, 'no-rule', `msg ${i}`]);
    const digest = buildDigest(
      [run(OXLINT, outcome({ stdout: oxlint(findings) }))],
      [check('lint', { adapter: 'oxlint', output_file: 'lint.json' })],
      { maxItemsPerSlot: 10, maxBytes: 100_000 },
    );
    expect(digest).not.toBeNull();
    const text = digest ?? '';
    // 10 rendered findings + one "… 15 more" bullet — never more than the cap.
    const bullets = text.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(11);
    expect(text).toContain('f0.ts:no-rule:msg 0');
    expect(text).toContain('f9.ts:no-rule:msg 9');
    expect(text).not.toContain('f10.ts'); // beyond the cap
    expect(text).toContain('… 15 more (see `.check/lint.json`)');
    expect(text).toContain('Raw: `.check/lint.json` — 25 finding(s)');
  });

  test('excludes a check the summary still marks ok (e.g. fully baselined)', () => {
    const digest = buildDigest(
      [run(OXLINT, outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }))],
      [check('lint', { ok: true, baselined: 1 }), check('spell')],
      { maxItemsPerSlot: 10, maxBytes: 100_000 },
    );
    // Only the genuinely-failing `spell` slot is summarized; `lint` passed.
    expect(digest).toContain('1 of 2 check(s) failed');
    expect(digest).not.toContain('## lint');
  });

  test('byte budget drops whole sections past the cap and names what was omitted', () => {
    const astAdapter = fakeAdapter({ name: 'ast-grep', slot: 'struct', outputFile: 'struct.json' });
    const lintRun = run(OXLINT, outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }));
    const structRun = run(astAdapter, outcome({ stdout: astGrep([['b.ts', 'no-y', 'worse']]) }));
    const lintCheck = check('lint', { adapter: 'oxlint', output_file: 'lint.json' });
    const structCheck = check('struct', { adapter: 'ast-grep', output_file: 'struct.json' });

    // Measure a one-section digest, then budget for exactly that: the second
    // section overflows and must be dropped (header length is digit-stable).
    const oneSection = buildDigest([lintRun], [lintCheck], { maxItemsPerSlot: 10, maxBytes: 1_000_000 }) ?? '';
    const budget = { maxItemsPerSlot: 10, maxBytes: Buffer.byteLength(oneSection, 'utf8') };

    const digest = buildDigest([lintRun, structRun], [lintCheck, structCheck], budget) ?? '';
    expect(digest).toContain('## lint');
    expect(digest).not.toContain('## struct');
    expect(digest).toContain('Digest truncated');
    expect(digest).toContain('1 more failing slot(s) omitted');
  });

  test('falls back to a text tail for a slot with no fingerprint extractor', () => {
    const tsc = fakeAdapter({ name: 'tsc', slot: 'types' }); // no extractor
    const lines = Array.from({ length: 15 }, (_, i) => `src/f.ts(${i},1): error TS0000: message ${i}`);
    const digest = buildDigest(
      [run(tsc, outcome({ stdout: lines.join('\n') }))],
      [check('types', { adapter: 'tsc' })],
      { maxItemsPerSlot: 5, maxBytes: 100_000 },
    ) ?? '';
    expect(digest).toContain('```'); // fenced raw excerpt, not a normalized list
    expect(digest).toContain('last 5 of 15 lines');
    expect(digest).toContain('message 14'); // the tail is kept
    expect(digest).not.toContain('message 0'); // the head is dropped
    expect(digest).toContain('Raw: `.check/types.stdout.txt`');
  });
});

describe('writeDigest (filesystem)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-digest-'));
    await mkdir(join(dir, '.check'), { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes digest.md on failure and leaves the raw output byte-identical', async () => {
    const rawPath = join(dir, '.check', 'lint.json');
    const raw = oxlint([['a.ts', 'no-x', 'bad'], ['b.ts', 'no-y', 'worse']]);
    await writeFile(rawPath, raw);

    const oxlintAdapter = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' });
    const wrote = await writeDigest(
      dir,
      [run(oxlintAdapter, outcome({ stdout: raw }))],
      [check('lint', { adapter: 'oxlint', output_file: 'lint.json' })],
    );
    expect(wrote).toBe(true);
    expect(await readFile(join(dir, '.check', DIGEST_FILE), 'utf8')).toContain('## lint — oxlint');
    // The raw file the digest points at is never rewritten.
    expect(await readFile(rawPath, 'utf8')).toBe(raw);
  });

  test('a green run removes a stale digest so the file always means "failed"', async () => {
    const digestPath = join(dir, '.check', DIGEST_FILE);
    await writeFile(digestPath, '# stale digest from a prior red run\n');
    const wrote = await writeDigest(dir, [], [check('lint', { ok: true })]);
    expect(wrote).toBe(false);
    expect(existsSync(digestPath)).toBe(false);
  });
});

describe('runChecks --digest wiring', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-digest-orc-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const oxlintAdapter = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' });
  const slots = [{ name: 'lint' }];

  const opts = (runner: CheckRunner, digest: boolean) => ({
    cwd: dir, slots, adapters: [oxlintAdapter], config: null, runner, digest,
    json: true, stdout: sink(), stderr: sink(),
  });

  test('writes .check/digest.md, pointing at the untouched raw file', async () => {
    await runChecks(opts(redRunner, true));
    const digest = await readFile(join(dir, '.check', DIGEST_FILE), 'utf8');
    expect(digest).toContain('## lint — oxlint');
    expect(digest).toContain('.check/lint.json');
    // The raw output the run persisted is still valid, unmodified JSON.
    expect(JSON.parse(await readFile(join(dir, '.check', 'lint.json'), 'utf8'))).toMatchObject({
      diagnostics: [{ filename: 'a.ts' }],
    });
  });

  test('writes no digest without the flag', async () => {
    await runChecks(opts(redRunner, false));
    expect(existsSync(join(dir, '.check', DIGEST_FILE))).toBe(false);
  });

  test('a subsequent green --digest run clears the stale digest', async () => {
    await runChecks(opts(redRunner, true));
    expect(existsSync(join(dir, '.check', DIGEST_FILE))).toBe(true);
    await runChecks(opts(greenRunner, true));
    expect(existsSync(join(dir, '.check', DIGEST_FILE))).toBe(false);
  });
});
