/**
 * Built-in `security` check — `pnpm audit` with checkride owning the verdict.
 *
 * pnpm's JSON mode exits 1 on *any* advisory regardless of `--audit-level`
 * (only table mode lets the level gate the exit code), so judging this slot by
 * exit code made it gate at zero advisories of any severity — not the level
 * the adapter's args declare. The evaluator here runs the audit with `--json`,
 * counts the report's advisories by severity, and fails only when advisories
 * sit at or above the threshold parsed from the args themselves, so a consumer
 * override of `--audit-level` keeps meaning what it says.
 *
 * "Could not run" (registry unreachable, malformed output) is distinguished
 * from "ran; everything below the level": the former fails with the error
 * surfaced and `exit_code: -1` — the code the plugin's readers name a harness
 * problem, not a finding — the latter is green. The raw audit JSON is passed
 * through on stdout, so the orchestrator persists `.check/security.json` as
 * before.
 *
 * The args' `--fetch-<setting>` flags bound the wait on the advisory
 * endpoint, and they reach pnpm as environment variables rather than flags
 * ({@link fetchSettings}), since most pnpm releases refuse them on `audit`.
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
  env?: Readonly<Record<string, string>>,
) => Promise<CheckOutcome>;

/** A `--fetch-<setting>` flag, its setting, and the value it carries when written `--flag=value`. */
const FETCH_FLAG = /^--(fetch-[a-z-]+)(?:=(.*))?$/;

/** The variables one pnpm setting is read from: `npm_config_` up to pnpm 10, `pnpm_config_` from 11. */
function settingVariables(setting: string, value: string): Record<string, string> {
  const name = setting.replaceAll('-', '_');
  return { [`npm_config_${name}`]: value, [`pnpm_config_${name}`]: value };
}

/**
 * The audit's args with each `--fetch-<setting>` flag taken out, and the
 * variables that set it in their place. `pnpm audit` refuses the flags on
 * pnpm 9, 10 and 12 (`Unknown options: 'fetch-retries', 'fetch-timeout'`,
 * and 12's `unexpected argument`), so the slot could never reach a verdict
 * there, while every release reads the variables: 9 and 10 the
 * `npm_config_` ones, 11 and 12 the `pnpm_config_` ones, each ignoring the
 * other's. A flag written `--fetch-timeout 15000` takes the next argument as
 * its value, and one with no value, or an empty one, sets nothing. A setting
 * the args don't name keeps pnpm's own default, so a config that drops the
 * flags waits as long as pnpm does.
 */
export function fetchSettings(args: readonly string[]): { args: string[]; env: Record<string, string> } {
  const kept: string[] = [];
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const flag = FETCH_FLAG.exec(arg);
    if (flag === null) {
      kept.push(arg);
      continue;
    }
    const next = args[i + 1];
    const value = flag[2] ?? (next !== undefined && !next.startsWith('-') ? next : undefined);
    if (flag[2] === undefined && value !== undefined) i += 1;
    if (value !== undefined && value !== '' && flag[1] !== undefined) Object.assign(env, settingVariables(flag[1], value));
  }
  return { args: kept, env };
}

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

/**
 * One count per entry of the report's `advisories` map, by its `severity`.
 * pnpm leaves out of that map every advisory the repo's `auditConfig` ignores,
 * while `metadata.vulnerabilities` still counts them (pnpm 11.28.5), so only
 * the map lets an ignored advisory leave the gate. Null when the report has no
 * map, or an entry carries no severity, so the caller falls back to the totals:
 * wider, never narrower.
 */
function advisoryCounts(advisories: unknown): Record<string, number> | null {
  if (!isRecord(advisories)) return null;
  const counts: Record<string, number> = {};
  for (const advisory of Object.values(advisories)) {
    const severity = isRecord(advisory) ? advisory['severity'] : undefined;
    if (typeof severity !== 'string') return null;
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Per-severity advisory counts, absent keys as 0: out of the `advisories` map
 * where the report has one, else out of `metadata.vulnerabilities`. A report
 * without `metadata.vulnerabilities` is no audit report at all, map or not.
 */
function severityCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const metadata = value['metadata'];
  if (!isRecord(metadata)) return null;
  const vulnerabilities = metadata['vulnerabilities'];
  if (!isRecord(vulnerabilities)) return null;
  const fromMap = advisoryCounts(value['advisories']);
  if (fromMap) return fromMap;
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
 * pnpm's own error, when the audit ran but the advisory endpoint did not
 * answer: `{"error":{"code":23,"message":"The operation was aborted due to
 * timeout"}}` on stdout, nothing on stderr. Null for any other payload.
 */
function auditErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const error = value['error'];
  if (!isRecord(error)) return null;
  const message = error['message'];
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

/**
 * The outcome for an audit that reached no verdict — it did not run to
 * completion (registry down, fetch timeout, bad flag). A failure to verify is
 * never a pass, and it is not a finding either: -1 is the exit code a spawn
 * failure or timeout carries, and the one `triage` and the check skill read
 * as "harness problem", so the reader is sent to the network, not on a hunt
 * for an advisory. The first stderr line is the reason the orchestrator prints
 * under the slot; pnpm's own message rides it when the payload carried one.
 */
function noVerdict(command: string, outcome: CheckOutcome, json: ReturnType<typeof parseToolJson>): CheckOutcome {
  const message = json ? auditErrorMessage(json.value) : null;
  const headline = message
    ? `${command} audit could not complete: ${message}`
    : `${command} audit produced no readable JSON verdict`;
  const detail = message ? '' : outcome.stderr.trim() || outcome.stdout.trim();
  return {
    ok: false,
    exit_code: -1,
    stdout: outcome.stdout,
    stderr: `check-security: ${headline} (exit ${outcome.exit_code})${detail ? `\n${detail.slice(0, 500)}` : ''}\n`,
  };
}

/**
 * Run the `security` check against `cwd`. `args` are the resolved adapter args
 * (`audit --audit-level=<l> …`, config overrides included); `--json` is
 * appended when an override dropped it, since the evaluator needs the payload,
 * and each `--fetch-<setting>` flag is passed as the variables pnpm reads it
 * from instead ({@link fetchSettings}), over `env`, the variables its launch
 * sets. Never throws: a spawn failure or unparseable output resolves to a
 * failing outcome that surfaces the tool's own message.
 */
export async function checkSecurity(opts: {
  cwd: string;
  command: string;
  args: readonly string[];
  spawn: AuditSpawn;
  timeoutSec?: number;
  env?: Readonly<Record<string, string>>;
}): Promise<CheckOutcome> {
  const { cwd, command, spawn, timeoutSec } = opts;
  const fetch = fetchSettings(opts.args);
  const args = fetch.args.includes('--json') ? fetch.args : [...fetch.args, '--json'];
  const level = auditLevelFromArgs(args);

  const outcome = await spawn(command, args, cwd, timeoutSec, { ...opts.env, ...fetch.env });
  const json = parseToolJson(outcome.stdout);
  const counts = json ? severityCounts(json.value) : null;
  if (!counts) return noVerdict(command, outcome, json);

  const gating = LEVELS.slice(LEVELS.indexOf(level));
  const above = gating.map((s) => [s, counts[s] ?? 0] as const).filter(([, n]) => n > 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (above.length === 0) {
    // pnpm's map also drops advisories below `--audit-level`, so a zero here
    // speaks only for the gated severities.
    const note =
      total > 0
        ? `${total} advisor${total === 1 ? 'y' : 'ies'} below --audit-level=${level}`
        : `no advisories at or above --audit-level=${level}`;
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
