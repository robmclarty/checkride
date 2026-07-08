/**
 * The `checkride baseline` command (baseline part 2).
 *
 * Runs the normal pipeline, fingerprints every fingerprintable slot's raw output
 * (step 4's per-adapter extractors), and writes the result to
 * `checkride.baseline.json` at repo root — beside `checkride.config.json`,
 * committed, NOT under the gitignored `.check/` (D9). The file grandfathers a
 * legacy repo's existing diagnostics so a later baseline-aware run (step 6) can
 * subtract them and fail only on genuinely new findings.
 *
 * Only slots whose adapter has an extractor participate: a supported-but-clean
 * slot records an empty array (it opted in and had nothing to grandfather),
 * while a slot with no extractor (fallow, tsc, links, …) simply never appears —
 * exactly the "supported vs. unsupported" distinction the fingerprint contract
 * draws. Running each check under the resolved package manager and capturing raw
 * output is delegated to {@link runChecks}, so baseline fingerprints precisely
 * the bytes a normal run would.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Adapter, Slot } from '../adapters.js';
import type { CheckrideConfig } from '../config.js';
import type { CheckRunner, Out, RunOptions } from '../orchestrator.js';
import { runChecks } from '../orchestrator.js';
import type { PackageManager } from '../pm/index.js';

import { fingerprint } from './fingerprint.js';

/** The committed baseline artifact, at repo root beside `checkride.config.json`. */
export const BASELINE_FILE = 'checkride.baseline.json';

/** Schema version of the baseline file; independent of the summary schema (D8). */
export const BASELINE_SCHEMA_VERSION = 1;

/** Shape of `checkride.baseline.json`: per-slot sets of grandfathered keys. */
export type Baseline = {
  schema_version: number;
  slots: Record<string, string[]>;
};

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
  // baseline artifact is the file, so stdout stays clean (C5).
  const runOptions: RunOptions = {
    cwd,
    json: false,
    stderr,
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
  await writeFile(join(cwd, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);

  const slotNames = Object.keys(slots);
  const total = Object.values(slots).reduce((n, keys) => n + keys.length, 0);
  const where = slotNames.length > 0 ? slotNames.join(', ') : '(no fingerprintable slots)';
  stderr.write(`\nbaseline: wrote ${BASELINE_FILE} — ${total} diagnostic(s) across ${where}\n`);

  return { ok: true, exitCode: 0, baseline };
}
