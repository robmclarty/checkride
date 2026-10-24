/**
 * The `checkride baseline` command.
 *
 * Runs the normal pipeline, fingerprints every fingerprintable slot's raw output
 * via the per-adapter parsers, and writes the result to
 * `checkride.baseline.json` at repo root — beside `checkride.config.json`,
 * committed, NOT under the gitignored `.check/`. The file grandfathers a
 * repo's existing diagnostics so a baseline-aware run can subtract them and
 * fail only on genuinely new findings.
 *
 * Only slots whose adapter has a parser participate: a supported-but-clean
 * slot records an empty array (it opted in and had nothing to grandfather),
 * while a slot with no parser (tsc, links, …) simply never appears — exactly
 * the "supported vs. unsupported" distinction the fingerprint contract draws.
 * The capture doesn't run such a slot at all, since its output adds nothing.
 * `--only` and `--skip` narrow it to the checks they select, and every other
 * check keeps the entry the file holds for it.
 * A supported slot whose check never reached a verdict (refused, timed out,
 * crashed) keeps the keys the file already held for it, so a re-capture can't
 * empty a slot it never observed.
 * The fallow slots (dead/dupes/health) are fingerprintable, so `checkride
 * baseline` grandfathers their findings like any other. Running each check under
 * the resolved package manager and capturing raw
 * output is delegated to {@link runChecks}, so baseline fingerprints precisely
 * the bytes a normal run would.
 *
 * `checkride baseline --versions` runs the same pipeline and adds no key: it
 * moves each check's capture record to the copy its tool ran, and prunes the
 * keys that copy no longer reports, where that can't change a verdict
 * ({@link runBaselineVersions}).
 *
 * `checkride baseline diff [<ref>]` is the read-only side: what the
 * working-tree file grandfathers that `<ref>`'s committed copy didn't, and what
 * it dropped ({@link runBaselineDiff}).
 */

import type { Adapter, Slot } from './adapters.js';
import { isInside } from './artifacts/index.js';
import type { Baseline, Captured, Observation, RanWith, Recount, Rerecord, Tally } from './baseline/index.js';
import {
  BASELINE_FILE,
  BASELINE_SCHEMA_VERSION,
  baselinesEqual,
  capturedRecord,
  copyNamed,
  countGrandfathered,
  diffBaselines,
  isFingerprintable,
  loadBaseline,
  observedTally,
  readBaselineAt,
  readBaselineStatus,
  rerecordCopies,
  writeBaseline,
} from './baseline/index.js';
import type { CheckrideConfig } from './config.js';
import type { GitRunner } from './git.js';
import { realGit } from './git.js';
import type { CheckRun, CheckRunner, Out, RunnerOutcome, RunOptions, RunResult, SummaryCheck } from './orchestrator/index.js';
import { narrowedAway, runChecks } from './orchestrator/index.js';
import type { PackageManager } from './launch/index.js';
import { packToolchain } from './launch/index.js';

export type BaselineOptions = {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stdout?: Out;
  stderr?: Out;
  runner?: CheckRunner;
  /** Package manager to run under; detected from `cwd` when omitted. */
  pm?: PackageManager;
  /**
   * The output directory the capture run writes its artifacts to (`--out`,
   * `CHECKRIDE_OUT`). The baseline itself still lands at `cwd`'s root.
   */
  out?: string;
  /**
   * `--only` and `--skip`: run only the checks these tokens select, as a
   * run's do, and leave every other check's entry as the file holds it.
   */
  only?: string[] | null;
  skip?: string[] | null;
};

export type BaselineResult = { ok: boolean; exitCode: number; baseline: Baseline };

/**
 * The keys a capture records, per check. A capture run is never `--changed`,
 * so each check ran its declared args. Keys go under the check's name,
 * `<target>:<slot>` for a target's check, with its paths joined onto the
 * target's root and an absolute path made relative to the repo root, as a run
 * masks with them, read from the stream the adapter's parser declares.
 *
 * Each check it observed is counted: a key found more than once records how
 * many times, so it grandfathers that many findings and no more.
 *
 * A check whose adapter has a parser but whose run wasn't observed (a refusal,
 * timeout or crash — see `observedTally`) keeps the keys `previous` holds for
 * it, and their counts, or none, and stderr names it. Leaving it out instead
 * would write the file without it, which masks exactly what an empty entry
 * does: the capture would throw away debt the run never looked at.
 */
