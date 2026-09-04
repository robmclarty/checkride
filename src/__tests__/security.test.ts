import { describe, expect, test } from 'vitest';

import type { CheckOutcome } from '../links.js';
import type { AuditSpawn } from '../security.js';
import { auditLevelFromArgs, checkSecurity } from '../security.js';

/** A canned `pnpm audit --json` payload with the given per-severity counts. */
function auditJson(counts: Partial<Record<'info' | 'low' | 'moderate' | 'high' | 'critical', number>>): string {
  return JSON.stringify({
    actions: [],
    advisories: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts },
    },
  });
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

describe('auditLevelFromArgs', () => {
  test('reads the declared level, defaulting to low (the tool default) when absent or bad', () => {
    expect(auditLevelFromArgs(DEFAULT_ARGS)).toBe('high');
    expect(auditLevelFromArgs(['audit', '--audit-level=critical'])).toBe('critical');
    expect(auditLevelFromArgs(['audit', '--json'])).toBe('low');
    expect(auditLevelFromArgs(['audit', '--audit-level=sideways'])).toBe('low');
  });
});

describe('checkSecurity', () => {
  const run = (payload: string, args: readonly string[] = DEFAULT_ARGS, record?: string[][]): Promise<CheckOutcome> =>
    checkSecurity({ cwd: '/tmp', command: 'pnpm', args, spawn: pnpmLikeSpawn(payload, record) });

  test('advisories below the level are green even though pnpm exited 1 (the reported bug)', async () => {
    // The consumer case: one moderate advisory, --audit-level=high. pnpm's
    // JSON mode exits 1 anyway; the slot must not gate at zero advisories.
    const outcome = await run(auditJson({ moderate: 1 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.exit_code).toBe(0);
    expect(outcome.stderr).toContain('below --audit-level=high');
  });

  test('advisories at or above the level fail, named by severity', async () => {
    const outcome = await run(auditJson({ moderate: 4, high: 2, critical: 1 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('--audit-level=high');
    expect(outcome.stderr).toContain('2 high');
    expect(outcome.stderr).toContain('1 critical');
    expect(outcome.stderr).not.toContain('moderate');
  });

  test('a consumer level override keeps meaning what it says', async () => {
    const high = auditJson({ high: 1 });
    expect((await run(high, ['audit', '--audit-level=critical', '--json'])).ok).toBe(true);
    const moderate = auditJson({ moderate: 1 });
    expect((await run(moderate, ['audit', '--json'])).ok).toBe(false); // absent level = low
  });

  test('zero advisories is green, and the audit JSON passes through for .check/security.json', async () => {
    const payload = auditJson({});
    const outcome = await run(payload);
    expect(outcome.ok).toBe(true);
    expect(outcome.stdout).toBe(payload);
  });

  test('appends --json when a consumer override dropped it', async () => {
    const record: string[][] = [];
    await run(auditJson({}), ['audit', '--audit-level=high'], record);
    expect(record[0]).toContain('--json');
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
