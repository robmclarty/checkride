/**
 * `runChecks` — the run entry point: resolve the context, validate the
 * selection, execute, ratchet the baseline on a fully observed run, write the
 * summary and digest, and report. The ratchet gate and the red-run recover hint
 * live here because only the whole run can decide them.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { writeFileAtomic } from '../atomic.js';
import type { Baseline, Fingerprint } from '../baseline/index.js';
import { BASELINE_FILE, baselinesEqual, countBaselineKeys, historicalHint, ratchet, writeBaseline } from '../baseline/index.js';
import { resolveChecks } from '../config.js';
import { writeDigest } from '../digest/index.js';
import type { RunContext } from './context.js';
import { resolveRunContext } from './context.js';
import { executeChecks } from './execute.js';
import { buildSummary, computeExitCode, nameWidth, narrowedEntries, reportSummary, writeLine } from './report.js';
import { selectChecks, validateSelection } from './select.js';
import { resetInterrupt } from './spawn.js';
import type { Out, RunOptions, RunResult } from './types.js';

/**
 * Whether this run saw less than the full pipeline — an `--only`/`--skip`/
 * `--changed` filter or an early `--bail` break. The ratchet is gated off for
 * these: an unobserved diagnostic must not be mistaken for a fixed one.
 */
function isPartialRun(options: RunOptions, changed: boolean, brokeEarly: boolean): boolean {
  return (options.only ?? null) !== null || (options.skip?.length ?? 0) > 0 || changed || brokeEarly;
}

/** On a fully observed run, prune grandfathered diagnostics now fixed (shrink-only, atomic). */
async function maybeRatchet(
  cwd: string,
  baseline: Baseline | null,
  observed: ReadonlyMap<string, Fingerprint>,
  restricted: boolean,
  json: boolean,
  stderr: Out,
): Promise<void> {
  if (!baseline || restricted) return;
  const pruned = ratchet(baseline, observed);
  if (baselinesEqual(baseline, pruned)) return;
  await writeBaseline(cwd, pruned);
  if (!json) {
    writeLine(stderr, `\nbaseline: ratcheted ${BASELINE_FILE} to ${countBaselineKeys(pruned)} grandfathered diagnostic(s)`);
  }
}

/**
 * On a red run, the best-effort recover hint: when the run's new-not-in-baseline
 * findings were grandfathered in a recent committed baseline, one stderr line
 * says so. The difference between "a wall of new debt" and "a merge dropped
 * baseline entries" is a diagnosis the run output alone cannot make — and this
 * is the moment someone is actually reading it. Strictly bounded and silent on
 * any failure (see {@link historicalHint}); a hint must never slow or break a run.
 */
async function maybeRecoverHint(ctx: RunContext, ok: boolean, newKeys: readonly string[]): Promise<void> {
  if (ok || newKeys.length === 0) return;
  const hint = await historicalHint(ctx.cwd, newKeys);
  if (hint === null) return;
  writeLine(
    ctx.stderr,
    `hint: ${hint.matched} of ${hint.total} new finding(s) were grandfathered until ${hint.shortSha} — a merge may have dropped baseline entries; see \`checkride recover\`\n`,
  );
}

/** Run the selected checks against `cwd`, persist output, write the summary. */
export async function runChecks(options: RunOptions): Promise<RunResult> {
  // A new run starts with the interrupt latch clear — see `resetInterrupt`.
  resetInterrupt();
  const base = resolveRunContext(options);
  const resolved = resolveChecks({ slots: base.slots, adapters: base.adapters, config: base.config, cwd: base.cwd });
  // A usage error before any side effect: no `.check/` dir, no run, exit 2.
  validateSelection(resolved, options);

  await mkdir(join(base.cwd, '.check'), { recursive: true });

  const selected = selectChecks(resolved, options);
  // The status-line column is sized once the selection is known, so a long
  // custom-check name widens the column instead of overflowing it.
  const ctx: RunContext = { ...base, nameWidth: nameWidth(selected) };
  if (!ctx.json) writeLine(ctx.stderr, `\nRunning ${selected.length} check(s)...\n`);

  // `--bail` is fail-fast sequential; a `--concurrency > 1` passed alongside
  // is safe but moot, so say so once — not a usage error, the run just goes slow.
  if (ctx.bail && (options.concurrency ?? 0) > 1 && !ctx.json) {
    writeLine(ctx.stderr, '--concurrency ignored under --bail (fail-fast runs sequentially).');
  }

  // `total_duration_ms` is wall-clock of the execution phase, so measure
  // around it rather than summing per-check durations (which diverge under
  // concurrency). The report array is assembled in `selected` order, not
  // completion order, so it stays byte-reproducible regardless of interleaving.
  const startedAt = performance.now();
  const { checks, runs, observed, newKeys, brokeEarly } = await executeChecks(selected, ctx);
  const totalDurationMs = Math.round(performance.now() - startedAt);

  await maybeRatchet(ctx.cwd, ctx.baseline, observed, isPartialRun(options, ctx.changed, brokeEarly), ctx.json, ctx.stderr);

  // The summary carries the run's own narrowing: the slots `--only`/`--skip`
  // deselected ride as skipped rows, so the artifact can say "without test"
  // about itself.
  const reported = [...checks, ...narrowedEntries(resolved, selected, options)];
  const summary = buildSummary(reported, totalDurationMs);
  await writeFileAtomic(join(ctx.cwd, '.check', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  // `--digest`: write (or, on green, clear) the token-bounded failure excerpt.
  // A file beside summary.json, never a stdout stream, so the machine-output
  // split holds. Raw `.check/<slot>.json` files are already persisted and
  // untouched — the digest only reads them.
  const digestWritten = (options.digest ?? false) ? await writeDigest(ctx.cwd, runs, checks) : false;

  if (ctx.json) {
    ctx.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    reportSummary(ctx.stderr, summary, reported, ctx.adapters, digestWritten);
    // A mangled committed baseline (a botched merge, usually) masks nothing, so
    // every grandfathered finding above reported red — say so where the person
    // reading the wall of red will actually look, right under the summary.
    if (ctx.baselineState === 'unparseable') {
      writeLine(ctx.stderr, `baseline: ${BASELINE_FILE} is present but unparseable — possibly a botched merge; grandfathered findings report red. See \`checkride recover\`.\n`);
    }
    await maybeRecoverHint(ctx, summary.ok, newKeys);
  }

  const exitCode = computeExitCode(summary, options.strict ?? false, ctx.json, ctx.stderr);
  return { ok: summary.ok, summary, exitCode, runs };
}