function capturedSlots(runs: readonly CheckRun[], previous: Baseline | null, cwd: string, stderr: Out): Captures {
  const captures: Captures = { slots: {}, counts: {}, kept: new Set<string>() };
  for (const [name, tally] of observedChecks(runs, cwd)) {
    if (tally === null) {
      keepPrevious(name, previous, captures);
      stderr.write(`baseline: ${name} didn't run to a verdict (refused, timed out or crashed), so it keeps its ${previous?.slots[name]?.length ?? 0} previous key(s)\n`);
      continue;
    }
    captures.slots[name] = [...tally.keys()].toSorted();
    if (tally.size > 0) captures.counts[name] = Object.fromEntries([...tally].filter(([, n]) => n >= 2));
  }
  return captures;
}

/** What a capture records: each check's keys and their counts, and the checks it kept from the previous file. */
type Captures = { slots: Record<string, string[]>; counts: Record<string, Record<string, number>>; kept: Set<string> };

/** Keep a check the capture didn't observe as `previous` held it: its keys, and their counts if it counted them. */
function keepPrevious(name: string, previous: Baseline | null, captures: Captures): void {
  const keys = previous?.slots[name];
  const counts = previous?.counts?.[name];
  if (keys !== undefined) captures.slots[name] = keys;
  if (counts !== undefined) captures.counts[name] = counts;
  captures.kept.add(name);
}

/**
 * What a capture run observed of each check whose adapter has a parser, by
 * check name: the keys it reported, with how many findings share each, keyed
 * as a run masks with them, or `null` for a check that didn't run to a
 * verdict (see `observedTally`).
 */
export function observedChecks(runs: readonly CheckRun[], cwd: string): Map<string, Tally | null> {
  const observed = new Map<string, Tally | null>();
  for (const { adapter, outcome, name, root } of runs) {
    if (isFingerprintable(adapter.name)) observed.set(name, observedTally(adapter.name, outcome, [adapter.command, ...adapter.args], root, cwd));
  }
  return observed;
}

/**
 * How each check `slots` holds was captured: the pin source and version its
 * summary entry records, for a check this run observed, and the previous
 * record for one it `kept`, whose keys it didn't capture either. A check
 * whose tool resolved through no pin source records nothing.
 */
function capturedWith(
  slots: Readonly<Record<string, string[]>>,
  kept: ReadonlySet<string>,
  checks: readonly SummaryCheck[],
  previous: Baseline | null,
): Record<string, Captured> {
  const byName = new Map(checks.map((c) => [c.name, c]));
  const captured: Record<string, Captured> = {};
  for (const name of Object.keys(slots)) {
    const entry = kept.has(name) ? previous?.captured_with?.[name] : capturedFrom(byName.get(name));
    if (entry !== undefined) captured[name] = entry;
  }
  return captured;
}

/** The capture record a summary entry gives, or none for a check that resolved through no pin source. */
function capturedFrom(check: SummaryCheck | undefined): Captured | undefined {
  return check === undefined ? undefined : capturedRecord(check);
}

/** The baseline a capture writes: its keys, how each check's were captured when any check records it, and their counts. */
function capturedBaseline(captures: Captures, captured: Record<string, Captured>): Baseline {
  const { slots, counts } = captures;
  return {
    schema_version: BASELINE_SCHEMA_VERSION,
    slots,
    ...(Object.keys(captured).length > 0 ? { captured_with: captured } : {}),
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
  };
}

/** The `--only` and `--skip` a capture selects with, each present only when given. */
function selectionOf(options: BaselineOptions): Pick<RunOptions, 'only' | 'skip'> {
  return { ...(options.only ? { only: options.only } : {}), ...(options.skip ? { skip: options.skip } : {}) };
}

/**
 * The run a capture makes. `json: false` so the run reports progress on
 * stderr and nothing on stdout: the baseline artifact is the file, so stdout
 * stays clean. `baseline: null` so it records the raw current diagnostics,
 * never masked or pruned by an existing baseline the run would otherwise pick
 * up, and prints no drift notice. `fingerprintableOnly` skips each check
 * whose output adds no key, and `--only` and `--skip` select as a run's do.
 */
