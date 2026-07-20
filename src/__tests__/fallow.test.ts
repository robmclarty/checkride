import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import { fallowVerdict } from '../baseline/index.js';
import type { CheckRunner, Out } from '../orchestrator.js';
import { runChecks } from '../orchestrator.js';

// ---------------------------------------------------------------------------
// Fixtures: fallow v7 (schema_version 7) reports, built to shape.
// ---------------------------------------------------------------------------

/** A dead-code report with one finding per listed [category, file] pair. */
function deadCode(findings: [string, string][]): string {
  const byCategory: Record<string, { path: string }[]> = {};
  for (const [category, path] of findings) (byCategory[category] ??= []).push({ path });
  const summary: Record<string, number> = { total_issues: findings.length };
  for (const [category, items] of Object.entries(byCategory)) summary[category] = items.length;
  return JSON.stringify({ schema_version: 7, kind: 'dead-code', summary, ...byCategory });
}

/** A dupes report with the given clone-group content fingerprints. */
function dupes(fingerprints: string[]): string {
  return JSON.stringify({
    schema_version: 7,
    kind: 'dupes',
    clone_groups: fingerprints.map((fingerprint) => ({ fingerprint })),
  });
}

const sink = (): Out => ({ write: () => true });

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

/** A runner that hands the given process outcome to whatever slot runs. */
function staticRunner(outcome: { ok: boolean; exit_code: number; stdout: string }): CheckRunner {
  return () => Promise.resolve({ ...outcome, stderr: '' });
}

// ---------------------------------------------------------------------------
// fallowVerdict — the parsed pass/fail decision
// ---------------------------------------------------------------------------

describe('fallowVerdict (no baseline)', () => {
  test('findings fail the slot even though fallow exited 0', () => {
    const v = fallowVerdict(deadCode([['unused_files', 'src/a.ts']]), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('1 finding(s)');
    expect(v.observed).toBe(true);
    expect(v.findings).toEqual(new Set(['dead-code:unused_files:src/a.ts']));
  });

  test('a clean report passes', () => {
    const v = fallowVerdict(deadCode([]), null);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.observed).toBe(true);
  });

  test('dupes gate on clone groups (fallow itself exits 0 on any duplication)', () => {
    const v = fallowVerdict(dupes(['dup:aaaa', 'dup:bbbb']), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('2 finding(s)');
    expect(v.findings).toEqual(new Set(['dupes:dup:aaaa', 'dupes:dup:bbbb']));
  });
});

describe('fallowVerdict (unreadable report → loud failure, never a silent pass)', () => {
  test('an old/unsupported schema fails with an explicit reason', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 4, kind: 'dead-code', summary: { total_issues: 0 } }), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('schema_version 4');
    expect(v.observed).toBe(false); // don't ratchet a baseline from a run we couldn't read
  });

  test('an unrecognized kind fails', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 7, kind: 'flags' }), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("kind 'flags'");
  });

  test('empty / non-JSON output fails (a crash is not clean)', () => {
    expect(fallowVerdict('', null).ok).toBe(false);
    expect(fallowVerdict('boom: fatal error', null).ok).toBe(false);
  });

  test('a missing count field fails rather than reading zero issues', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 7, kind: 'dead-code', summary: {} }), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('total_issues');
  });
});

