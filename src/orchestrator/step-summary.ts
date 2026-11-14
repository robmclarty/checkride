/**
 * A run's verdict as a GitHub Actions step summary: a Markdown table appended
 * to the file `GITHUB_STEP_SUMMARY` names, so the pull request's run page
 * shows each check, its status and time, how many new findings it failed on,
 * and the baseline keys it added and removed against the base. A run asked
 * for it (`--summary github`, else `CHECKRIDE_SUMMARY`) writes it once the
 * summary is written; nothing else about the run changes.
 *
 * The base is the one `--changed` resolves: `CHECKRIDE_BASE` (or `--base`),
 * then the config's `changedBase`, then `origin/main`. A base that can't be
 * read leaves the two key counts out and says why in their place, and an
 * unset `GITHUB_STEP_SUMMARY` warns on stderr and writes nothing: a summary
 * never changes a verdict.
 */

import { appendFile } from 'node:fs/promises';

import type { Baseline } from '../baseline/index.js';
import { BASELINE_SCHEMA_VERSION, diffBaselines, readBaselineAt, readBaselineStatus } from '../baseline/index.js';
import type { GitRunner } from '../git.js';
import type { Named } from '../suite.js';
import type { Out, Summary, SummaryCheck } from './types.js';

/** The variable that asks a run for a step summary, the way `--summary` does (the flag wins). The gate strips it from the check it spawns. */
export const SUMMARY_ENV = 'CHECKRIDE_SUMMARY';

/** The variable GitHub Actions sets to the file a step's summary is appended to. */
export const STEP_SUMMARY_FILE_ENV = 'GITHUB_STEP_SUMMARY';

/** The step summary formats a run can write. */
const SUMMARY_FORMATS = ['github'] as const;

/** A step summary format a run can write: GitHub Actions' Markdown step summary, the only one. */
export type StepSummaryFormat = (typeof SUMMARY_FORMATS)[number];

/**
 * A run's step summary as the run takes it: the format, and `file`, the path
 * `GITHUB_STEP_SUMMARY` named, `null` when it named none, which warns and
 * writes nothing.
 */
export type StepSummaryOption = { format: StepSummaryFormat; file: string | null };

/**
 * The format `asked` names (`--summary`, else `CHECKRIDE_SUMMARY`), or `null`
 * when neither was given. Any value but an accepted one is a usage error
 * naming what named it and what it accepts.
 */
export function stepSummaryFormat(asked: Named | null): StepSummaryFormat | null {
  if (asked === null) return null;
  const format = SUMMARY_FORMATS.find((f) => f === asked.value);
  if (format === undefined) throw new Error(`invalid ${asked.from} '${asked.value}' (expected ${SUMMARY_FORMATS.join(' | ')})`);
  return format;
}

/**
 * The baseline keys the working tree added and removed against the base, per
 * check, or why they weren't counted: the base names no commit, git can't be
 * asked, or either copy of the file can't be parsed.
 */
export type BaseKeys =
  | { ok: true; ref: string; sha: string; added: Record<string, string[]>; removed: Record<string, string[]> }
  | { ok: false; ref: string; why: string };

const EMPTY: Baseline = { schema_version: BASELINE_SCHEMA_VERSION, slots: {} };

/**
 * The keys `file` in `cwd` added and removed since `ref`, read as
 * `baseline diff <ref>` reads them, a file missing on either side as empty.
 * Every failure becomes the reason the counts are left out; nothing throws.
 */
export async function baseKeysOf(git: GitRunner, cwd: string, ref: string, file: string): Promise<BaseKeys> {
  const current = readBaselineStatus(cwd, 'current', file);
  if (current.state === 'unparseable') return { ok: false, ref, why: `${file} in the working tree can't be parsed` };
  try {
    const committed = await readBaselineAt(git, ref, file);
    const delta = diffBaselines(committed.baseline, current.baseline ?? EMPTY);
    return { ok: true, ref, sha: committed.sha, added: delta.restored, removed: delta.absent };
  } catch (err) {
    return { ok: false, ref, why: (err instanceof Error ? err.message : String(err)).replace(/^baseline diff: /, '') };
  }
}

/** A check's status as the table words it. */
function statusOf(check: SummaryCheck): string {
  return check.ok ? '✔ pass' : '✘ fail';
}

