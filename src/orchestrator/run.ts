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
import type { Tally } from '../baseline/index.js';
import { BASELINE_FILE, baselinesEqual, copyNamed, countGrandfathered, historicalHint, ratchet, writeBaseline } from '../baseline/index.js';
import type { ResolvedCheck } from '../config.js';
import { configChangedBase, resolveChecks, tsTargets } from '../config.js';
import { writeDigest } from '../digest/index.js';
import type { ChangedBase, GitState } from '../git.js';
import { changedPaths, GIT_STATE_TIMEOUT_MS, readGitState, realGit, resolveChangedBase } from '../git.js';
import type { Target } from '../targets/index.js';
import { declaredNote, discoverRun, findUnreached, unreachedLine } from '../targets/index.js';
import type { RunContext } from './context.js';
import { resolveRunContext } from './context.js';
import { executeChecks } from './execute.js';
import { buildSummary, computeExitCode, nameWidth, narrowedEntries, reportSummary, writeLine } from './report.js';
import { selectChecks, skipUnchanged, validateSelection, withFileLists, withGoPackages, withStaticOnly } from './select.js';
import { resetInterrupt } from './spawn.js';
import type { Drift, Out, RunOptions, RunResult, SummaryGit, SummaryRun, SummaryTarget } from './types.js';

/**
 * Why this run saw less than the full pipeline — an `--only`/`--skip`/
 * `--changed`/`--static-only` filter or an early `--bail` break — in the
 * words {@link notePrunable} names it with, or `null` for a run that saw all
 * of it. The ratchet is gated off for these: an unobserved diagnostic must
 * not be mistaken for a fixed one. `--static-only` is a consumer run as well,
 * so its words never reach that note.
 */
function partialCause(options: RunOptions, changed: boolean, brokeEarly: boolean): string | null {
  if ((options.only ?? null) !== null) return 'a run with --only';
  if ((options.skip?.length ?? 0) > 0) return 'a run with --skip';
  if (changed) return 'a run with --changed';
  if (options.staticOnly === true) return 'a run with --static-only';
  return brokeEarly ? 'a run --bail stopped early' : null;
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
    ...(options.staticOnly === true ? { static_only: true } : {}),
    ...(options.discover === true ? { discover: true } : {}),
    ...pathsRecord(options, cwd),
  };
}

