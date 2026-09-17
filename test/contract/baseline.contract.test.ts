/**
 * Contract: the committed baseline file (docs/contract.md §checkride.baseline.json).
 *
 * The file `checkride baseline` writes must validate against the published
 * schema (`schema/checkride.baseline.schema.json`) exactly, be byte-canonical,
 * carry keys that name a finding by what it is rather than where it sits, and
 * read tolerantly — never breaking a run, and failing closed on a newer
 * version. Several of these are also covered as unit tests in
 * `src/__tests__/baseline.test.ts`; this file re-asserts the promised subset
 * on purpose, because a break here is a version decision, not a test edit.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter, Slot } from '../../src/adapters.js';
import type { Baseline } from '../../src/baseline/index.js';
import { BASELINE_FILE, BASELINE_SCHEMA_VERSION, fingerprint, parseBaseline, writeBaseline } from '../../src/baseline/index.js';
import { runBaseline } from '../../src/baseline-command.js';
import type { CheckRunner, Out } from '../../src/orchestrator/index.js';
import { runChecks } from '../../src/orchestrator/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', '..', 'schema');

const ajv = new Ajv({ allErrors: true });
const validateBaseline = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'checkride.baseline.schema.json'), 'utf8')) as object);
const validateSummary = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'checkride.summary.schema.json'), 'utf8')) as object);

function sink(): { out: Out; text: () => string } {
  const chunks: string[] = [];
  return { out: { write: (t: string) => { chunks.push(t); return true; } }, text: () => chunks.join('') };
}

// --- fixtures: the tools' own report shapes, inline so the contract stays self-contained ---

/** oxlint --format=json: the same finding at two positions, plus one whose message wraps. */
const OXLINT_REPORT = JSON.stringify({
  diagnostics: [
    { filename: 'src/a.ts', code: 'eslint(no-unused-vars)', message: "Variable 'x' is declared but never used.", labels: [{ span: { line: 3 } }] },
    { filename: 'src/a.ts', code: 'eslint(no-unused-vars)', message: "Variable 'x' is declared but never used.", labels: [{ span: { line: 40 } }] },
    { filename: 'src/b.ts', code: 'eslint(no-explicit-any)', message: 'Unexpected any.\n   Specify a different type.', labels: [{ span: { line: 7 } }] },
  ],
});
const OXLINT_KEYS = [
  "src/a.ts:eslint(no-unused-vars):Variable 'x' is declared but never used.",
  'src/b.ts:eslint(no-explicit-any):Unexpected any. Specify a different type.',
];

/** cspell's default reporter line. */
const CSPELL_REPORT = 'docs/old.md:3:7 - teh\n';

/** vale --output=JSON: an alert report with one error and one warning, and a runtime-error report. */
const VALE_ALERTS = JSON.stringify({
  'docs/a.md': [
    { Check: 'Repo.Latin', Message: "Use 'for example' instead of 'e.g.'.", Severity: 'error' },
    { Check: 'Repo.Weasel', Message: "Consider removing 'very'.", Severity: 'warning' },
  ],
});
const VALE_RUNTIME_ERROR = JSON.stringify({ Code: 'E100', Text: 'no config file found', Path: '', Line: 0, Span: [0, 0] });

function adapter(name: string, slot: string, outputFile: string | null): Adapter {
  return { name, slot, description: name, detect: [], command: 'node', args: [], outputFile, devDeps: {} };
}

// Real adapter *names* on fake commands: the extractor dispatch is by name, and
// nothing here spawns — the runner supplies each slot's report.
const ADAPTERS: Adapter[] = [adapter('cspell', 'spell', null), adapter('oxlint', 'lint', 'lint.json'), adapter('tsc', 'types', null)];
// Listed out of alphabetical order on purpose: the file must not care.
const SLOTS: Slot[] = [{ name: 'spell' }, { name: 'lint' }, { name: 'types' }];

const REPORTS: Record<string, string> = { lint: OXLINT_REPORT, spell: CSPELL_REPORT, types: '' };

/** Every slot with findings is red (as the real tools would be); `types` is clean. */
const redRunner: CheckRunner = (r) => {
  const stdout = REPORTS[r.slot] ?? '';
  const ok = stdout === '';
  return Promise.resolve({ ok, exit_code: ok ? 0 : 1, stdout, stderr: '' });
};