describe('fallowVerdict (with baseline)', () => {
  test('a fully-grandfathered slot passes and counts the masked findings', () => {
    const raw = deadCode([['unused_files', 'src/a.ts'], ['unused_files', 'src/b.ts']]);
    const v = fallowVerdict(raw, ['dead-code:unused_files:src/a.ts', 'dead-code:unused_files:src/b.ts']);
    expect(v.ok).toBe(true);
    expect(v.baselined).toBe(2);
    expect(v.newKeys).toEqual([]);
  });

  test('a new finding not in the baseline fails and is named', () => {
    const raw = deadCode([['unused_files', 'src/a.ts'], ['unused_files', 'src/new.ts']]);
    const v = fallowVerdict(raw, ['dead-code:unused_files:src/a.ts']);
    expect(v.ok).toBe(false);
    expect(v.baselined).toBe(1);
    expect(v.newKeys).toEqual(['dead-code:unused_files:src/new.ts']);
  });

  test('members in one file get distinct <parent>.<member> keys, so all are tracked', () => {
    // Two unused members of one class in one file: without composition they both
    // collapse to `dead-code:unused_class_members:src/a.ts`, so findings.size (1)
    // trails the issue count (2) and the slot can never be masked green.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_class_members: 2 },
      unused_class_members: [
        { path: 'src/a.ts', parent_name: 'Svc', member_name: 'foo' },
        { path: 'src/a.ts', parent_name: 'Svc', member_name: 'bar' },
      ],
    });
    const keys = ['dead-code:unused_class_members:src/a.ts:Svc.foo', 'dead-code:unused_class_members:src/a.ts:Svc.bar'];
    const v = fallowVerdict(raw, keys);
    expect(v.findings).toEqual(new Set(keys));
    expect(v.ok).toBe(true);
    expect(v.baselined).toBe(2);
  });

  test('component inputs/outputs compose <component>.<field>', () => {
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_component_inputs: 1, unused_component_outputs: 1 },
      unused_component_inputs: [{ path: 'src/c.ts', component_name: 'Card', input_name: 'title' }],
      unused_component_outputs: [{ path: 'src/c.ts', component_name: 'Card', output_name: 'closed' }],
    });
    const v = fallowVerdict(raw, null);
    expect(v.findings).toEqual(
      new Set([
        'dead-code:unused_component_inputs:src/c.ts:Card.title',
        'dead-code:unused_component_outputs:src/c.ts:Card.closed',
      ]),
    );
  });

  test('non-counted arrays (workspace_diagnostics) are not fingerprinted', () => {
    // workspace_diagnostics carries a path but is absent from total_issues;
    // fingerprinting it would make findings.size (2) exceed issueCount (1) and
    // wrongly block masking. It must be skipped so the slot stays fully tracked.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 1, unused_files: 1 },
      unused_files: [{ path: 'src/a.ts' }],
      workspace_diagnostics: [{ kind: 'tsconfig', message: 'no rootDir', path: 'tsconfig.json' }],
    });
    const v = fallowVerdict(raw, ['dead-code:unused_files:src/a.ts']);
    expect(v.findings).toEqual(new Set(['dead-code:unused_files:src/a.ts']));
    expect(v.ok).toBe(true);
  });

  test('untracked findings (count exceeds fingerprints) block masking to green', () => {
    // summary claims 2 issues, but only one carries a fingerprintable identity.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_files: 1, unused_store_members: 1 },
      unused_files: [{ path: 'src/a.ts' }],
      // unused_store_members present in the count but with no readable identity
      unused_store_members: [{ note: 'opaque' }],
    });
    const v = fallowVerdict(raw, ['dead-code:unused_files:src/a.ts']);
    expect(v.ok).toBe(false); // cannot be masked green: one finding is untracked
    expect(v.reason).toBe('2 finding(s)');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator gating — the acceptance criterion: a non-zero finding count
// fails the slot even when fallow's process exits 0.
// ---------------------------------------------------------------------------

describe('runChecks — the fallow (dead) slot gates on findings, not the exit code', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-fallow-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const deadAdapter = fakeAdapter({ name: 'fallow', slot: 'dead', outputFile: 'dead.json', gate: 'fallow' });

  async function run(runner: CheckRunner, baseline?: Baseline | null) {
    return runChecks({
      cwd: dir, slots: [{ name: 'dead' }], adapters: [deadAdapter], config: null,
      runner, baseline: baseline ?? null, json: true, stdout: sink(), stderr: sink(),
    });
  }

  test('findings + exit 0 → the slot FAILS (fallow JSON mode exits 0 regardless)', async () => {
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout: deadCode([['unused_files', 'src/a.ts']]) }));
    const dead = result.summary.checks.find((c) => c.name === 'dead');
    expect(dead?.ok).toBe(false);
    expect(result.ok).toBe(false);
    // the raw report is still persisted untouched for agents to read
    expect(JSON.parse(await readFile(join(dir, '.check', 'dead.json'), 'utf8'))).toMatchObject({ kind: 'dead-code' });
  });

  test('a clean report + exit 0 → the slot PASSES', async () => {
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout: deadCode([]) }));
    expect(result.summary.checks.find((c) => c.name === 'dead')?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('an unsupported schema + exit 0 → the slot FAILS (never a silent pass)', async () => {
    const stdout = JSON.stringify({ schema_version: 4, kind: 'dead-code', summary: { total_issues: 0 } });
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout }));
    expect(result.summary.checks.find((c) => c.name === 'dead')?.ok).toBe(false);
  });

  test('a committed baseline grandfathers the findings back to green', async () => {
    const stdout = deadCode([['unused_files', 'src/a.ts']]);
    const baseline: Baseline = { schema_version: 1, slots: { dead: ['dead-code:unused_files:src/a.ts'] } };
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout }), baseline);
    const dead = result.summary.checks.find((c) => c.name === 'dead');
    expect(dead?.ok).toBe(true);
    expect(dead?.baselined).toBe(1);
  });
});