function captureRun(options: BaselineOptions, cwd: string, stderr: Out): RunOptions {
  return {
    cwd,
    json: false,
    stderr,
    baseline: null,
    fingerprintableOnly: true,
    ...selectionOf(options),
    ...(options.slots !== undefined ? { slots: options.slots } : {}),
    ...(options.adapters !== undefined ? { adapters: options.adapters } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    ...(options.pm !== undefined ? { pm: options.pm } : {}),
    ...(options.out !== undefined ? { out: options.out } : {}),
    ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
  };
}

/** The flags that narrow a capture, as its messages name them, or `null` for a capture of every check. */
function narrowingFlags(options: BaselineOptions): string | null {
  const flags = [...(options.only ? ['--only'] : []), ...(options.skip ? ['--skip'] : [])];
  return flags.length === 0 ? null : flags.join(' and ');
}

/**
 * The committed baseline a narrowed capture merges into, its keys as the file
 * holds them, or `null` when there is none yet. One that can't be parsed
 * stops the capture before anything runs, since the checks the selection
 * leaves out could keep none of their keys, where a capture of every check
 * replaces the file whole.
 */
function baselineToNarrow(cwd: string, flags: string): Baseline | null {
  const read = readBaselineStatus(cwd, 'as-written');
  if (read.state === 'unparseable') {
    throw new Error(
      `baseline ${flags}: ${BASELINE_FILE} can't be parsed, or comes from a newer checkride, so the checks ${flags} leaves out couldn't keep their keys; restore it with \`checkride recover\`, or capture every check with \`checkride baseline\``,
    );
  }
  return read.baseline;
}

/**
 * `base` with each of `checks` taking the entry `from` holds for it, its keys,
 * counts and capture record, or none of them where `from` holds none, and
 * every other check keeping the entry `base` holds, byte for byte: what a
 * narrowed capture writes, and what `baseline --versions` writes once it has
 * re-recorded a check.
 */
function withEntriesOf(base: Baseline | null, from: Baseline, checks: ReadonlySet<string>): Baseline {
  const pick = <T>(record: Readonly<Record<string, T>> | undefined, taken: boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([check]) => checks.has(check) === taken));
  const records = { ...pick(base?.captured_with, false), ...pick(from.captured_with, true) };
  const counts = { ...pick(base?.counts, false), ...pick(from.counts, true) };
  return {
    schema_version: BASELINE_SCHEMA_VERSION,
    slots: { ...pick(base?.slots, false), ...pick(from.slots, true) },
    ...(Object.keys(records).length > 0 ? { captured_with: records } : {}),
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
  };
}

/**
 * Write a narrowed capture (`--only`, `--skip`): each check it recorded takes
 * its new entry, and every other check, one the selection left out or one
 * that didn't run to a verdict, keeps the entry `previous`, the file as
 * written, holds for it. It writes nothing when it recorded no check, and
 * says so; stderr has already said why for each check it ran.
 */
async function writeNarrowed(cwd: string, flags: string, previous: Baseline | null, captured: { captures: Captures; baseline: Baseline }, stderr: Out): Promise<Baseline> {
  const recorded = new Set(Object.keys(captured.captures.slots).filter((name) => !captured.captures.kept.has(name)));
  if (recorded.size === 0) {
    stderr.write(`\nbaseline: ${flags} recorded no check, so ${BASELINE_FILE} is unchanged\n`);
    return previous ?? EMPTY_BASELINE;
  }
  const baseline = withEntriesOf(previous, captured.baseline, recorded);
  await writeBaseline(cwd, baseline);
  const findings = countGrandfathered(withEntriesOf(null, captured.baseline, recorded));
  const others = Object.keys(baseline.slots).length - recorded.size;
  const kept = others > 0 ? `; ${others} other check(s) kept as they were` : '';
  stderr.write(`\nbaseline: wrote ${BASELINE_FILE} — ${findings} finding(s) across ${[...recorded].join(', ')}${kept}\n`);
  return baseline;
}

/**
 * Run the pipeline and write the per-adapter fingerprint baseline to `cwd`.
 * The repo's explicit write: it writes the file at the root whatever config
 * or output directory the run was given. Under `--only` or `--skip` it
 * rewrites only the checks the capture recorded ({@link writeNarrowed}).
 */
export async function runBaseline(options: BaselineOptions): Promise<BaselineResult> {
  const cwd = options.cwd ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;
  const flags = narrowingFlags(options);
  const narrowedFrom = flags === null ? null : baselineToNarrow(cwd, flags);
  const result = await runChecks(captureRun(options, cwd, stderr));
  const previous = flags === null ? loadBaseline(cwd) : narrowedFrom;
  const captures = capturedSlots(result.runs, previous, cwd, stderr);
  const baseline = capturedBaseline(captures, capturedWith(captures.slots, captures.kept, result.summary.checks, previous));
  if (flags !== null) return { ok: true, exitCode: 0, baseline: await writeNarrowed(cwd, flags, previous, { captures, baseline }, stderr) };
  await writeBaseline(cwd, baseline);

  const slotNames = Object.keys(captures.slots);
  const where = slotNames.length > 0 ? slotNames.join(', ') : '(no fingerprintable slots)';
  stderr.write(`\nbaseline: wrote ${BASELINE_FILE} — ${countGrandfathered(baseline)} finding(s) across ${where}\n`);

  return { ok: true, exitCode: 0, baseline };
}