/** The files and directory a run was pointed at, each as an absolute path, and nothing for one it wasn't. */
function pathsRecord(options: RunOptions, cwd: string): Pick<SummaryRun, 'config' | 'defaults' | 'pins' | 'out'> {
  return {
    ...(options.configPath !== undefined ? { config: resolve(cwd, options.configPath) } : {}),
    ...(options.defaults !== undefined ? { defaults: resolve(cwd, options.defaults.path) } : {}),
    ...(options.pins !== undefined ? { pins: resolve(cwd, options.pins.path) } : {}),
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

/**
 * The summary's `targets`: each configured target in config order, or each
 * discovered one in discovery order, marked so, or `null` in implicit mode.
 */
function targetsRecord(targets: readonly Target[] | null, discovered: boolean): SummaryTarget[] | null {
  if (targets === null) return null;
  return targets.map(({ name, pack, root }) => ({ name, pack, root, ...(discovered ? { discovered: true as const } : {}) }));
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
  if (options.discover === true) return '--discover';
  if (options.pins !== undefined) return '--pins';
  if (options.staticOnly === true) return '--static-only';
  if (options.configPath !== undefined && !isInside(cwd, resolve(cwd, options.configPath))) return '--config outside the repo';
  if (options.out !== undefined && !isInside(cwd, resolve(cwd, options.out))) return '--out outside the repo';
  return null;
}

/**
 * Say, for each check that ran another copy of its tool than its baseline
 * keys were captured with, and whose keys churned, what the baseline
 * recorded, what ran, and what the ratchet did: a run that ratchets held that
 * check's unseen keys back, and a partial or consumer run prunes nothing
 * anyway, so it counts none. The remedy is never a re-capture by whoever
 * reads it, since that would grandfather new debt along with the churn
 * ({@link driftRemedy}).
 */
function reportDrift(stderr: Out, drifts: readonly Drift[], run: { partial: boolean; consumer: string | null }): void {
  const ratchets = !run.partial && run.consumer === null;
  for (const d of drifts) {
    const churn = driftChurn(d, ratchets);
    if (churn === null) continue;
    writeLine(
      stderr,
      `baseline: ${d.name} was captured with ${d.tool} ${copyNamed(d.captured, d.toolchain)}; this run used ${d.tool} ${copyNamed(d.ran, d.toolchain)}: ${churn}. ${driftRemedy(d)}`,
    );
  }
}

/**
 * What a drift notice asks for. With new keys, a human's review: they may be
 * new debt, and only a capture adds a key. With none, the copy that ran can
 * be recorded with `checkride baseline --versions`, which adds no key, where
 * a pin of the repo's chose it ({@link unpinnedPart} says what has to be
 * pinned first).
 */
function driftRemedy(d: Drift): string {
  const capturedCopy = 'Run under the copy the baseline was captured with';
  if (d.newKeys > 0) return `${capturedCopy}, or have a human review the new keys and re-capture.`;
  const unpinned = unpinnedPart(d);
  if (unpinned !== null) return `${capturedCopy}, or pin ${unpinned}, so \`checkride baseline --versions\` can record it.`;
  return `${capturedCopy}, or, if this is the copy the repo means to run, record it with \`checkride baseline --versions\`, which adds no key.`;
}

/**
 * What a drifted check's run has to pin before `--versions` records it: its
 * tool, when it came from `PATH` or no pin source, or the toolchain it ran
 * on, when the machine chose that; `null` when a pin of the repo's chose both.
 */
function unpinnedPart(d: Drift): string | null {
  if (d.ran.pin_source === undefined || d.ran.pin_source === 'path') return 'this one';
  return d.ran.toolchain_pinned === false ? `the ${d.toolchain ?? 'toolchain'} it ran on` : null;
}

/** A drifted check's churn as its notice counts it, or `null` when there's none to report. */
function driftChurn(d: Drift, ratchets: boolean): string | null {
  const parts = [...(d.newKeys > 0 ? [`${d.newKeys} new`] : []), ...(ratchets && d.heldBack > 0 ? [`${d.heldBack} held back from the ratchet`] : [])];
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * On a fully observed run, prune grandfathered diagnostics now fixed
 * (shrink-only, atomic). A consumer run prunes nothing and says once why not,
 * and only when there was something to prune.
 */
async function maybeRatchet(
  ctx: RunContext,
  observed: ReadonlyMap<string, Tally>,
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
    writeLine(ctx.stderr, `\nbaseline: ratcheted ${BASELINE_FILE} to ${countGrandfathered(pruned)} grandfathered finding(s)`);
  }
}

/**
 * On a partial run of the repo's own, which never prunes, say how many
 * grandfathered findings the checks that read every file they cover no
 * longer report, a key's or one of a key's count, when there are any. A loop that only ever runs narrowed, as a
 * `"gate": { "changed": true }` agent loop does, otherwise never learns that
 * the baseline holds fixed debt, and a fix reverted inside it never shows.
 * The count is a floor: a check the run left out may hold fixed keys too.
 */
function notePrunable(ctx: RunContext, observed: ReadonlyMap<string, Tally>, narrowed: ReadonlySet<string>, cause: string): void {
  const { baseline } = ctx;
  if (!baseline || ctx.json) return;
  const whole = new Map([...observed].filter(([name]) => !narrowed.has(name)));
  const prunable = countGrandfathered(baseline) - countGrandfathered(ratchet(baseline, whole));
  if (prunable === 0) return;
  writeLine(
    ctx.stderr,
    `\nbaseline: not ratcheted, because ${cause} sees only part of the pipeline; a full run would prune at least ${prunable} grandfathered finding(s) these checks no longer report`,
  );
}

/**
 * Beneath the summary, a warning for each ts slot the run sat out for want of
 * a tool while configs for it sit in the packages below its target, which no
 * check reaches (#12). It changes no verdict, and a file list that can't be
 * read says nothing, since a warning must never break a run.
 */
async function reportUnreached(ctx: RunContext, selected: readonly ResolvedCheck[]): Promise<void> {
  const found = await findUnreached(ctx.cwd, tsTargets(selected), ctx.config?.unclaimed?.ignore ?? []).catch(() => []);
  for (const u of found) writeLine(ctx.stderr, `warning: ${unreachedLine(u)}`);
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

/**
 * The run context with `--discover`'s targets applied (R13.2), or `ctx` as it
 * is without the flag. A discovery that proposes only the implicit target
 * leaves it unchanged, and so does a config that declares its own targets,
 * which stderr names once as the reason (D73). Each top-level entry no root
 * target could take is named on stderr, since the run drops it.
 */
async function withDiscovery(ctx: RunContext, options: RunOptions): Promise<RunContext> {
  if (options.discover !== true) return ctx;
  const found = await discoverRun(ctx.cwd, ctx.config, ctx.baseline);
  if (found.declared.length > 0) writeLine(ctx.stderr, declaredNote(found.declared));
  for (const slot of found.dropped) {
    writeLine(ctx.stderr, `--discover: dropped checks.${slot}, since no discovered target sits at the repo root to take it`);
  }
  if (found.targets.length === 0) return ctx;
  return { ...ctx, config: found.config, targets: found.targets, discovered: true, baseline: found.baseline };
}

/** Run the selected checks against `cwd`, persist output, write the summary. */
export async function runChecks(options: RunOptions): Promise<RunResult> {
  // A new run starts with the interrupt latch clear — see `resetInterrupt`.
  resetInterrupt();
  const base = await withDiscovery(resolveRunContext(options), options);
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
  const packaged = withGoPackages(listed, base.cwd, changed);
  const selected = options.staticOnly === true ? await withStaticOnly(packaged, base.cwd) : packaged;

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
  const { checks, runs, observed, narrowed, newKeys, drifts, brokeEarly } = await executeChecks(selected, ctx);
  // A run that beats git waits for it inside the clock, so the run's start
  // stays `timestamp - total_duration_ms`, which the artifact readers judge
  // freshness by.
  const gitState = await gitQuery;
  const totalDurationMs = Math.round(performance.now() - startedAt);

  // One partial-run test serves the ratchet and the summary, so `run.partial`
  // is true exactly when the ratchet stood down for a partial run.
  const cause = partialCause(options, ctx.changed, brokeEarly);
  const partial = cause !== null;
  const consumer = consumerCause(options, ctx.cwd);
  await maybeRatchet(ctx, observed, partial, consumer);
  // A consumer run prunes nothing even in full, so only the repo's own says what a full run would.
  if (cause !== null && consumer === null) notePrunable(ctx, observed, narrowed, cause);

  // The summary carries the run's own narrowing: the slots `--only`/`--skip`
  // deselected ride as skipped rows, so the artifact can say "without test"
  // about itself.
  const reported = [...checks, ...narrowedEntries(resolved, selected, options, ctx.targets !== null)];
  const summary = buildSummary(
    reported,
    totalDurationMs,
    runRecord(options, ctx.cwd, partial),
    gitRecord(gitState, changedBase),
    targetsRecord(ctx.targets, ctx.discovered),
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
    reportDrift(ctx.stderr, drifts, { partial, consumer });
    await reportUnreached(ctx, selected);
    await maybeRecoverHint(ctx, summary.ok, newKeys);
  }

  const exitCode = computeExitCode(summary, options.strict ?? false, ctx.json, ctx.stderr);
  return { ok: summary.ok, summary, exitCode, runs };
}
