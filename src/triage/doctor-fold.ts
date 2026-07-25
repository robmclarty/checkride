/**
 * Folding `checkride doctor` into the broken-harness branch.
 *
 * Exit 2 means the harness broke or was misused, and every check result from
 * that run is untrustworthy. "Broken harness" on its own costs a round-trip:
 * the agent has to go ask what broke. `doctor` already answers that — it is
 * read-only, runs no checks, and splits 0/1 the same way — so triage runs it at
 * the one moment it is the right answer and arrives with the diagnosis attached.
 *
 * It is spawned as `node <repo's checkride>/dist/cli.js doctor --json`, not
 * through the package manager: `<pm> exec` can print its own noise onto stdout,
 * and the JSON report is the thing being parsed. It is also deliberately the
 * *repo's* installed checkride rather than the one this reader ships inside —
 * diagnosing an environment with a different version's doctor is how a reader
 * reports a problem the repo does not have.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asStringOrNull, isRecord, parseJson } from '../artifacts/index.js';
import type { TriageEnv } from './env.js';

/** One required doctor row that is not ok — an environment problem to fix. */
export type DoctorFinding = {
  name: string;
  status: string;
  found: string | null;
  expected: string | null;
  hint: string | null;
};

/** What the fold-in produced. Every state is reportable; none is an error. */
export type DoctorFold =
  | { state: 'ran'; ok: boolean; exitCode: number | null; findings: DoctorFinding[] }
  | { state: 'unavailable'; reason: string }
  | { state: 'unreadable'; reason: string };

/** A doctor probe is a read; it should never be the thing that hangs a triage. */
const DOCTOR_TIMEOUT_MS = 120_000;

/** Read a package.json `name` field, or `null` when it cannot be read. */
function packageName(cwd: string): string | null {
  try {
    const pkg: { name?: string } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

/**
 * The checkride CLI this repo would run: its installed copy, or its own build
 * when `cwd` *is* the checkride package (the dogfooding case). Never some other
 * repo's `dist/cli.js` — the package name has to say so.
 */
export function resolveCheckrideCli(cwd: string): string | null {
  const installed = join(cwd, 'node_modules', 'checkride', 'dist', 'cli.js');
  if (existsSync(installed)) return installed;
  const own = join(cwd, 'dist', 'cli.js');
  if (packageName(cwd) === 'checkride' && existsSync(own)) return own;
  return null;
}

/** Narrow one `checks[]` row to a finding, or `null` when it is not a problem. */
function toFinding(value: unknown): DoctorFinding | null {
  if (!isRecord(value)) return null;
  if (value['required'] !== true || value['status'] === 'ok') return null;
  return {
    name: asStringOrNull(value['name']) ?? 'unnamed check',
    status: asStringOrNull(value['status']) ?? 'unknown',
    found: asStringOrNull(value['found']),
    expected: asStringOrNull(value['expected']),
    hint: asStringOrNull(value['hint']),
  };
}

/** Pull the required-and-not-ok rows out of a `doctor --json` report. */
function readFindings(stdout: string): DoctorFinding[] | null {
  const report = parseJson(stdout);
  if (!isRecord(report)) return null;
  const checks = report['checks'];
  if (!Array.isArray(checks)) return null;
  return checks.map(toFinding).filter((f): f is DoctorFinding => f !== null);
}

/**
 * Run the repo's `checkride doctor --json` and extract what is broken. Never
 * throws; an absent or unparseable doctor is reported as such so the report can
 * say "the harness broke and I could not ask why" instead of inventing a cause.
 */
export async function foldDoctor(cwd: string, env: TriageEnv): Promise<DoctorFold> {
  const cli = resolveCheckrideCli(cwd);
  if (cli === null) {
    return { state: 'unavailable', reason: 'checkride is not installed in this repo (no node_modules/checkride)' };
  }
  const outcome = await env.spawn(process.execPath, [cli, 'doctor', '--json'], { cwd, timeoutMs: DOCTOR_TIMEOUT_MS });
  if (outcome.error !== null) return { state: 'unreadable', reason: `could not run doctor: ${outcome.error}` };
  const findings = readFindings(outcome.stdout);
  if (findings === null) return { state: 'unreadable', reason: 'doctor --json did not produce a readable report' };
  return { state: 'ran', ok: outcome.code === 0, exitCode: outcome.code, findings };
}