export type BaselineVersionsOptions = BaselineOptions & {
  /**
   * The absolute path `config` was read from, when `--config` or
   * `CHECKRIDE_CONFIG` named one. A file outside `cwd` is refused: it can run
   * fewer checks, or other arguments, than the repo's own config, and prune
   * keys the repo's run still reports.
   */
  configPath?: string;
};

export type BaselineVersionsResult = BaselineResult & {
  /** What was done with each check the committed baseline holds, by check name. */
  results: Rerecord[];
  /** Whether the file was rewritten: true exactly when a check was re-recorded. */
  written: boolean;
};

/**
 * The committed baseline `--versions` re-records, read before anything runs,
 * or the usage error that stops it: a `--config` outside the repo, no file to
 * re-record, or one that can't be parsed.
 */
function committedForVersions(cwd: string, configPath: string | undefined): Baseline {
  if (configPath !== undefined && !isInside(cwd, configPath)) {
    throw new Error(
      `baseline --versions: --config names ${configPath}, outside the repo, which can run fewer checks or other arguments than the repo's own config and prune keys its run still reports`,
    );
  }
  const read = readBaselineStatus(cwd);
  if (read.state === 'absent') throw new Error(`baseline --versions: there's no ${BASELINE_FILE} to re-record; capture one with \`checkride baseline\``);
  if (read.baseline === null) throw new Error(`baseline --versions: ${BASELINE_FILE} can't be parsed, or comes from a newer checkride; restore it with \`checkride recover\``);
  return read.baseline;
}

/**
 * What the run observed of each check whose adapter has a parser: the keys it
 * reported, and how its tool ran, as its summary entry records it, with
 * whether a pin chose the toolchain it ran on, which only the run knows.
 */
function observations(result: RunResult, cwd: string): Map<string, Observation> {
  const byName = new Map(result.summary.checks.map((c) => [c.name, c]));
  const outcomes = new Map(result.runs.map((r) => [r.name, r.outcome]));
  const observed = new Map<string, Observation>();
  for (const [name, keys] of observedChecks(result.runs, cwd)) observed.set(name, { keys, ran: ranWith(byName.get(name), outcomes.get(name)) });
  return observed;
}

/** How a check's tool ran: its summary entry's record, and whether a pin chose the toolchain, from its run's outcome. */
function ranWith(check: SummaryCheck | undefined, outcome: RunnerOutcome | undefined): RanWith {
  const recorded = (check === undefined ? undefined : capturedRecord(check)) ?? {};
  return outcome?.toolchain_pinned === undefined ? recorded : { ...recorded, toolchain_pinned: outcome.toolchain_pinned };
}

/** How a line names a check's tool, and its pack's toolchain, from the summary: its adapter, or the check's name when none ran. */
type ToolNames = ReadonlyMap<string, { tool: string; toolchain: string | undefined }>;

/** What a line says of a check left for a reason that names no copy, and of one with nothing to change: nothing. */
const LEFT_LINES: Readonly<Record<'unchanged' | 'not-run' | 'no-verdict', string | null>> = {
  unchanged: null,
  'not-run': "left: it didn't run",
  'no-verdict': "left: it didn't run to a verdict (refused, timed out or crashed)",
};

/** The line for a re-recorded check: the copy it was captured with, the one it ran, and the keys pruned. */
function rerecordedLine(r: Extract<Rerecord, { outcome: 'rerecorded' }>, tool: string, toolchain: string | undefined): string {
  const pruned = r.pruned > 0 ? `; ${r.pruned} key(s) pruned` : '';
  if (r.from === undefined) return `${r.check} recorded: ${tool} ${copyNamed(r.to, toolchain)}${pruned}`;
  return `${r.check} re-recorded: ${tool} ${copyNamed(r.from, toolchain)} → ${copyNamed(r.to, toolchain)}${pruned}`;
}

