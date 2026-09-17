/**
 * Terminal output and the summary shape: the status-line formatter, the
 * skipped-row builders, the `.check/summary.json` assembler, the end-of-run
 * report with its vacuous-green warning, and the 0/1/2 exit taxonomy. Pure
 * over its inputs — nothing here spawns or reads the filesystem.
 */

import type { Adapter } from '../adapters.js';
import { SCHEMA_VERSION } from '../adapters.js';
import type { ResolvedCheck } from '../config.js';
import { selectChecks } from './select.js';
import type { Out, RunFlags, Summary, SummaryCheck } from './types.js';

export function writeLine(out: Out, line: string): void {
  out.write(`${line}\n`);
}

/**
 * Width of the slot-name column, measured from the names this run will print
 * (never below the historical 8). A fixed 8 was sized for catalogue slots, and
 * a config custom check — `typecheck-tests` is 15 — pushed the duration and
 * description columns right on its row alone.
 */
export function nameWidth(selected: readonly ResolvedCheck[]): number {
  return selected.reduce((n, r) => Math.max(n, r.slot.length), 8);
}

export function formatStatusLine(check: SummaryCheck, width: number): string {
  const mark = check.ok ? '✔' : '✘';
  const name = check.name.padEnd(width);
  const duration = `${check.duration_ms}ms`.padStart(8);
  return `  ${mark} ${name} ${duration}  ${check.description}`;
}

export function skippedEntry(resolved: ResolvedCheck): SummaryCheck {
  return {
    name: resolved.slot,
    adapter: resolved.adapter?.name ?? null,
    description: resolved.adapter?.description ?? resolved.slot,
    ok: true,
    skipped: true,
    reason: resolved.skip ?? 'skipped',
    exit_code: null,
    duration_ms: 0,
    // A skipped check ran nothing and wrote nothing; naming its adapter's
    // declared output file would point at whatever an earlier run left there.
    output_file: null,
  };
}

/**
 * Summary entries for the slots an `--only`/`--skip` selection kept from
 * running. Without them a narrowed run's summary just lists fewer checks, and
 * a consumer reading `.check/summary.json` after a gate profile or an
 * iteration loop cannot tell the subset from the whole — the summary must
 * state its own narrowing. Each deselected slot rides as a skipped row naming
 * the flag (or its own resolution reason, when it had one and would not have
 * run anyway). Opt-in slots that simply sat out are not narrowing and stay
 * absent, exactly as before.
 */
export function narrowedEntries(
  resolved: readonly ResolvedCheck[],
  selected: readonly ResolvedCheck[],
  flags: RunFlags,
): SummaryCheck[] {
  const only = flags.only ?? null;
  const skipSet = new Set(flags.skip ?? []);
  if (only === null && skipSet.size === 0) return [];
  const ran = new Set(selected.map((r) => r.slot));
  return selectChecks(resolved, { ...flags, only: null, skip: null })
    .filter((r) => !ran.has(r.slot))
    .map((r) =>
      skippedEntry({
        ...r,
        skip: r.skip ?? (skipSet.has(r.slot) ? 'skipped by --skip' : 'not in --only'),
      }),
    );
}

/**
 * `total_duration_ms` is the wall-clock span of the whole execution phase,
 * not the sum of per-check durations — under concurrency those diverge, and
 * wall-clock is what the field honestly means. It equals the per-check sum
 * whenever execution is sequential (one check in flight at a time).
 */
export function buildSummary(checks: SummaryCheck[], totalDurationMs: number): Summary {
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks_run: checks.filter((c) => !c.skipped).length,
    total_duration_ms: totalDurationMs,
    checks,
  };
}

/** What could fill a sat-out slot: each candidate adapter and its first detect file. */
function enableHint(slot: string, adapters: readonly Adapter[]): string | null {
  const candidates = adapters.filter((a) => a.slot === slot);
  if (candidates.length === 0) return null;
  const parts = candidates.map((a) =>
    a.detect.length > 0 ? `${a.name} (add ${a.detect[0]})` : a.name,
  );
  return `enable with: ${parts.join(', ')}`;
}

/**
 * The first-party vacuous-green signal: "green because nothing ran" must be
 * unmissable, not something only a consumer that hand-rolls its own check can
 * distinguish from "green because everything passed".
 * Names why each slot sat out and what would enable it.
 */
function warnVacuous(
  stderr: Out,
  checks: readonly SummaryCheck[],
  adapters: readonly Adapter[],
): void {
  writeLine(stderr, '');
  writeLine(stderr, '⚠ 0 checks ran — nothing was verified. This is not a pass.');
  if (checks.length === 0) {
    writeLine(stderr, '  No slots matched the selection (--only/--skip).');
  }
  for (const c of checks) {
    const hint = c.adapter === null ? enableHint(c.name, adapters) : null;
    writeLine(stderr, `  ○ ${c.name}: ${c.reason ?? 'skipped'}${hint ? ` — ${hint}` : ''}`);
  }
  writeLine(stderr, '  Run `checkride doctor` for per-slot detail, or add a custom check to');
  writeLine(stderr, '  checkride.config.json. Gates should run with --strict (exit 2 on zero checks).');
}

/**
 * How much of the selection actually ran, said only when it was not all of it.
 *
 * `✔ all checks passed` is a true sentence about the checks that ran and a
 * misleading one about the repo, and the gap is invisible at exactly the moment
 * it matters most: a repo that configures almost nothing reports the same
 * confident green as one that configures everything. `--strict` does not catch
 * this, and cannot — its floor is *zero* checks, which a slot like `links` that
 * needs no tool keeps a repo off by itself.
 *
 * Only skipped slots are counted here. The per-slot `○ … skip <reason>` lines
 * are already on screen above; this is the one line someone scrolled past them
 * to read.
 */
function coverage(summary: Summary, checks: readonly SummaryCheck[]): string {
  const skipped = checks.length - summary.checks_run;
  if (skipped <= 0) return '';
  return ` — only ${summary.checks_run} of ${checks.length} checks ran, ${skipped} skipped`;
}

/** Print the human run summary: the vacuous-green warning, the status line, and artifact paths. */
export function reportSummary(
  stderr: Out,
  summary: Summary,
  checks: readonly SummaryCheck[],
  adapters: readonly Adapter[],
  digestWritten: boolean,
): void {
  if (summary.checks_run === 0) warnVacuous(stderr, checks, adapters);
  writeLine(stderr, '');
  const status =
    summary.checks_run === 0
      ? '⚠ no checks ran'
      : summary.ok ? '✔ all checks passed' : '✘ one or more checks failed';
  const ran = summary.checks_run === 0 ? '' : coverage(summary, checks);
  writeLine(stderr, `${status} in ${summary.total_duration_ms}ms${ran}`);
  writeLine(stderr, 'report: .check/summary.json');
  if (digestWritten) writeLine(stderr, 'digest: .check/digest.md');
  writeLine(stderr, '');
}

/**
 * The 0/1/2 exit taxonomy. `--strict` turns a vacuous green (zero checks) into a
 * harness error (exit 2) — a gate must not report "done" on a repo where nothing
 * was checked.
 */
export function computeExitCode(summary: Summary, strict: boolean, json: boolean, stderr: Out): number {
  if (strict && summary.checks_run === 0) {
    if (!json) writeLine(stderr, '--strict: zero checks ran, exiting 2.\n');
    return 2;
  }
  return summary.ok ? 0 : 1;
}
