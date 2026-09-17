/**
 * The per-check pipeline and the scheduler that drives it. One check: clear
 * its stale `.check/` artifacts, run it, persist the raw output, mask the
 * outcome against the baseline, and print its row. The set: `--bail`'s flat
 * sequential path, or waves on the effective `order` through a bounded pool,
 * with the report assembled in selection order regardless of who finished
 * first.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Adapter, Order } from '../adapters.js';
import { writeFileAtomic } from '../atomic.js';
import type { Baseline, Fingerprint } from '../baseline/index.js';
import { applyBaseline, fallowVerdict, fingerprint } from '../baseline/index.js';
import type { ResolvedCheck } from '../config.js';
import type { CheckOutcome } from '../links.js';
import { isAvailableUnder } from '../pm/index.js';
import { parseToolJson } from '../tool-json.js';
import type { RunContext } from './context.js';
import { formatStatusLine, skippedEntry, writeLine } from './report.js';
import type { CheckRun, SummaryCheck } from './types.js';

/**
 * Persist raw output atomically: JSON to `.check/<outputFile>`, else stdout
 * text — and stderr text on either path. A slot that produced a JSON artifact
 * can still have explained itself on stderr (a built-in's `check-<slot>:` line,
 * a launcher warning), and that explanation must not vanish because the JSON
 * won: `security` against an unreachable registry used to lose its reason here.
 *
 * Returns the JSON file it wrote, or `null` when it fell through to text — the
 * summary's `output_file` is that return value, never the adapter's
 * *declaration*. A slot that declares an `outputFile` does not always produce
 * one (the tool printed a warning first, crashed, or emitted plain text this
 * run), and naming a file that was never written sends every consumer to an
 * ENOENT while the real bytes sit in `<slot>.stdout.txt` beside it.
 */
async function persistOutput(cwd: string, adapter: Adapter, outcome: CheckOutcome): Promise<string | null> {
  const dir = join(cwd, '.check');
  if (outcome.stderr.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stderr.txt`), outcome.stderr);
  if (adapter.outputFile && outcome.stdout.trim()) {
    // Tolerates a launcher preamble ahead of the JSON; writes the tool's own
    // bytes from the first JSON character on, so the artifact actually parses.
    const parsed = parseToolJson(outcome.stdout);
    if (parsed) {
      await writeFileAtomic(join(dir, adapter.outputFile), parsed.text);
      return adapter.outputFile;
    }
  }
  if (outcome.stdout.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stdout.txt`), outcome.stdout);
  return null;
}

/**
 * Remove a slot's prior `.check/` artifacts before it re-runs, so a later clean
 * run that emits nothing — or a different stream/form than last time — can't leave
 * the previous run's output lingering as authoritative. Covers everything
 * `persistOutput` writes (`<slot>.stdout.txt`, `<slot>.stderr.txt`, the adapter's
 * JSON `outputFile`) plus the conventional `<slot>.json` a tool may write itself
 * (for example vitest's `--outputFile=.check/test.json`, where `outputFile` is null).
 * Runs *before* the check so this run's own tool-written artifacts survive.
 */
async function clearSlotOutputs(cwd: string, adapter: Adapter): Promise<void> {
  const dir = join(cwd, '.check');
  const names = new Set([
    `${adapter.slot}.stdout.txt`,
    `${adapter.slot}.stderr.txt`,
    `${adapter.slot}.json`,
  ]);
  if (adapter.outputFile) names.add(adapter.outputFile);
  await Promise.all([...names].map((f) => rm(join(dir, f), { force: true })));
}

/** One slot's baseline-masked verdict, plus the fingerprint to feed the ratchet (null = don't observe). */
type MaskResult = {
  ok: boolean;
  baselined: number;
  newKeys: string[];
  reason: string | null;
  observed: Fingerprint | null;
};