/** The line for a check left because no pin of the repo's chose its copy: its tool, or the toolchain it ran on. */
function unpinnedLine(r: Extract<Rerecord, { outcome: 'unpinned' }>, toolchain: string | undefined): string {
  if (r.ran.pin_source === undefined) return `${r.check} left: its tool resolved through no pin source`;
  if (r.ran.pin_source === 'path') return `${r.check} left: it ran an unpinned copy ${copyNamed(r.ran, toolchain)}`;
  return `${r.check} left: it ran on ${toolchain ?? 'its toolchain'} ${r.ran.toolchain_version ?? ''}, which no pin of the repo's chose; pin it, or run in the repo's dev shell`;
}

/** The line one result prints, or `null` for a check with nothing to change. */
function rerecordLine(r: Rerecord, names: ToolNames): string | null {
  const { tool, toolchain } = names.get(r.check) ?? { tool: r.check, toolchain: undefined };
  if (r.outcome === 'rerecorded') return rerecordedLine(r, tool, toolchain);
  if (r.outcome === 'unpinned') return unpinnedLine(r, toolchain);
  if (r.outcome === 'new-keys') {
    return `${r.check} left: ${r.newKeys} key(s) new or found past their count under ${tool} ${copyNamed(r.ran, toolchain)}; fix them, or have a human review them and run \`checkride baseline\``;
  }
  const left = LEFT_LINES[r.outcome];
  return left === null ? null : `${r.check} ${left}`;
}

/** Print a line for each check re-recorded or left, then what was written and the counts. */
function reportRerecords(stderr: Out, results: readonly Rerecord[], names: ToolNames, written: boolean): void {
  for (const r of results) {
    const line = rerecordLine(r, names);
    if (line !== null) stderr.write(`baseline --versions: ${line}\n`);
  }
  const count = (outcomes: readonly Rerecord['outcome'][]): number => results.filter((r) => outcomes.includes(r.outcome)).length;
  const tally = `${count(['rerecorded'])} re-recorded, ${count(['not-run', 'no-verdict', 'new-keys', 'unpinned'])} left, ${count(['unchanged'])} unchanged`;
  stderr.write(
    written
      ? `baseline --versions: wrote ${BASELINE_FILE}: ${tally}; review it with \`git diff ${BASELINE_FILE}\`\n`
      : `baseline --versions: ${BASELINE_FILE} is unchanged: ${tally}\n`,
  );
}

/**
 * `checkride baseline --versions`: run the pipeline as a capture does, then
 * re-record the copy each check's tool ran as, where that adds no key
 * (`rerecordCopies`), and write the file only when a check was re-recorded.
 * Under `--only` or `--skip` only the checks they select run, and the rest
 * keep their entries.
 * The fix for a check a tool upgrade holds back from the ratchet, once the
 * repo pins the new copy, that a capture isn't: a capture would grandfather
 * whatever is new in the run too. Exits 0 whenever it ran; a usage error, a
 * missing or unparseable baseline included, throws, which `runCli` renders as
 * exit 2.
 */
export async function runBaselineVersions(options: BaselineVersionsOptions): Promise<BaselineVersionsResult> {
  const cwd = options.cwd ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;
  const committed = committedForVersions(cwd, options.configPath);
  const result = await runChecks(captureRun(options, cwd, stderr));
  const rerecorded = rerecordCopies(committed, observations(result, cwd));
  const { results } = rerecorded;
  // Every check it didn't re-record is written back as the file holds it, an
  // earlier release's key forms included, byte for byte.
  const asWritten = readBaselineStatus(cwd, 'as-written').baseline ?? committed;
  const moved = new Set(results.flatMap((r) => (r.outcome === 'rerecorded' ? [r.check] : [])));
  const baseline = withEntriesOf(asWritten, rerecorded.baseline, moved);
  const written = !baselinesEqual(asWritten, baseline);
  if (written) await writeBaseline(cwd, baseline);
  const names: ToolNames = new Map(result.summary.checks.map((c) => [c.name, { tool: c.adapter ?? c.name, toolchain: packToolchain(c.pack) }]));
  // A check `--only` or `--skip` left out keeps its entry, as one that didn't
  // run does, and goes unnamed, since the selection says why.
  const away = new Set(result.summary.checks.filter(narrowedAway).map((c) => c.name));
  stderr.write('\n');
  reportRerecords(stderr, results.filter((r) => !away.has(r.check)), names, written);
  return { ok: true, exitCode: 0, baseline, results, written };
}

export type BaselineDiffOptions = {
  cwd?: string;
  /** The ref to diff against; `HEAD` when omitted. */
  ref?: string;
  /** Print {@link BaselineDiff} as JSON instead of the Markdown report. */
  json?: boolean;
  stdout?: Out;
  /** Injectable for tests. */
  git?: GitRunner;
};

