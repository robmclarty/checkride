/**
 * The per-check pipeline and the scheduler that drives it. One check: clear
 * its stale artifacts from its artifact directory, run it, persist the raw output, mask the
 * outcome against the baseline, and print its row. The set: `--bail`'s flat
 * sequential path, or waves on the effective `order` through a bounded pool
 * that never runs two checks sharing a lock key at once, with the report
 * assembled in selection order regardless of who finished first.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Adapter, Order } from '../adapters.js';
import { writeFileAtomic } from '../atomic.js';
import type { Baseline, Fingerprint } from '../baseline/index.js';
import { applyBaseline, fingerprint, reportVerdict } from '../baseline/index.js';
import type { ResolvedCheck } from '../config.js';
import { isAvailableUnder, pinChain } from '../launch/index.js';
import type { CheckOutcome } from '../links.js';
import { checkName } from '../targets/index.js';
import { parseToolJson, parseToolJsonLines } from '../tool-json.js';
import type { RunContext } from './context.js';
import type { Place } from './place.js';
import { placeOf } from './place.js';
import { checkIdentity, formatStatusLine, provenanceFields, skippedEntry, writeLine } from './report.js';
import { runtimeArgs } from './spawn.js';
import type { CheckRun, CheckRunner, RunnerOutcome, SummaryCheck } from './types.js';

/**
 * The text a declared `outputFile` holds this run, or `null` when stdout doesn't
 * take the file's form: JSON lines for a `.jsonl` file, one JSON value for any
 * other (R11.1). Either read tolerates a launcher preamble and returns the
 * tool's own bytes from the first JSON character on, so the artifact parses.
 */
function capturedJson(outputFile: string, stdout: string): string | null {
  return (outputFile.endsWith('.jsonl') ? parseToolJsonLines(stdout) : parseToolJson(stdout))?.text ?? null;
}

/**
 * Persist raw output atomically into the output directory `dir`: JSON or JSON
 * lines to `<outputFile>`, else stdout text — and stderr text on either path.
 * Only a check that declares an `outputFile` gets JSON capture; one that
 * declares none keeps its stdout as text whatever it prints (D45). A slot that
 * produced a JSON artifact can still have explained itself on stderr (a
 * built-in's `check-<slot>:` line, a launcher warning), and that explanation
 * must not vanish because the JSON won: `security` against an unreachable
 * registry used to lose its reason here.
 *
 * Returns the JSON file it wrote, or `null` when it fell through to text — the
 * summary's `output_file` is that return value, never the adapter's
 * *declaration*. A slot that declares an `outputFile` does not always produce
 * one (the tool printed a warning first, crashed, or emitted plain text this
 * run), and naming a file that was never written sends every consumer to an
 * ENOENT while the real bytes sit in `<slot>.stdout.txt` beside it.
 */
async function persistOutput(dir: string, adapter: Adapter, outcome: CheckOutcome): Promise<string | null> {
  if (outcome.stderr.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stderr.txt`), outcome.stderr);
  if (adapter.outputFile && outcome.stdout.trim()) {
    const text = capturedJson(adapter.outputFile, outcome.stdout);
    if (text !== null) {
      await writeFileAtomic(join(dir, adapter.outputFile), text);
      return adapter.outputFile;
    }
  }
  if (outcome.stdout.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stdout.txt`), outcome.stdout);
  return null;
}

/**
 * Remove a slot's prior artifacts from the output directory `dir` before it re-runs, so a later clean
 * run that emits nothing — or a different stream/form than last time — can't leave
 * the previous run's output lingering as authoritative. Covers everything
 * `persistOutput` writes (`<slot>.stdout.txt`, `<slot>.stderr.txt`, the adapter's
 * JSON `outputFile`) plus the conventional `<slot>.json` a tool may write itself
 * (for example vitest's `--outputFile={out}/test.json`, where `outputFile` is null).
 * Runs *before* the check so this run's own tool-written artifacts survive.
 */
