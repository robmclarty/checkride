/**
 * The `checkride baseline` command.
 *
 * Runs the normal pipeline, fingerprints every fingerprintable slot's raw output
 * via the per-adapter extractors, and writes the result to
 * `checkride.baseline.json` at repo root — beside `checkride.config.json`,
 * committed, NOT under the gitignored `.check/`. The file grandfathers a
 * repo's existing diagnostics so a baseline-aware run can subtract them and
 * fail only on genuinely new findings.
 *
 * Only slots whose adapter has an extractor participate: a supported-but-clean
 * slot records an empty array (it opted in and had nothing to grandfather),
 * while a slot with no extractor (tsc, links, …) simply never appears — exactly
 * the "supported vs. unsupported" distinction the fingerprint contract draws.
 * The fallow slots (dead/dupes/health) are fingerprintable, so `checkride
 * baseline` grandfathers their findings like any other. Running each check under
 * the resolved package manager and capturing raw
 * output is delegated to {@link runChecks}, so baseline fingerprints precisely
 * the bytes a normal run would.
 */

import type { Adapter, Slot } from './adapters.js';
import { fingerprint } from './baseline/fingerprint.js';
import type { Baseline } from './baseline/store.js';
import { BASELINE_FILE, BASELINE_SCHEMA_VERSION, writeBaseline } from './baseline/store.js';
import type { CheckrideConfig } from './config.js';
import type { CheckRunner, Out, RunOptions } from './orchestrator.js';
import { runChecks } from './orchestrator.js';
import type { PackageManager } from './pm/index.js';

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
};

export type BaselineResult = { ok: boolean; exitCode: number; baseline: Baseline };

/** Run the pipeline and write the per-adapter fingerprint baseline to `cwd`. */
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
    ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
  };
  const result = await runChecks(runOptions);

  const slots: Record<string, string[]> = {};
  for (const run of result.runs) {
    const keys = fingerprint(run.adapter.name, run.outcome.stdout);
    if (keys === null) continue;
    slots[run.slot] = [...keys].toSorted();
  }

  const baseline: Baseline = { schema_version: BASELINE_SCHEMA_VERSION, slots };
  await writeBaseline(cwd, baseline);

  const slotNames = Object.keys(slots);
  const total = Object.values(slots).reduce((n, keys) => n + keys.length, 0);
  const where = slotNames.length > 0 ? slotNames.join(', ') : '(no fingerprintable slots)';
  stderr.write(`\nbaseline: wrote ${BASELINE_FILE} — ${total} diagnostic(s) across ${where}\n`);

  return { ok: true, exitCode: 0, baseline };
}