/** What `baseline diff --json` prints; the shape `docs/contract.md` promises. */
export type BaselineDiff = {
  ref: string;
  /** The full sha `ref` resolved to. */
  sha: string;
  /** Per check, the keys the working-tree file has and `ref`'s copy lacks. */
  added: Record<string, string[]>;
  /** Per check, the keys `ref`'s copy has and the working-tree file lacks. */
  removed: Record<string, string[]>;
  added_count: number;
  removed_count: number;
  /**
   * Per check, each key both copies hold whose count changed: how many
   * findings it grandfathers at `ref` and in the working tree, `null` for a
   * check captured before counts, which grandfathers any number.
   */
  recounted: Record<string, Record<string, Recount>>;
  recounted_count: number;
};

export type BaselineDiffResult = { ok: boolean; exitCode: number; diff: BaselineDiff };

const EMPTY_BASELINE: Baseline = { schema_version: BASELINE_SCHEMA_VERSION, slots: {} };

/**
 * Diff the working-tree baseline against the copy committed at `ref`. A file
 * missing on either side reads as empty, so a ref from before the baseline
 * existed reports every current key as added. It exits 0 whenever it ran,
 * keys added or not: the diff is evidence for a reviewer, not a verdict. A ref
 * that names no commit, a missing git, or a file that can't be parsed on
 * either side throws, which `runCli` renders as exit 2.
 */
export async function runBaselineDiff(options: BaselineDiffOptions): Promise<BaselineDiffResult> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const ref = options.ref ?? 'HEAD';
  const current = readBaselineStatus(cwd);
  if (current.state === 'unparseable') {
    throw new Error(`baseline diff: ${BASELINE_FILE} in the working tree can't be parsed, or comes from a newer checkride`);
  }
  const committed = await readBaselineAt(options.git ?? realGit(cwd), ref);
  const delta = diffBaselines(committed.baseline, current.baseline ?? EMPTY_BASELINE);
  const diff: BaselineDiff = {
    ref,
    sha: committed.sha,
    added: delta.restored,
    removed: delta.absent,
    added_count: delta.restoredCount,
    removed_count: delta.absentCount,
    recounted: delta.recounted,
    recounted_count: delta.recountedCount,
  };
  stdout.write(options.json ? `${JSON.stringify(diff, null, 2)}\n` : renderDiff(diff));
  return { ok: true, exitCode: 0, diff };
}

/**
 * The Markdown report: one section per check that changed, `+` for added
 * keys, `-` for removed, and `~` for a key whose count changed, `any` for a
 * check captured before counts.
 */
function renderDiff(diff: BaselineDiff): string {
  const lines = [`# checkride baseline diff: ${diff.ref} (${diff.sha.slice(0, 7)}) to the working tree`, ''];
  if (diff.added_count === 0 && diff.removed_count === 0 && diff.recounted_count === 0) {
    lines.push(`No keys added or removed since ${diff.ref}.`, '');
    return lines.join('\n');
  }
  lines.push(`${diff.added_count} key(s) added, ${diff.removed_count} removed${recountedNote(diff.recounted_count)}.`, '');
  const checks = new Set([...Object.keys(diff.added), ...Object.keys(diff.removed), ...Object.keys(diff.recounted)]);
  for (const check of [...checks].toSorted()) lines.push(...checkSection(diff, check));
  return lines.join('\n');
}

/** `, N recounted` for a diff whose counts changed, and nothing for one whose didn't. */
function recountedNote(n: number): string {
  return n === 0 ? '' : `, ${n} recounted`;
}

/** A key's count as the diff names it: the number, or `any` for a check captured before counts. */
function countNamed(n: number | null): string {
  return n === null ? 'any' : String(n);
}

/** One check's section of {@link renderDiff}. */
function checkSection(diff: BaselineDiff, check: string): string[] {
  const added = diff.added[check] ?? [];
  const removed = diff.removed[check] ?? [];
  const recounted = Object.entries(diff.recounted[check] ?? {});
  return [
    `## ${check}: ${added.length} added, ${removed.length} removed${recountedNote(recounted.length)}`,
    '',
    ...added.map((key) => `+ ${key}`),
    ...removed.map((key) => `- ${key}`),
    ...recounted.map(([key, { from, to }]) => `~ ${key} (${countNamed(from)} → ${countNamed(to)})`),
    '',
  ];
}