async function clearSlotOutputs(dir: string, adapter: Adapter): Promise<void> {
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
 * Which baseline entry a check masks against and how its findings are keyed:
 * `key` names the entry (the check's name), `root` is the check's target root,
 * joined onto each path its tool printed (D50), and `base` and `out` fill the
 * argv placeholders the gating rules read.
 */
type MaskScope = { key: string; root: string | undefined; base: string | null; out: string };

/**
 * Baseline-aware verdict for one check's outcome. An adapter with a registered
 * report verdict (fallow — keyed on its name, see `reportVerdict`) derives
 * pass/fail from the parsed report, since its exit code doesn't reliably gate;
 * everything else masks the adapter's fingerprint, keyed under the argv the
 * check ran with (`scope` fills its placeholders, and under `--changed` its
 * `base` adds the `changedArgs`). `observed` is non-null only when the run's
 * findings could be read — the ratchet must never prune from an unreadable run.
 */
function maskOutcome(adapter: Adapter, outcome: CheckOutcome, baseline: Baseline | null, scope: MaskScope): MaskResult {
  const verdict = reportVerdict(adapter.name);
  const keys = baseline ? (baseline.slots[scope.key] ?? []) : null;
  if (verdict) {
    const v = verdict(outcome.stdout, keys, scope.root);
    return { ok: v.ok, baselined: v.baselined, newKeys: v.newKeys, reason: v.reason, observed: v.observed ? v.findings : null };
  }
  const argv = [adapter.command, ...runtimeArgs(adapter, scope.base, scope.out)];
  const current = keys !== null ? fingerprint(adapter.name, outcome.stdout, argv, scope.root) : null;
  if (keys !== null && current !== null) {
    const adj = applyBaseline(current, keys, outcome.ok);
    return { ok: adj.ok, baselined: adj.baselined, newKeys: adj.newKeys, reason: couldNotVerifyReason(outcome), observed: current };
  }
  return { ok: outcome.ok, baselined: 0, newKeys: [], reason: couldNotVerifyReason(outcome), observed: null };
}

/**
 * A check's outcome after its adapter's `failOnOutput` verdict, and the reason
 * that verdict failed it (R8.3). A tool such as `gofmt -l` reports what it found
 * by printing it and exits 0 anyway, so an adapter that declares `failOnOutput`
 * fails on any non-whitespace stdout behind a clean exit, keeping the tool's
 * `exit_code: 0`. Any other outcome passes through with no reason: a non-zero
 * exit already fails on its own.
 */
function outputVerdict<T extends CheckOutcome>(adapter: Adapter, outcome: T): { outcome: T; reason: string | null } {
  if (adapter.failOnOutput !== true || outcome.exit_code !== 0 || outcome.stdout.trim() === '') return { outcome, reason: null };
  return { outcome: { ...outcome, ok: false }, reason: `${adapter.name} exited 0 but reported findings on stdout` };
}

/**
 * The skip reason for a custom check that exited its declared `skipExitCode`:
 * the check's own last stderr line, then `(exit N)`. `null` when the check
 * declares none or exited with anything else, including the `-1` of a spawn
 * failure or timeout, which the 1 to 255 range can never match.
 */
function selfSkipReason(r: ResolvedCheck, outcome: CheckOutcome): string | null {
  if (outcome.exit_code !== r.skipExitCode) return null;
  const last = outcome.stderr.split('\n').map((l) => l.trim()).findLast(Boolean) ?? 'skipped itself';
  return `${last} (exit ${outcome.exit_code})`;
}

/**
 * What the runner spawned, as the summary records it: the argv, and the pin
 * source and tool version it resolved through, with nothing for a check that
 * spawned no tool.
 */
function spawnedFields(outcome: RunnerOutcome): Pick<SummaryCheck, 'argv' | 'pin_source' | 'tool_version'> {
  return {
    ...(outcome.argv !== undefined ? { argv: outcome.argv } : {}),
    ...(outcome.pin_source !== undefined ? { pin_source: outcome.pin_source } : {}),
    ...(outcome.tool_version !== undefined ? { tool_version: outcome.tool_version } : {}),
  };
}

/**
 * Build (and print) the skipped-entry row for a slot that won't run this pass.
 * `unavailable` names the package manager the adapter can't run under.
 */
function handleSkip(r: ResolvedCheck, unavailable: string | null, ctx: RunContext): SummaryCheck {
  const entry = skippedEntry(
    unavailable !== null ? { ...r, skip: `'${r.adapter?.command} ${r.adapter?.args[0]}' is unavailable under ${unavailable}` } : r,
    ctx.targets !== null,
  );
  if (!ctx.json) writeLine(ctx.stderr, `  ○ ${entry.name.padEnd(ctx.nameWidth)}      skip  ${entry.reason ?? ''}`);
  return entry;
}

/** Print one check's status line, its baselined count, why it failed when it says, and any new (non-grandfathered) findings. */
function reportCheckResult(stderr: RunContext['stderr'], entry: SummaryCheck, mask: MaskResult, width: number): void {
  writeLine(stderr, formatStatusLine(entry, width));
  if (mask.baselined > 0) writeLine(stderr, `           ${mask.baselined} baselined (grandfathered)`);
  const reason = entry.reason ?? mask.reason;
  if (!entry.ok && reason) writeLine(stderr, `           ${reason}`);
  if (!entry.ok && mask.newKeys.length > 0) {
    writeLine(stderr, `           ${mask.newKeys.length} new, not in baseline:`);
    for (const k of mask.newKeys) writeLine(stderr, `             ${k}`);
  }
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
  /** Fingerprint to feed the ratchet, keyed by the check's name; null when nothing was observed. */
  observed: { key: string; fp: Fingerprint } | null;
  /** Diagnostics the baseline did not grandfather — feeds the red-run recover hint. */
  newKeys: string[];
};

/**
 * What a {@link CheckRunner} is handed: `base` only under `--changed`,
 * `timeout` only when the config sets one, and the pin chain of the check's
 * pack.
 */
function runnerContext(r: ResolvedCheck, ctx: RunContext, place: Place): Parameters<CheckRunner>[1] {
  return {
    cwd: place.cwd,
    changed: ctx.changed,
    ...(ctx.changedBase !== null ? { base: ctx.changedBase.ref } : {}),
    out: place.outArg,
    pm: place.pm,
    ...(ctx.timeout !== undefined ? { timeout: ctx.timeout } : {}),
    repo: ctx.cwd,
    pins: pinChain(r.pack),
    requirePins: ctx.requirePins,
  };
}

/** The raw run the summary's caller gets back: the check's name keys its baseline entry, and its root rebases its keys. */
function checkRun(r: ResolvedCheck, adapter: Adapter, outcome: CheckOutcome): CheckRun {
  return { slot: r.slot, adapter, outcome, name: checkName(r), ...(r.root !== undefined ? { root: r.root } : {}) };
}

/**
 * What an executed check produced beyond its outcome: the file it wrote, its
 * duration, and the reason a `failOnOutput` verdict failed it, if one did.
 */
type Produced = { file: string | null; place: Place; durationMs: number; reason: string | null };

/**
 * The entry an executed check records: what it is, how it ended after the
 * baseline's masking, why it failed when its tool exited 0 (R8.3), and the file
 * it wrote, named relative to the output directory, `<target>/` included.
 */
function executedEntry(r: ResolvedCheck, run: CheckRun, mask: MaskResult, written: Produced, multiTarget: boolean): SummaryCheck {
  return {
    ...checkIdentity(r, multiTarget),
    adapter: run.adapter.name,
    description: run.adapter.description,
    ok: mask.ok,
    ...(!mask.ok && written.reason !== null ? { reason: written.reason } : {}),
    exit_code: run.outcome.exit_code,
    duration_ms: written.durationMs,
    output_file: written.file === null ? null : `${written.place.prefix}${written.file}`,
    ...provenanceFields(r),
    ...spawnedFields(run.outcome),
    ...(mask.baselined > 0 ? { baselined: mask.baselined } : {}),
  };
}

/**
 * Run one active check: clear stale output, run it, persist, and mask against
 * the baseline. A custom check that exits its `skipExitCode`, or a built-in
 * that declined to run (`snippets` and `smoke` without writable scratch),
 * stops after the run instead: it records the contract's skipped shape,
 * writes no artifact and feeds nothing to the ratchet, so the baseline keeps
 * its keys for that slot.
 */
async function runOneCheck(r: ResolvedCheck, adapter: Adapter, place: Place, ctx: RunContext): Promise<CheckResult> {
  const name = checkName(r);
  if (!ctx.json) writeLine(ctx.stderr, `  ▸ ${name}  ${adapter.description}`);
  // A target's directory is made as its first check starts, since its tools
  // may write their own reports there through `{out}`.
  if (place.dir !== ctx.out) await mkdir(place.dir, { recursive: true });
  // Wipe this slot's stale artifacts before it runs, so a leaner re-run
  // can't leave last run's output behind as authoritative — and so any artifact
  // the tool writes during *this* run (for example `test.json`) survives.
  await clearSlotOutputs(place.dir, adapter);
  const start = performance.now();
  const ran = await ctx.runner(r, runnerContext(r, ctx, place));
  const durationMs = Math.round(performance.now() - start);
  const skipReason = ran.skip ?? selfSkipReason(r, ran);
  if (skipReason !== null) {
    return { entry: handleSkip({ ...r, skip: skipReason }, null, ctx), run: null, observed: null, newKeys: [] };
  }
  const { outcome, reason } = outputVerdict(adapter, ran);
  const file = await persistOutput(place.dir, adapter, outcome);

  // Masking is always on (even under a partial run); only the ratchet is gated.
  // The raw `<slot>.json` is persisted untouched — masking changes the
  // pass/fail verdict, never the authoritative output.
  const mask = maskOutcome(adapter, outcome, ctx.baseline, { key: name, root: r.root, base: ctx.changedBase?.ref ?? null, out: place.outArg });
  const run = checkRun(r, adapter, outcome);
  const entry = executedEntry(r, run, mask, { file, place, durationMs, reason }, ctx.targets !== null);
  if (!ctx.json) reportCheckResult(ctx.stderr, entry, mask, ctx.nameWidth);
  return { entry, run, observed: mask.observed !== null ? { key: name, fp: mask.observed } : null, newKeys: mask.newKeys };
}

/**
 * Run one selected check to a {@link CheckResult} — the concurrency-safe core
 * shared by the sequential (`--bail`) and wave paths. A skipped/unavailable slot
 * records a skip row and runs nothing; an active one runs, prints its status
 * line, and reports its fingerprint for the ratchet. It mutates no shared state,
 * so N of these can be in flight at once.
 */
async function runSelectedCheck(r: ResolvedCheck, ctx: RunContext): Promise<CheckResult> {
  const place = placeOf(r, ctx);
  // Skip when unresolved, or when the adapter can't run under the check's PM —
  // for example `pnpm audit` (the `security` slot) is unavailable off pnpm.
  const unavailable = r.adapter && !isAvailableUnder(r.adapter.command, r.adapter.args, place.pm) ? place.pm : null;
  if (r.skip || !r.adapter || unavailable !== null) {
    return { entry: handleSkip(r, unavailable, ctx), run: null, observed: null, newKeys: [] };
  }
  return runOneCheck(r, r.adapter, place, ctx);
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
  if (res.observed) acc.observed.set(res.observed.key, res.observed.fp);
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

/** The placeholder in an adapter's `lock` that expands to the check's target root. */
const ROOT_PLACEHOLDER = '{root}';

/**
 * The lock key a check runs under: its adapter's `lock`, with `{root}`
 * expanded to the check's target root, `.` for the repo root, or `null` when
 * the adapter declares none. Checks with equal keys never run at once, so
 * `cargo:{root}` keeps one target's cargo checks apart while another target's
 * run beside them, and a key without `{root}`, like `golangci-lint`, holds
 * across every target (R6.5).
 */
function lockKey(r: ResolvedCheck): string | null {
  const lock = r.adapter?.lock;
  return lock === undefined ? null : lock.replaceAll(ROOT_PLACEHOLDER, r.root ?? '.');
}

/** Take off `queue` the first item whose lock key no running item holds, or `undefined` when every queued item is locked out. */
function takeRunnable<T extends { key: string | null }>(queue: T[], held: ReadonlySet<string>): T | undefined {
  const at = queue.findIndex((item) => item.key === null || !held.has(item.key));
  return at === -1 ? undefined : queue.splice(at, 1)[0];
}

/**
 * Run `items` through a pool `width` workers wide: each worker takes the first
 * queued item whose lock `key` no running item holds, until the queue drains,
 * so at most `width` run at once and two with equal keys never do. A worker
 * that finds every queued item locked waits for a key to come free rather than
 * start one, so a waiting check isn't started, and its timeout, which starts
 * when it spawns, doesn't count the wait. An item is held back only while one
 * holding its key runs, so without keys, or at a `width` of 1, items start in
 * queue order. Concurrency is the worker count; each worker still processes its
 * own items one at a time. `width` is clamped to at least 1 and never exceeds
 * the item count.
 */
async function runPool<T extends { key: string | null }>(items: readonly T[], width: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const held = new Set<string>();
  let freed = Promise.withResolvers<void>();
  const release = (key: string | null): void => {
    if (key === null) return;
    held.delete(key);
    freed.resolve();
    freed = Promise.withResolvers<void>();
  };
  const runHolding = async (item: T): Promise<void> => {
    if (item.key !== null) held.add(item.key);
    try {
      await worker(item);
    } finally {
      release(item.key);
    }
  };
  const runWorker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = takeRunnable(queue, held);
      // oxlint-disable-next-line no-await-in-loop -- a worker processes its items in sequence, and waits for a key to come free when every queued item is locked; concurrency is the `width` workers running this loop at once.
      await (item === undefined ? freed.promise : runHolding(item));
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, () => runWorker());
  await Promise.all(workers);
}

/**
 * `--bail`: the flat sequential path. Checks run one at a time in group order
 * and the run stops at the first *executed* failure — fail-fast is
 * incompatible with already-launched concurrent work, so `--concurrency` is moot
 * here (the caller notes it if one was passed), and so are lock keys, since
 * nothing overlaps. For the default set (all `'any'`)
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
 * with a barrier between waves, and never two members sharing a lock key at
 * once. Results are placed by their `selected` index and assembled in that
 * order afterwards, so the report is deterministic regardless of which check
 * finishes first. Every selected check runs — there is no early stop off the
 * `--bail` path.
 */
async function executeWaves(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  const indexed = selected.map((r, i) => ({ r, i, key: lockKey(r) }));
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
