import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ADAPTERS } from '../adapters.js';
import type { CheckOutcome } from '../links.js';
import type { AuditSpawn } from '../security.js';
import { auditLevelFromArgs, checkSecurity, fetchSettings } from '../security.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

type Counts = Partial<Record<'info' | 'low' | 'moderate' | 'high' | 'critical', number>>;

/** The per-severity totals of a canned report, every severity present. */
function totals(counts: Counts): Record<string, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts };
}

/** A canned `pnpm audit --json` payload: one `advisories` entry per count, and the totals beside them. */
function auditJson(counts: Counts): string {
  const entries = Object.entries(counts).flatMap(([severity, n]) => Array.from({ length: n }, () => severity));
  const advisories = Object.fromEntries(entries.map((severity, i) => [String(1000 + i), { id: 1000 + i, severity }]));
  return JSON.stringify({ actions: [], advisories, metadata: { vulnerabilities: totals(counts) } });
}

/** A canned payload with the totals alone, the shape of a report that carries no `advisories` map. */
function totalsOnly(counts: Counts): string {
  return JSON.stringify({ metadata: { vulnerabilities: totals(counts) } });
}

/** A spawner that hands back a report captured from pnpm, with the exit code pnpm gave it. */
function capturedSpawn(fixture: string, exitCode: number): AuditSpawn {
  return () => Promise.resolve({ ok: exitCode === 0, exit_code: exitCode, stdout: read(fixture), stderr: '' });
}

/**
 * A spawner reproducing pnpm's JSON-mode behavior: exit 1 whenever ANY
 * advisory exists, regardless of `--audit-level` — the bug the evaluator
 * exists to absorb.
 */
function pnpmLikeSpawn(payload: string, record?: string[][]): AuditSpawn {
  return (command, args) => {
    record?.push([command, ...args]);
    const parsed = JSON.parse(payload) as { metadata: { vulnerabilities: Record<string, number> } };
    const any = Object.values(parsed.metadata.vulnerabilities).some((n) => n > 0);
    return Promise.resolve({ ok: !any, exit_code: any ? 1 : 0, stdout: payload, stderr: '' });
  };
}

const DEFAULT_ARGS = ['audit', '--audit-level=high', '--json'];

/** The registry-unreachable shape: nonzero exit, nothing on stdout. */
const downSpawn: AuditSpawn = () =>
  Promise.resolve({ ok: false, exit_code: 1, stdout: '', stderr: 'ERR_PNPM_AUDIT_ENDPOINT ECONNREFUSED' });

/**
 * The shape pnpm actually emits when the advisory endpoint times out: exit 1
 * and its own JSON `error` on stdout, nothing on stderr (observed 2026-09-03,
 * pnpm 11.1.2, after its default retry schedule had run ~250s).
 */
const endpointTimeoutSpawn: AuditSpawn = () =>
  Promise.resolve({
    ok: false,
    exit_code: 1,
    stdout: '{"error":{"code":23,"message":"The operation was aborted due to timeout"}}',
    stderr: '',
  });

/** Parseable JSON that is not an audit payload at all. */
const weirdSpawn: AuditSpawn = () =>
  Promise.resolve({ ok: true, exit_code: 0, stdout: '{"unexpected": true}', stderr: '' });

/** An empty `advisories` map with no totals beside it, under a clean exit. */
const mapOnlySpawn: AuditSpawn = () =>
  Promise.resolve({ ok: true, exit_code: 0, stdout: '{"advisories": {}}', stderr: '' });

/** Run the security check over a canned audit `payload`, recording the argv it spawned. */
function runAudit(payload: string, args: readonly string[] = DEFAULT_ARGS, record?: string[][]): Promise<CheckOutcome> {
  return checkSecurity({ cwd: '/tmp', command: 'pnpm', args, spawn: pnpmLikeSpawn(payload, record) });
}

describe('auditLevelFromArgs', () => {
  test('reads the declared level, defaulting to low (the tool default) when absent or bad', () => {
    expect(auditLevelFromArgs(DEFAULT_ARGS)).toBe('high');
    expect(auditLevelFromArgs(['audit', '--audit-level=critical'])).toBe('critical');
    expect(auditLevelFromArgs(['audit', '--json'])).toBe('low');
    expect(auditLevelFromArgs(['audit', '--audit-level=sideways'])).toBe('low');
  });
});

