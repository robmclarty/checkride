/**
 * The orchestrator's contract types: the run flags, the `.check/summary.json`
 * shape, and the option/result types `runChecks` takes and returns. Types
 * only — every sibling imports from here and nothing here imports a sibling.
 */

import type { Adapter, Slot } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import type { CheckOrigin, CheckrideConfig, ResolvedCheck } from '../config.js';
import type { NamedBase } from '../git.js';
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
   * Why the check is in the run (see {@link CheckOrigin}). Present exactly when
   * `adapter` isn't null. Additive field; `schema_version` holds.
   */
  origin?: CheckOrigin;
  /**
   * With `origin: 'detected'`, the signal that chose the adapter: the detect
   * file, `package.json: <dep>` or `package.json: scripts.<name>`.
   */
  detected_by?: string;
  /**
   * Present only when a baseline masked one or more of this slot's diagnostics:
   * the count of current findings grandfathered by `checkride.baseline.json`.
   * Additive field — absent on runs with no baseline, so `schema_version` holds.
   */
  baselined?: number;
};

/**
 * What a run selected (R8.1): `partial`, plus each selection or mode flag the
 * run was given and nothing for one it wasn't. `static_only`, `discover`,
 * `defaults`, `pins` and `out` belong to flags checkride doesn't have yet, so
 * no run writes them. Paths are absolute.
 */
export type SummaryRun = {
  /**
   * True when `--only`, `--skip` or `--changed` narrowed the run, or `--bail`
   * stopped it at a failure: the test that keeps the run from ratcheting the
   * baseline, so the two always agree.
   */
  partial: boolean;
  only?: string[];
  skip?: string[];
  include?: string[];
  all?: true;
  changed?: true;
  static_only?: true;
  discover?: true;
  config?: string;
  defaults?: string;
  pins?: string;
  out?: string;
};

/** The base a `--changed` run measured from: the ref as given, and the commit it names. */
export type SummaryBase = { ref: string; sha: string };

/** The work tree a run read (R8.1): the commit checked out, whether it held changes, and the `--changed` base. */
export type SummaryGit = { head: string; dirty: boolean; base?: SummaryBase };

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
  /** What the run selected, and whether it saw the whole pipeline. Additive field; `schema_version` holds. */
  run: SummaryRun;
  /**
   * The work tree the run read, present when the working directory is in a git
   * work tree whose `HEAD` names a commit and git answered within
   * `GIT_STATE_TIMEOUT_MS`. Additive field; `schema_version` holds.
   */
  git?: SummaryGit;
  checks: SummaryCheck[];
};

/** Low-level runner: executes one active check and returns its raw outcome. */
export type CheckRunner = (
  resolved: ResolvedCheck,
  /** `base` is the ref a `--changed` run measures from, present exactly when `changed` is. */
  ctx: { cwd: string; changed: boolean; base?: string; pm: PackageManager; timeout?: number },
) => Promise<CheckOutcome>;

export type RunOptions = RunFlags & {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  /**
   * The absolute path `config` was read from when it isn't
   * `<cwd>/checkride.config.json` (`--config`, `CHECKRIDE_CONFIG`). It loads
   * nothing; the caller passes the loaded `config` too. A file outside `cwd`
   * makes this a consumer run, which never ratchets the baseline.
   */
  configPath?: string;
  /**
   * The base a `--changed` run measures from, when one is named (`--base`,
   * `CHECKRIDE_BASE`): `ref` as given, `from` what named it, for the exit-2
   * error when it doesn't resolve. Omitted, the config's `changedBase` names
   * it, else `origin/main` when it resolves, else `HEAD`. Unused off `--changed`.
   */
  base?: NamedBase;
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