describe('checkride.baseline.json', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baselinePath = (): string => join(dir, BASELINE_FILE);

  async function capture(): Promise<{ raw: string; parsed: Baseline }> {
    await runBaseline({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, stdout: sink().out, stderr: sink().out });
    const raw = await readFile(baselinePath(), 'utf8');
    return { raw, parsed: JSON.parse(raw) as Baseline };
  }

  test('the file name and schema version constants are the contract', () => {
    // The generated `protect` hook denies edits to the file by this name.
    expect(BASELINE_FILE).toBe('checkride.baseline.json');
    expect(BASELINE_SCHEMA_VERSION).toBe(1);
  });

  test('a captured baseline validates against the published schema and is byte-canonical', async () => {
    const { raw, parsed } = await capture();
    const valid = validateBaseline(parsed);
    expect(validateBaseline.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(parsed.schema_version).toBe(BASELINE_SCHEMA_VERSION);
    // Sorted slots, sorted keys within each, two-space indent, trailing newline —
    // JSON.parse keeps on-disk key order, so one comparison pins all four.
    expect(Object.keys(parsed.slots)).toEqual(Object.keys(parsed.slots).toSorted());
    for (const keys of Object.values(parsed.slots)) expect(keys).toEqual(keys.toSorted());
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    // A slot with no extractor is absent; a fingerprintable one is present.
    expect(parsed.slots['types']).toBeUndefined();
    expect(parsed.slots['lint']).toEqual(OXLINT_KEYS);
    expect(parsed.slots['spell']).toEqual(['docs/old.md::teh']);
  });

  test('construction order and duplicate keys never reach the disk', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { spell: ['z', 'a', 'a'], lint: ['b'] } });
    const first = await readFile(baselinePath(), 'utf8');
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['b'], spell: ['a', 'z'] } });
    expect(await readFile(baselinePath(), 'utf8')).toBe(first);
    expect((JSON.parse(first) as Baseline).slots).toEqual({ lint: ['b'], spell: ['a', 'z'] });
  });

  test('keys carry no line or column, collapse whitespace, and are absent for a slot with no extractor', () => {
    const lint = fingerprint('oxlint', OXLINT_REPORT);
    expect(lint).not.toBeNull();
    // Two positions of one finding collapse to one key; the wrapped message is one line.
    expect([...(lint ?? [])].toSorted()).toEqual(OXLINT_KEYS);
    for (const k of lint ?? []) expect(k).not.toMatch(/:\d+:\d+/);
    expect(fingerprint('cspell', CSPELL_REPORT)).toEqual(new Set(['docs/old.md::teh']));
    expect(fingerprint('tsc', 'anything')).toBeNull();
  });

  test('vale keys only error-severity alerts and refuses a runtime-error report', () => {
    expect(fingerprint('vale', VALE_ALERTS)).toEqual(new Set(["docs/a.md:Repo.Latin:Use 'for example' instead of 'e.g.'."]));
    // A report that is not an alert report is "not observed" (null), never "clean" (empty).
    expect(fingerprint('vale', VALE_RUNTIME_ERROR)).toBeNull();
    expect(fingerprint('vale', '{}')).toEqual(new Set());
  });

  test.each<{ label: string; raw: string; expected: Baseline | null }>([
    { label: 'an unknown top-level field is ignored', raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a'] }, extra: true }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'a missing schema_version reads as 1', raw: JSON.stringify({ slots: { lint: ['a'] } }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'a newer schema_version is dropped whole', raw: JSON.stringify({ schema_version: 2, slots: { lint: ['a'] } }), expected: null },
    { label: 'slots as an array is rejected', raw: JSON.stringify({ schema_version: 1, slots: [['a']] }), expected: null },
    { label: 'non-string keys and non-array slots are dropped', raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a', 5, null], types: 'nope' } }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'malformed JSON is null', raw: '{ not json', expected: null },
    { label: 'empty text is null', raw: '', expected: null },
    { label: 'a JSON array is null', raw: '[]', expected: null },
    { label: 'JSON null is null', raw: 'null', expected: null },
  ])('read is tolerant: $label', ({ raw, expected }) => {
    expect(parseBaseline(raw)).toEqual(expected);
  });

  test('a capture masks the next run, and summary.json says so', async () => {
    const { parsed } = await capture();
    const result = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, json: true, stdout: sink().out, stderr: sink().out });
    expect(result.ok).toBe(true);
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
      checks: { name: string; ok: boolean; baselined?: number }[];
    };
    expect(validateSummary(summary)).toBe(true);
    const lint = summary.checks.find((c) => c.name === 'lint');
    const spell = summary.checks.find((c) => c.name === 'spell');
    expect(lint).toMatchObject({ ok: true, baselined: parsed.slots['lint']?.length });
    expect(spell).toMatchObject({ ok: true, baselined: parsed.slots['spell']?.length });
  });

  test.each<{ label: string; raw: string }>([
    { label: 'an unparseable file (a botched merge)', raw: '<<<<<<< HEAD\n{\n' },
    { label: 'a file from a newer schema version', raw: JSON.stringify({ schema_version: 2, slots: { lint: OXLINT_KEYS, spell: ['docs/old.md::teh'] } }) },
  ])('$label masks nothing, and the run says so', async ({ raw }) => {
    await writeFile(baselinePath(), raw);
    const stderr = sink();
    const result = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, json: false, stdout: sink().out, stderr: stderr.out });
    expect(result.ok).toBe(false);
    const lint = result.summary.checks.find((c) => c.name === 'lint');
    expect(lint?.ok).toBe(false);
    expect(lint?.baselined).toBeUndefined();
    expect(stderr.text()).toMatch(/unparseable/);
  });
});