describe('fetchSettings', () => {
  const BOUNDS = {
    npm_config_fetch_retries: '1',
    pnpm_config_fetch_retries: '1',
    npm_config_fetch_timeout: '15000',
    pnpm_config_fetch_timeout: '15000',
  };

  test('takes the fetch flags out of the args, and sets both prefixes of each in their place', () => {
    expect(fetchSettings(['audit', '--audit-level=high', '--json', '--fetch-retries=1', '--fetch-timeout=15000'])).toEqual({
      args: ['audit', '--audit-level=high', '--json'],
      env: BOUNDS,
    });
  });

  test('a flag written apart from its value takes the next argument as the value', () => {
    expect(fetchSettings(['audit', '--fetch-retries', '1', '--fetch-timeout', '15000', '--json'])).toEqual({
      args: ['audit', '--json'],
      env: BOUNDS,
    });
  });

  test('args without a fetch flag pass through whole and set nothing, so pnpm keeps its own defaults', () => {
    expect(fetchSettings(['audit', '--audit-level=critical', '--json'])).toEqual({ args: ['audit', '--audit-level=critical', '--json'], env: {} });
  });

  test('a flag with no value, or an empty one, is dropped rather than passed to a pnpm that refuses it', () => {
    expect(fetchSettings(['audit', '--fetch-timeout', '--json'])).toEqual({ args: ['audit', '--json'], env: {} });
    expect(fetchSettings(['audit', '--fetch-timeout=', '--json'])).toEqual({ args: ['audit', '--json'], env: {} });
  });
});

describe('checkSecurity', () => {
  test('advisories below the level are green even though pnpm exited 1 (the reported bug)', async () => {
    // The consumer case: one moderate advisory, --audit-level=high. pnpm's
    // JSON mode exits 1 anyway; the slot must not gate at zero advisories.
    const outcome = await runAudit(auditJson({ moderate: 1 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.exit_code).toBe(0);
    expect(outcome.stderr).toContain('below --audit-level=high');
  });

  test('advisories at or above the level fail, named by severity', async () => {
    const outcome = await runAudit(auditJson({ moderate: 4, high: 2, critical: 1 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('--audit-level=high');
    expect(outcome.stderr).toContain('2 high');
    expect(outcome.stderr).toContain('1 critical');
    expect(outcome.stderr).not.toContain('moderate');
  });

  test('a consumer level override keeps meaning what it says', async () => {
    const high = auditJson({ high: 1 });
    expect((await runAudit(high, ['audit', '--audit-level=critical', '--json'])).ok).toBe(true);
    const moderate = auditJson({ moderate: 1 });
    expect((await runAudit(moderate, ['audit', '--json'])).ok).toBe(false); // absent level = low
  });

  test('zero advisories is green, and the audit JSON passes through for .check/security.json', async () => {
    const payload = auditJson({});
    const outcome = await runAudit(payload);
    expect(outcome.ok).toBe(true);
    expect(outcome.stdout).toBe(payload);
  });

  test('appends --json when a consumer override dropped it', async () => {
    const record: string[][] = [];
    await runAudit(auditJson({}), ['audit', '--audit-level=high'], record);
    expect(record[0]).toContain('--json');
  });

  test("the registry row's fetch flags reach pnpm as variables, over the launch's own, and never as flags", async () => {
    // pnpm 9, 10 and 12 refuse the flags on `audit`, so passed as flags they
    // left the slot without a verdict on every pnpm but 11 (#8).
    const row = ADAPTERS.find((a) => a.name === 'pnpm-audit');
    const spawned: { args: string[]; env: Readonly<Record<string, string>> | undefined }[] = [];
    const spawn: AuditSpawn = (_command, args, _cwd, _timeout, env) => {
      spawned.push({ args, env });
      return Promise.resolve({ ok: true, exit_code: 0, stdout: auditJson({}), stderr: '' });
    };
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: row?.args ?? [], spawn, env: { MISE_OFFLINE: '1' } });
    expect(outcome.ok).toBe(true);
    expect(spawned).toEqual([
      {
        args: ['audit', '--audit-level=high', '--json'],
        env: {
          MISE_OFFLINE: '1',
          npm_config_fetch_retries: '1',
          pnpm_config_fetch_retries: '1',
          npm_config_fetch_timeout: '15000',
          pnpm_config_fetch_timeout: '15000',
        },
      },
    ]);
  });

  test('no readable JSON verdict (registry down, timeout) fails — never a silent pass', async () => {
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn: downSpawn });
    expect(outcome.ok).toBe(false);
    // -1, not 1: a failure to verify is the harness's problem, not a finding.
    expect(outcome.exit_code).toBe(-1);
    expect(outcome.stderr).toContain('no readable JSON verdict');
    expect(outcome.stderr).toContain('ECONNREFUSED');
  });

  test("pnpm's own error JSON is could-not-verify, with its message as the first-line reason", async () => {
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn: endpointTimeoutSpawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(-1);
    // One line the orchestrator can print under the status line, pnpm's words in it.
    expect(outcome.stderr.split('\n')[0]).toBe(
      'check-security: pnpm audit could not complete: The operation was aborted due to timeout (exit 1)',
    );
    // The raw JSON still rides stdout, so `.check/security.json` is written as before.
    expect(JSON.parse(outcome.stdout)).toMatchObject({ error: { code: 23 } });
  });

  test('JSON without metadata.vulnerabilities is a failure to verify, not a pass', async () => {
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn: weirdSpawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(-1);
  });

  test('tolerates a launcher preamble ahead of the JSON', async () => {
    const payload = `Already up to date\nDone in 210ms using pnpm v11.1.2\n${auditJson({ low: 1 })}`;
    const preamble: AuditSpawn = () => Promise.resolve({ ok: false, exit_code: 1, stdout: payload, stderr: '' });
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn: preamble });
    expect(outcome.ok).toBe(true); // 1 low sits below --audit-level=high
  });
});

