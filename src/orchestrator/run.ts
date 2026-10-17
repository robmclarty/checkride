/**
 * `runChecks` — the run entry point: resolve the context, validate the
 * selection, execute, ratchet the baseline on a fully observed run, write the
 * summary and digest, and report. The ratchet gate, the run record that shares
 * its partial-run test, and the red-run recover hint live here because only the
 * whole run can decide them.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { isInside, pruneDroppedTargets, SUMMARY_FILE } from '../artifacts/index.js';
import { writeFileAtomic } from '../atomic.js';
import type { Fingerprint } from '../baseline/index.js';
import { BASELINE_FILE, baselinesEqual, countBaselineKeys, historicalHint, ratchet, writeBaseline } from '../baseline/index.js';
import { configChangedBase, resolveChecks } from '../config.js';
import { writeDigest } from '../digest/index.js';
import type { ChangedBase, GitState } from '../git.js';
import { changedPaths, GIT_STATE_TIMEOUT_MS, readGitState, realGit, resolveChangedBase } from '../git.js';
import type { Target } from '../targets/index.js';
import type { RunContext } from './context.js';
import { resolveRunContext } from './context.js';
import { executeChecks } from './execute.js';
import { buildSummary, computeExitCode, nameWidth, narrowedEntries, reportSummary, writeLine } from './report.js';
import { selectChecks, skipUnchanged, validateSelection, withFileLists, withGoPackages } from './select.js';
import { resetInterrupt } from './spawn.js';
import type { RunOptions, RunResult, SummaryGit, SummaryRun, SummaryTarget } from './types.js';

/**
 * Whether this run saw less than the full pipeline — an `--only`/`--skip`/
 * `--changed` filter or an early `--bail` break. The ratchet is gated off for
 * these: an unobserved diagnostic must not be mistaken for a fixed one.
 */
function isPartialRun(options: RunOptions, changed: boolean, brokeEarly: boolean): boolean {
  return (options.only ?? null) !== null || (options.skip?.length ?? 0) > 0 || changed || brokeEarly;
}

/**
 * The summary's `run`: `partial`, as the ratchet just judged it, and each
 * selection or mode flag the run was given, so a narrowed run says so in the
 * artifact and not only on screen. A flag that wasn't given leaves no field.
 */
function runRecord(options: RunOptions, cwd: string, partial: boolean): SummaryRun {
  return {
    partial,
    ...(options.only ? { only: [...options.only] } : {}),
    ...(options.skip ? { skip: [...options.skip] } : {}),
    ...(options.include ? { include: [...options.include] } : {}),
    ...(options.all === true ? { all: true } : {}),
    ...(options.changed === true ? { changed: true } : {}),
    ...(options.configPath !== undefined ? { config: resolve(cwd, options.configPath) } : {}),
    ...(options.defaults !== undefined ? { defaults: resolve(cwd, options.defaults.path) } : {}),
    ...(options.out !== undefined ? { out: resolve(cwd, options.out) } : {}),
  };
}

/**
 * The summary's `git`, or `null` when git couldn't say. Under `--changed` it
 * carries the base the run measured from, which has a sha whenever `HEAD`
 * named a commit, and so whenever there's a state to carry it.
 */
function gitRecord(state: GitState | null, base: ChangedBase | null): SummaryGit | null {
  if (state === null) return null;
  return base?.sha ? { ...state, base: { ref: base.ref, sha: base.sha } } : state;
}

/** The summary's `targets`: each configured target in config order, or `null` in implicit mode. */
function targetsRecord(targets: readonly Target[] | null): SummaryTarget[] | null {
  return targets === null ? null : targets.map(({ name, pack, root }) => ({ name, pack, root }));
}

/**
 * Why this run is a consumer run, shaped from outside the repo, or `null` when
 * it is the repo's own. A consumer run doesn't represent the repo's gate, so it
 * never rewrites `checkride.baseline.json`. A `--config` or `--out` inside the
 * repo is the repo speaking for itself, and ratchets as if no flag had been
 * passed; `--defaults` never is, wherever its file sits (R13.5).
 */
function consumerCause(options: RunOptions, cwd: string): string | null {
  if (options.defaults !== undefined) return '--defaults';
  if (options.configPath !== undefined && !isInside(cwd, resolve(cwd, options.configPath))) return '--config outside the repo';
  if (options.out !== undefined && !isInside(cwd, resolve(cwd, options.out))) return '--out outside the repo';
  return null;
}

/**
 * On a fully observed run, prune grandfathered diagnostics now fixed
 * (shrink-only, atomic). A consumer run prunes nothing and says once why not,
 * and only when there was something to prune.
 */