/** A duration in seconds to a tenth, or in milliseconds under a tenth of a second. */
function timeOf(ms: number): string {
  return ms < 100 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * How many new findings a check failed on: its `new_count`, none for a check
 * that passed, and `-` for a red check no baseline masked, whose findings the
 * summary doesn't count.
 */
function newOf(check: SummaryCheck): string {
  if (check.new_count !== undefined) return String(check.new_count);
  return check.ok ? '0' : '-';
}

/** The line beneath the table naming each check that sat out, or none when every check ran. */
function skippedOf(checks: readonly SummaryCheck[]): string[] {
  const skipped = checks.filter((c) => c.skipped === true).map((c) => `\`${c.name}\``);
  return skipped.length === 0 ? [] : [`Skipped: ${skipped.join(', ')}.`, ''];
}

/** The heading a table sits under, naming the suite, so a second run's table in the same step reads apart. */
function headingOf(suite: string | null): string {
  return `### checkride: ${suite === null ? 'default suite' : `suite ${suite}`}`;
}

/** The verdict line: how many checks passed or failed, the run's time, and whether it saw the whole pipeline. */
function verdictOf(summary: Summary): string {
  const ran = summary.checks.filter((c) => c.skipped !== true);
  const failed = ran.filter((c) => !c.ok).length;
  const counted = summary.ok ? `**✔ passed**: ${ran.length} check(s) ran` : `**✘ failed**: ${failed} of ${ran.length} check(s) failed`;
  const partial = summary.run.partial ? ', a partial run' : '';
  return `${counted} in ${timeOf(summary.total_duration_ms)}${partial}`;
}

/** How many keys one side of a diff holds, over every check. */
function keyCount(side: Record<string, string[]>): number {
  return Object.values(side).reduce((n, k) => n + k.length, 0);
}

/** The line that names the base the key counts are against, or why there are none. */
function baseLineOf(keys: BaseKeys): string {
  if (!keys.ok) return `Baseline keys not counted: the base \`${keys.ref}\` can't be read (${keys.why}).`;
  return `Baseline against \`${keys.ref}\` (${keys.sha.slice(0, 7)}): ${keyCount(keys.added)} key(s) added, ${keyCount(keys.removed)} removed.`;
}

/** One check's row, with its key counts when the base was read. */
function rowOf(check: SummaryCheck, keys: BaseKeys): string {
  const cells = [`\`${check.name}\``, statusOf(check), timeOf(check.duration_ms), newOf(check)];
  if (keys.ok) cells.push(String(keys.added[check.name]?.length ?? 0), String(keys.removed[check.name]?.length ?? 0));
  return `| ${cells.join(' | ')} |`;
}

/**
 * The step summary for `summary`: a heading naming the suite, the verdict,
 * the base line, one row per check that ran in the order the summary lists
 * them, and a line naming the checks that sat out. A base that can't be read
 * drops the two key columns.
 */
export function stepSummaryText(summary: Summary, keys: BaseKeys): string {
  const head = ['Check', 'Status', 'Time', 'New findings', ...(keys.ok ? ['Keys added', 'Keys removed'] : [])];
  const rule = ['---', '---', '---:', '---:', ...(keys.ok ? ['---:', '---:'] : [])];
  return [
    headingOf(summary.suite ?? null),
    '',
    verdictOf(summary),
    '',
    baseLineOf(keys),
    '',
    `| ${head.join(' | ')} |`,
    `| ${rule.join(' | ')} |`,
    ...summary.checks.filter((c) => c.skipped !== true).map((c) => rowOf(c, keys)),
    '',
    ...skippedOf(summary.checks),
    '',
  ].join('\n');
}

/** What {@link writeStepSummary} reads: where the run is, its baseline file, the base to count against, and git. */
export type StepSummaryScope = { cwd: string; baselineFile: string; baseRef: string; git: GitRunner; stderr: Out };

/**
 * Append the run's step summary to `option.file`. No file named, or one that
 * can't be written, warns on stderr and writes nothing; neither changes the
 * run's exit code.
 */
export async function writeStepSummary(option: StepSummaryOption, summary: Summary, scope: StepSummaryScope): Promise<void> {
  if (option.file === null || option.file === '') {
    scope.stderr.write(`--summary ${option.format}: ${STEP_SUMMARY_FILE_ENV} is not set, so no step summary is written\n`);
    return;
  }
  const keys = await baseKeysOf(scope.git, scope.cwd, scope.baseRef, scope.baselineFile);
  try {
    await appendFile(option.file, stepSummaryText(summary, keys));
  } catch (err) {
    scope.stderr.write(`--summary ${option.format}: can't append to ${option.file} (${err instanceof Error ? err.message : String(err)})\n`);
  }
}