describe('checkSecurity counts from the advisories map', () => {
  test('a report with no advisories map falls back to metadata.vulnerabilities', async () => {
    expect((await runAudit(totalsOnly({ high: 1 }))).ok).toBe(false);
    const below = await runAudit(totalsOnly({ moderate: 2 }));
    expect(below.ok).toBe(true);
    expect(below.stderr).toContain('2 advisories below --audit-level=high');
  });

  test('an entry without a severity falls back to the totals, so the gate widens rather than narrows', async () => {
    const payload = JSON.stringify({ advisories: { 1: { id: 1 } }, metadata: { vulnerabilities: totals({ high: 1 }) } });
    const outcome = await runAudit(payload);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('1 high');
  });

  test('an advisories map without metadata.vulnerabilities is still no audit report', async () => {
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn: mapOnlySpawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(-1);
  });

  // The three reports below were captured from pnpm 11.28.5 in this repo on
  // 2026-10-19, `--audit-level=high` unless named, with braces 3.0.3
  // (GHSA-vfj7-8cjw-p6xm, high) and katex 0.16.47 (GHSA-238p-pmpm-9mq7, low)
  // in the dev tree.

  test('an advisory the repo ignores leaves the gate, though the totals still count it', async () => {
    // braces ignored in `auditConfig.ignoreGhsas`: pnpm drops it from the map
    // and exits 0, while the totals keep `high: 1`, the count that held the
    // slot red before the gate read the map.
    const fixture = 'security-pnpm-audit-ignored.json';
    expect(JSON.parse(read(fixture))).toMatchObject({ advisories: {}, metadata: { vulnerabilities: { high: 1 } } });
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn: capturedSpawn(fixture, 0) });
    expect(outcome.ok).toBe(true);
    expect(outcome.exit_code).toBe(0);
    expect(outcome.stderr).toBe('check-security: no advisories at or above --audit-level=high; gate clean\n');
    expect(outcome.stdout).toBe(read(fixture));
  });

  test('the same advisory, not ignored, still fails the gate', async () => {
    const spawn = capturedSpawn('security-pnpm-audit.json', 1);
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: DEFAULT_ARGS, spawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(1);
    expect(outcome.stderr).toBe('check-security: advisories at or above --audit-level=high: 1 high\n');
  });

  test('at --audit-level=low the map keeps katex and still leaves the ignored braces out', async () => {
    const spawn = capturedSpawn('security-pnpm-audit-ignored-level-low.json', 1);
    const outcome = await checkSecurity({ cwd: '/tmp', command: 'pnpm', args: ['audit', '--json'], spawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toBe('check-security: advisories at or above --audit-level=low: 1 low\n');
  });
});