/**
 * The one line a could-not-verify outcome (`exit_code: -1`) owes the terminal.
 * A red slot otherwise prints only its status line — the tool's output is in
 * `.check/` — but -1 means the tool never reached a verdict, and the reader's
 * next move (fix the network, raise the timeout) depends on why. A built-in
 * states its cause on a `check-<slot>:` line; `spawnCheck` appends its
 * `timed out after Ns` / `Failed to spawn` note *last*, after whatever the tool
 * managed to print. Any other outcome prints nothing extra.
 */
function couldNotVerifyReason(outcome: CheckOutcome): string | null {
  if (outcome.ok || outcome.exit_code !== -1) return null;
  const lines = outcome.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^check-[a-z-]+: /.test(l)) ?? lines.at(-1) ?? null;
}

/**
 * Baseline-aware verdict for one slot's outcome. fallow slots derive pass/fail
 * from the parsed report (its exit code doesn't reliably gate); everything else
 * masks the adapter's fingerprint. `observed` is non-null only when the run's
 * findings could be read — the ratchet must never prune from an unreadable run.
 */
function maskOutcome(adapter: Adapter, outcome: CheckOutcome, baseline: Baseline | null, slot: string): MaskResult {
  if (adapter.gate === 'fallow') {
    const v = fallowVerdict(outcome.stdout, baseline ? (baseline.slots[slot] ?? []) : null);
    return { ok: v.ok, baselined: v.baselined, newKeys: v.newKeys, reason: v.reason, observed: v.observed ? v.findings : null };
  }
  const current = baseline ? fingerprint(adapter.name, outcome.stdout) : null;
  if (baseline && current !== null) {
    const adj = applyBaseline(current, baseline.slots[slot] ?? [], outcome.ok);
    return { ok: adj.ok, baselined: adj.baselined, newKeys: adj.newKeys, reason: couldNotVerifyReason(outcome), observed: current };
  }
  return { ok: outcome.ok, baselined: 0, newKeys: [], reason: couldNotVerifyReason(outcome), observed: null };
}

/** Build (and print) the skipped-entry row for a slot that won't run this pass. */
function handleSkip(r: ResolvedCheck, unavailable: boolean, ctx: RunContext): SummaryCheck {
  const entry = skippedEntry(
    unavailable ? { ...r, skip: `'${r.adapter?.command} ${r.adapter?.args[0]}' is unavailable under ${ctx.pm}` } : r,
  );
  if (!ctx.json) writeLine(ctx.stderr, `  ○ ${entry.name.padEnd(ctx.nameWidth)}      skip  ${entry.reason ?? ''}`);
  return entry;
}

/** Print one check's status line, its baselined count, and any new (non-grandfathered) findings. */
function reportCheckResult(stderr: RunContext['stderr'], entry: SummaryCheck, mask: MaskResult, width: number): void {
  writeLine(stderr, formatStatusLine(entry, width));
  if (mask.baselined > 0) writeLine(stderr, `           ${mask.baselined} baselined (grandfathered)`);
  if (!entry.ok && mask.reason) writeLine(stderr, `           ${mask.reason}`);
  if (!entry.ok && mask.newKeys.length > 0) {
    writeLine(stderr, `           ${mask.newKeys.length} new, not in baseline:`);
    for (const k of mask.newKeys) writeLine(stderr, `             ${k}`);
  }
}

