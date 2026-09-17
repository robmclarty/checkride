/**
 * The orchestrator's contract types: the run flags, the `.check/summary.json`
 * shape, and the option/result types `runChecks` takes and returns. Types
 * only — every sibling imports from here and nothing here imports a sibling.
 */

import type { Adapter, Slot } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import type { CheckOutcome } from '../links.js';
import type { PackageManager } from '../pm/index.js';

/** Minimal writable sink (satisfied by `process.stdout`/`process.stderr`). */
export type Out = { write(text: string): unknown };

/** Selection and output flags for a run. */
export type RunFlags = {
  bail?: boolean;
  json?: boolean;
  changed?: boolean;
  all?: boolean;
  only?: string[] | null;
  skip?: string[] | null;
  include?: string[] | null;
  /** Write a capped failure excerpt to `.check/digest.md`. */
  digest?: boolean;
  /**
   * Treat zero checks actually executing as an error (exit 2), not a vacuous
   * pass. For consumers that gate on the exit code (plumbbob, CI); a human
   * exploring a fresh repo keeps the default warning-only behavior.
   */
  strict?: boolean;
  /**
   * Max checks running at once within a wave (equal-`order` group). Omitted →
   * `defaultConcurrency` (see `spawn.ts`); `1` runs the whole pipeline
   * sequentially. Ignored under `--bail`, which is fail-fast sequential by
   * definition — a `> 1` value passed alongside `--bail` earns a one-line
   * stderr note.
   */
  concurrency?: number;
};

/** A single check in the aggregate report. */
export type SummaryCheck = {
  name: string;
  adapter: string | null;
  description: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  exit_code: number | null;
  duration_ms: number;
  output_file: string | null;
  /**
   * Present only when a baseline masked one or more of this slot's diagnostics:
   * the count of current findings grandfathered by `checkride.baseline.json`.
   * Additive field — absent on runs with no baseline, so `schema_version` holds.
   */
  baselined?: number;
};

/** The `.check/summary.json` contract. A public API for agents. */
export type Summary = {
  schema_version: number;
  timestamp: string;
  ok: boolean;
  /**
   * Count of checks that actually executed (skipped entries excluded).
   * `ok: true` with `checks_run: 0` is a vacuous green — nothing was verified.
   * Additive field; `schema_version` holds.
   */
  checks_run: number;
  total_duration_ms: number;
  checks: SummaryCheck[];
};

/** Low-level runner: executes one active check and returns its raw outcome. */
export type CheckRunner = (
  resolved: ResolvedCheck,
  ctx: { cwd: string; changed: boolean; pm: PackageManager; timeout?: number },
) => Promise<CheckOutcome>;

export type RunOptions = RunFlags & {
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
   * Baseline to mask/ratchet against. Omitted → loaded from
   * `cwd/checkride.baseline.json`; `null` → run with no baseline (a `checkride
   * baseline` capture passes this so it records raw diagnostics). Injectable so
   * tests drive baseline-aware runs without a committed file.
   */
  baseline?: Baseline | null;
};

/**
 * One executed check: its slot, the adapter that ran, and the raw outcome. The
 * `baseline` command reads these to fingerprint each fingerprintable slot's
 * output — the same bytes a normal run captures — without re-walking the loop.
 * Skipped checks never appear here; they produced no output to fingerprint.
 */
export type CheckRun = { slot: string; adapter: Adapter; outcome: CheckOutcome };

export type RunResult = { ok: boolean; summary: Summary; exitCode: number; runs: CheckRun[] };