async function maybeRatchet(
  ctx: RunContext,
  observed: ReadonlyMap<string, Fingerprint>,
  restricted: boolean,
  consumer: string | null,
): Promise<void> {
  const { baseline } = ctx;
  if (!baseline || restricted) return;
  const pruned = ratchet(baseline, observed);
  if (baselinesEqual(baseline, pruned)) return;
  if (consumer !== null) {
    if (!ctx.json) writeLine(ctx.stderr, `\nbaseline: not ratcheted, because a run with ${consumer} never writes ${BASELINE_FILE}`);
    return;
  }
  await writeBaseline(ctx.cwd, pruned);
  if (!ctx.json) {
    writeLine(ctx.stderr, `\nbaseline: ratcheted ${BASELINE_FILE} to ${countBaselineKeys(pruned)} grandfathered diagnostic(s)`);
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

/**
 * The base a `--changed` run measures from, or `null` off `--changed`: the one
 * the caller named (`--base`, `CHECKRIDE_BASE`), else the config's
 * `changedBase`, else `origin/main` when it resolves, else `HEAD` with a warning
 * on stderr. A named base that doesn't resolve throws, a usage error raised
 * before the run writes anything. The config's value is validated either way.
 */
async function changedBaseFor(options: RunOptions, ctx: RunContext): Promise<ChangedBase | null> {
  const configured = configChangedBase(ctx.config);
  if (!ctx.changed) return null;
  const named = options.base ?? (configured !== null ? { ref: configured, from: 'config changedBase' } : null);
  const { base, warning } = await resolveChangedBase(realGit(ctx.cwd), named);
  if (warning !== null) writeLine(ctx.stderr, warning);
  return base;
}

/**
 * The paths a `--changed` run skips targets by, or `null` when it skips none:
 * off `--changed`, in implicit mode, which narrows through the base alone, and
 * when git can't list them, which says so on stderr (R10.2).
 */
async function changedPathsFor(ctx: RunContext, base: ChangedBase | null): Promise<string[] | null> {
  if (base === null || ctx.targets === null) return null;
  const listed = await changedPaths(realGit(ctx.cwd), base);
  if (listed.ok) return listed.paths;
  writeLine(ctx.stderr, `--changed: can't list the changed paths (${listed.why}), so no target is skipped`);
  return null;
}

/** Run the selected checks against `cwd`, persist output, write the summary. */
export async function runChecks(options: RunOptions): Promise<RunResult> {
  // A new run starts with the interrupt latch clear — see `resetInterrupt`.
  resetInterrupt();
  const base = resolveRunContext(options);
  const resolved = resolveChecks({ slots: base.slots, adapters: base.adapters, config: base.config, defaults: base.defaults, cwd: base.cwd });
  // A usage error before any side effect: no output dir, no run, exit 2.
  validateSelection(resolved, options);
  const changedBase = await changedBaseFor(options, base);
  // Asked as the run starts and awaited once the checks finish, so git's
  // answer costs the run no wall-clock time unless git is the slower of the two.
  const gitQuery = readGitState(realGit(base.cwd, GIT_STATE_TIMEOUT_MS));
  const changed = await changedPathsFor(base, changedBase);
  // A file list too long for one argv is a usage error too, so the lists are
  // read before the output directory is touched.
  const listed = await withFileLists(skipUnchanged(selectChecks(resolved, options), changed), base.cwd, base.targets);
  const selected = withGoPackages(listed, base.cwd, changed);

  await mkdir(base.out, { recursive: true });
  // A target the config dropped leaves a directory no run refreshes again;
  // clear it, and nothing the previous summary didn't list as a target (R9).
  await pruneDroppedTargets(base.out, base.cwd, (base.targets ?? []).map((t) => t.name));

  // The status-line column is sized once the selection is known, so a long
  // custom-check name widens the column instead of overflowing it.
  const ctx: RunContext = { ...base, nameWidth: nameWidth(selected), changedBase };
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
  // A run that beats git waits for it inside the clock, so the run's start
  // stays `timestamp - total_duration_ms`, which the artifact readers judge
  // freshness by.
  const gitState = await gitQuery;
  const totalDurationMs = Math.round(performance.now() - startedAt);

  // One partial-run test serves the ratchet and the summary, so `run.partial`
  // is true exactly when the ratchet stood down for a partial run.
  const partial = isPartialRun(options, ctx.changed, brokeEarly);
  await maybeRatchet(ctx, observed, partial, consumerCause(options, ctx.cwd));

  // The summary carries the run's own narrowing: the slots `--only`/`--skip`
  // deselected ride as skipped rows, so the artifact can say "without test"
  // about itself.
  const reported = [...checks, ...narrowedEntries(resolved, selected, options, ctx.targets !== null)];
  const summary = buildSummary(
    reported,
    totalDurationMs,
    runRecord(options, ctx.cwd, partial),
    gitRecord(gitState, changedBase),
    targetsRecord(ctx.targets),
  );
  await writeFileAtomic(join(ctx.out, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);

  // `--digest`: write (or, on green, clear) the token-bounded failure excerpt.
  // A file beside summary.json, never a stdout stream, so the machine-output
  // split holds. Raw `<slot>.json` files are already persisted and
  // untouched — the digest only reads them.
  const digestWritten = (options.digest ?? false) ? await writeDigest({ dir: ctx.out, label: ctx.outLabel, repoRoot: ctx.cwd }, runs, checks) : false;

  if (ctx.json) {
    ctx.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    reportSummary(ctx.stderr, summary, reported, ctx.adapters, { label: ctx.outLabel, digest: digestWritten });
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