/** Run one active check: clear stale output, run it, persist, and mask against the baseline. */
async function runOneCheck(
  r: ResolvedCheck,
  adapter: Adapter,
  ctx: RunContext,
): Promise<{ entry: SummaryCheck; run: CheckRun; mask: MaskResult }> {
  if (!ctx.json) writeLine(ctx.stderr, `  ▸ ${r.slot}  ${adapter.description}`);
  // Wipe this slot's stale `.check/` artifacts before it runs, so a leaner re-run
  // can't leave last run's output behind as authoritative — and so any artifact
  // the tool writes during *this* run (for example `test.json`) survives.
  await clearSlotOutputs(ctx.cwd, adapter);
  const start = performance.now();
  const outcome = await ctx.runner(r, { cwd: ctx.cwd, changed: ctx.changed, pm: ctx.pm, ...(ctx.timeout !== undefined ? { timeout: ctx.timeout } : {}) });
  const duration_ms = Math.round(performance.now() - start);
  const outputFile = await persistOutput(ctx.cwd, adapter, outcome);

  // Masking is always on (even under a partial run); only the ratchet is gated.
  // The raw `.check/<slot>.json` is persisted untouched — masking changes the
  // pass/fail verdict, never the authoritative output.
  const mask = maskOutcome(adapter, outcome, ctx.baseline, r.slot);
  const entry: SummaryCheck = {
    name: r.slot,
    adapter: adapter.name,
    description: adapter.description,
    ok: mask.ok,
    exit_code: outcome.exit_code,
    duration_ms,
    output_file: outputFile,
    ...(mask.baselined > 0 ? { baselined: mask.baselined } : {}),
  };
  return { entry, run: { slot: r.slot, adapter, outcome }, mask };
}

/**
 * One selected check's result, decoupled from where it lands in the report. The
 * scheduler runs checks concurrently, so a check can't push itself onto shared
 * accumulators as it finishes — that would order the report by completion, not by
 * the deterministic selection order. Instead each yields this and the caller
 * assembles the report in `selected` order.
 */
type CheckResult = {
  entry: SummaryCheck;
  /** The raw run (for the ratchet + digest); null for a skipped slot. */
  run: CheckRun | null;
  /** Fingerprint to feed the ratchet, keyed by slot; null when nothing was observed. */
  observed: { slot: string; fp: Fingerprint } | null;
  /** Diagnostics the baseline did not grandfather — feeds the red-run recover hint. */
  newKeys: string[];
};

/**
 * Run one selected check to a {@link CheckResult} — the concurrency-safe core
 * shared by the sequential (`--bail`) and wave paths. A skipped/unavailable slot
 * records a skip row and runs nothing; an active one runs, prints its status
 * line, and reports its fingerprint for the ratchet. It mutates no shared state,
 * so N of these can be in flight at once.
 */
async function runSelectedCheck(r: ResolvedCheck, ctx: RunContext): Promise<CheckResult> {
  // Skip when unresolved, or when the adapter can't run under this PM — for
  // example `pnpm audit` (the `security` slot) is unavailable off pnpm.
  const unavailable = Boolean(r.adapter && !isAvailableUnder(r.adapter.command, r.adapter.args, ctx.pm));
  if (r.skip || !r.adapter || unavailable) {
    return { entry: handleSkip(r, unavailable, ctx), run: null, observed: null, newKeys: [] };
  }
  const { entry, run, mask } = await runOneCheck(r, r.adapter, ctx);
  if (!ctx.json) reportCheckResult(ctx.stderr, entry, mask, ctx.nameWidth);
  return { entry, run, observed: mask.observed !== null ? { slot: r.slot, fp: mask.observed } : null, newKeys: mask.newKeys };
}

/** The run accumulators every execution path fills. */
type Execution = {
  checks: SummaryCheck[];
  runs: CheckRun[];
  observed: Map<string, Fingerprint>;
  newKeys: string[];
  brokeEarly: boolean;
};

/** Fold one result into the report accumulators, in call order. */
function collect(res: CheckResult, acc: Execution): void {
  acc.checks.push(res.entry);
  if (res.run) acc.runs.push(res.run);
  if (res.observed) acc.observed.set(res.observed.slot, res.observed.fp);
  acc.newKeys.push(...res.newKeys);
}

/** A fresh, empty {@link Execution}. */
function emptyExecution(brokeEarly = false): Execution {
  return { checks: [], runs: [], observed: new Map(), newKeys: [], brokeEarly };
}

/**
 * Scheduling coordinates for a check on the order line: the group `rank` (firsts 0,
 * the numeric line 1, singles 2, lasts 3) and its position on the numeric line
 * (`'any'`/`'middle'` sit at 0 — the conservative placement). This must agree
 * with `config.ts`'s group sort, which already put `selected` in exactly this
 * sequence; here it only re-derives the wave *boundaries* the sort collapsed.
 */
