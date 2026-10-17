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
 * The fallow slots (dead/dupes/health) are fingerprintable, so `checkride
 * baseline` grandfathers their findings like any other. Running each check under
 * the resolved package manager and capturing raw
 * output is delegated to {@link runChecks}, so baseline fingerprints precisely
 * the bytes a normal run would.
 *
 * `checkride baseline diff [<ref>]` is the read-only side: what the
 * working-tree file grandfathers that `<ref>`'s committed copy didn't, and what
 * it dropped ({@link runBaselineDiff}).
 */

import type { Adapter, Slot } from './adapters.js';
import type { Baseline } from './baseline/index.js';
import {
  BASELINE_FILE,
  BASELINE_SCHEMA_VERSION,
  diffBaselines,
  findingText,
  fingerprint,
  readBaselineAt,
  readBaselineStatus,
  writeBaseline,
} from './baseline/index.js';
import type { CheckrideConfig } from './config.js';
import type { GitRunner } from './git.js';
import { realGit } from './git.js';
import type { CheckRunner, Out, RunOptions } from './orchestrator/index.js';
import { runChecks } from './orchestrator/index.js';
import type { PackageManager } from './launch/index.js';

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
};

export type BaselineResult = { ok: boolean; exitCode: number; baseline: Baseline };

/**
 * Run the pipeline and write the per-adapter fingerprint baseline to `cwd`.
 * The repo's explicit write: it writes the file at the root whatever config
 * or output directory the run was given.
 */
export async function runBaseline(options: BaselineOptions): Promise<BaselineResult> {
  const cwd = options.cwd ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;

  // json:false so the run reports progress on stderr and nothing on stdout; the
  // baseline artifact is the file, so stdout stays clean. baseline:null so a
  // re-capture records the raw current diagnostics — never masked or pruned by an
  // existing baseline the run would otherwise pick up.
  const runOptions: RunOptions = {
    cwd,
    json: false,
    stderr,
    baseline: null,
    ...(options.slots !== undefined ? { slots: options.slots } : {}),
    ...(options.adapters !== undefined ? { adapters: options.adapters } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    ...(options.pm !== undefined ? { pm: options.pm } : {}),
    ...(options.out !== undefined ? { out: options.out } : {}),
    ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
  };
  const result = await runChecks(runOptions);

  // A capture run is never `--changed`, so each check ran its declared args.
  // Keys go under the check's name, `<target>:<slot>` for a target's check, with
  // its paths joined onto the target's root and an absolute path made relative
  // to the repo root, as a run masks with them, read from the stream the
  // adapter's parser declares.
  const slots: Record<string, string[]> = {};
  for (const run of result.runs) {
    const { adapter, outcome } = run;
    const keys = fingerprint(adapter.name, findingText(adapter.name, outcome), [adapter.command, ...adapter.args], run.root, cwd);
    if (keys === null) continue;
    slots[run.name] = [...keys].toSorted();
  }

  const baseline: Baseline = { schema_version: BASELINE_SCHEMA_VERSION, slots };
  await writeBaseline(cwd, baseline);

  const slotNames = Object.keys(slots);
  const total = Object.values(slots).reduce((n, keys) => n + keys.length, 0);
  const where = slotNames.length > 0 ? slotNames.join(', ') : '(no fingerprintable slots)';
  stderr.write(`\nbaseline: wrote ${BASELINE_FILE} — ${total} diagnostic(s) across ${where}\n`);

  return { ok: true, exitCode: 0, baseline };
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
  };
  stdout.write(options.json ? `${JSON.stringify(diff, null, 2)}\n` : renderDiff(diff));
  return { ok: true, exitCode: 0, diff };
}

/** The Markdown report: one section per check that changed, `+` for added keys and `-` for removed. */
function renderDiff(diff: BaselineDiff): string {
  const lines = [`# checkride baseline diff: ${diff.ref} (${diff.sha.slice(0, 7)}) to the working tree`, ''];
  if (diff.added_count === 0 && diff.removed_count === 0) {
    lines.push(`No keys added or removed since ${diff.ref}.`, '');
    return lines.join('\n');
  }
  lines.push(`${diff.added_count} key(s) added, ${diff.removed_count} removed.`, '');
  const checks = new Set([...Object.keys(diff.added), ...Object.keys(diff.removed)]);
  for (const check of [...checks].toSorted()) {
    const added = diff.added[check] ?? [];
    const removed = diff.removed[check] ?? [];
    lines.push(`## ${check}: ${added.length} added, ${removed.length} removed`, '');
    for (const key of added) lines.push(`+ ${key}`);
    for (const key of removed) lines.push(`- ${key}`);
    lines.push('');
  }
  return lines.join('\n');
}
