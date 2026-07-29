/**
 * Built-in `security` check — `pnpm audit` with checkride owning the verdict.
 *
 * pnpm's JSON mode exits 1 on *any* advisory regardless of `--audit-level`
 * (only table mode lets the level gate the exit code), so judging this slot by
 * exit code made it gate at zero advisories of any severity — not the level
 * the adapter's args declare. The evaluator here runs the audit with `--json`,
 * parses `metadata.vulnerabilities`, and fails only when advisories sit at or
 * above the threshold parsed from the args themselves, so a consumer override
 * of `--audit-level` keeps meaning what it says.
 *
 * "Could not run" (registry unreachable, malformed output) is distinguished
 * from "ran; everything below the level": the former fails with the error
 * surfaced, the latter is green. The raw audit JSON is passed through on
 * stdout, so the orchestrator persists `.check/security.json` as before.
 */

import { isRecord } from './json.js';
import type { CheckOutcome } from './links.js';
import { parseToolJson } from './tool-json.js';

/** The audit subprocess spawner — same signature as the orchestrator's `spawnCheck`. */
export type AuditSpawn = (
  command: string,
  args: string[],
  cwd: string,
  timeoutSec?: number,
) => Promise<CheckOutcome>;

/** `--audit-level` vocabulary, weakest first. `info` never gates (as in pnpm). */
const LEVELS = ['low', 'moderate', 'high', 'critical'] as const;
export type AuditLevel = (typeof LEVELS)[number];

/**
 * The gate threshold the args declare. Absent flag → `'low'`, mirroring the
 * tool's own default so the invocation and the verdict can never disagree; an
 * unrecognized value also falls back to `'low'` (gate wider, never narrower,
 * on a typo).
 */
export function auditLevelFromArgs(args: readonly string[]): AuditLevel {
  const flag = args.find((a) => a.startsWith('--audit-level='));
  const value = flag?.slice('--audit-level='.length);
  return LEVELS.find((l) => l === value) ?? 'low';
}

/** Per-severity advisory counts out of `metadata.vulnerabilities`, absent keys as 0. */
function severityCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const metadata = value['metadata'];
  if (!isRecord(metadata)) return null;
  const vulnerabilities = metadata['vulnerabilities'];
  if (!isRecord(vulnerabilities)) return null;
  const counts: Record<string, number> = {};
  for (const [severity, count] of Object.entries(vulnerabilities)) {
    counts[severity] = typeof count === 'number' ? count : 0;
  }
  return counts;
}

function fail(stdout: string, stderr: string): CheckOutcome {
  return { ok: false, exit_code: 1, stdout, stderr };
}

/**
 * Run the `security` check against `cwd`. `args` are the resolved adapter args
 * (`audit --audit-level=<l> …`, config overrides included); `--json` is
 * appended when an override dropped it, since the evaluator needs the payload.
 * Never throws: a spawn failure or unparseable output resolves to a failing
 * outcome that surfaces the tool's own message.
 */
export async function checkSecurity(opts: {
  cwd: string;
  command: string;
  args: readonly string[];
  spawn: AuditSpawn;
  timeoutSec?: number;
}): Promise<CheckOutcome> {
  const { cwd, command, spawn, timeoutSec } = opts;
  const args = opts.args.includes('--json') ? [...opts.args] : [...opts.args, '--json'];
  const level = auditLevelFromArgs(args);

  const outcome = await spawn(command, args, cwd, timeoutSec);
  const json = parseToolJson(outcome.stdout);
  const counts = json ? severityCounts(json.value) : null;
  if (!counts) {
    // No parseable verdict — the audit didn't run (registry down, bad flag,
    // timeout), which is a failure to verify, never a pass.
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    return fail(
      outcome.stdout,
      `check-security: ${command} audit produced no readable JSON verdict (exit ${outcome.exit_code})${detail ? `\n${detail.slice(0, 500)}` : ''}\n`,
    );
  }

  const gating = LEVELS.slice(LEVELS.indexOf(level));
  const above = gating.map((s) => [s, counts[s] ?? 0] as const).filter(([, n]) => n > 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (above.length === 0) {
    const note = total > 0 ? `${total} advisor${total === 1 ? 'y' : 'ies'} below --audit-level=${level}` : 'no advisories';
    return {
      ok: true,
      exit_code: 0,
      stdout: outcome.stdout,
      stderr: `check-security: ${note}; gate clean\n`,
    };
  }

  const breakdown = above.map(([s, n]) => `${n} ${s}`).join(', ');
  return fail(
    outcome.stdout,
    `check-security: advisories at or above --audit-level=${level}: ${breakdown}\n`,
  );
}