const SINGLE_RANK = 2;
function scheduleGroup(order: Order): { rank: number; line: number } {
  if (order === 'first') return { rank: 0, line: 0 };
  if (order === 'single') return { rank: SINGLE_RANK, line: 0 };
  if (order === 'last') return { rank: 3, line: 0 };
  return { rank: 1, line: typeof order === 'number' ? order : 0 };
}

/**
 * Split the already-sorted `selected` into execution waves: the `'first'` group,
 * each distinct numeric value, and the `'last'` group each become one concurrent
 * wave, with a barrier between waves; every `'single'` is its own wave so it runs
 * with nothing else in flight. Adjacent items share a wave only when their (rank,
 * line) match and neither is a single.
 */
function partitionWaves<T extends { r: ResolvedCheck }>(items: readonly T[]): T[][] {
  const waves: T[][] = [];
  let current: T[] = [];
  let prev: { rank: number; line: number } | null = null;
  for (const item of items) {
    const g = scheduleGroup(item.r.order ?? 'any');
    const sameWave = prev !== null && prev.rank === g.rank && prev.line === g.line && g.rank !== SINGLE_RANK;
    if (!sameWave && current.length > 0) {
      waves.push(current);
      current = [];
    }
    current.push(item);
    prev = g;
  }
  if (current.length > 0) waves.push(current);
  return waves;
}

/**
 * Run `items` through a pool `width` workers wide: each worker pulls the next
 * item until the queue drains, so at most `width` run at once. Concurrency is the
 * worker count; each worker still processes its own items one at a time. `width`
 * is clamped to at least 1 and never exceeds the item count.
 */
async function runPool<T>(items: readonly T[], width: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item === undefined) continue;
      // oxlint-disable-next-line no-await-in-loop -- a worker processes its items in sequence; concurrency is the `width` workers running this loop at once.
      await worker(item);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, () => runWorker());
  await Promise.all(workers);
}

/**
 * `--bail`: the flat sequential path. Checks run one at a time in group order
 * and the run stops at the first *executed* failure — fail-fast is
 * incompatible with already-launched concurrent work, so `--concurrency` is moot
 * here (the caller notes it if one was passed). For the default set (all `'any'`)
 * this is exactly the cheapest-first order.
 */
async function executeBail(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  const acc = emptyExecution();
  for (const r of selected) {
    // oxlint-disable-next-line no-await-in-loop -- --bail is fail-fast: checks run one at a time so the run can stop at the first failure.
    const res = await runSelectedCheck(r, ctx);
    collect(res, acc);
    if (res.run && !res.entry.ok) return { ...acc, brokeEarly: true };
  }
  return acc;
}

/**
 * The wave scheduler: run each wave's members concurrently through the pool,
 * with a barrier between waves. Results are placed by their `selected` index and
 * assembled in that order afterwards, so the report is deterministic regardless
 * of which check finishes first. Every selected check runs — there is no
 * early stop off the `--bail` path.
 */
async function executeWaves(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  const indexed = selected.map((r, i) => ({ r, i }));
  const results = Array.from<CheckResult | undefined>({ length: selected.length });
  for (const wave of partitionWaves(indexed)) {
    // oxlint-disable-next-line no-await-in-loop -- the between-values barrier: a wave runs to completion before the next distinct order value begins.
    await runPool(wave, ctx.concurrency, async ({ r, i }) => { results[i] = await runSelectedCheck(r, ctx); });
  }
  const acc = emptyExecution();
  for (const res of results) if (res) collect(res, acc);
  return acc;
}

/**
 * Run the selected checks, collecting rows, raw runs, observed fingerprints, and
 * `--bail` state. `--bail` takes the flat sequential path; every other run waves
 * on the effective `order` through a bounded pool.
 */
export function executeChecks(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  return ctx.bail ? executeBail(selected, ctx) : executeWaves(selected, ctx);
}
