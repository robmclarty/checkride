/**
 * The orchestrator's contract types: the run flags, the `.check/summary.json`
 * shape, and the option/result types `runChecks` takes and returns. Types
 * only — every sibling imports from here and nothing here imports a sibling.
 */

import type { Adapter, Slot } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import type { CheckOrigin, CheckrideConfig, ResolvedCheck } from '../config.js';
import type { NamedBase } from '../git.js';
import type { PackageManager } from '../launch/index.js';
import type { CheckOutcome } from '../links.js';
import type { PinSourceName } from '../packs/index.js';

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
  /** Write a capped failure excerpt to `digest.md` in the output directory. */
  digest?: boolean;
  /**
   * Keep only the checks that read the repo as data (R13.4): every other
   * selected check is skipped with a `static-only:` reason, as is one whose
   * tool would need an install. A best-effort selector for a run before the
   * repo is installed, never a sandbox. The run is partial, so it never
   * ratchets the baseline.
   */
  staticOnly?: boolean;
  /**
   * Discover targets at run time (R13.2): the ones the repo's files propose
   * are declared in memory, nothing is written, and the run never ratchets the
   * baseline. A config that already declares targets makes the run a usage
   * error.
   */
  discover?: boolean;
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
  /** The slot or custom check's name, or `<target>:<slot>` for a target's check in multi-target mode. */
  name: string;
  /** In multi-target mode, the target a target-scope check belongs to. Additive field; `schema_version` holds. */
  target?: string;
  /** In multi-target mode, the catalogue slot or custom check name, on every check. Additive field; `schema_version` holds. */
  slot?: string;
  /**
   * In multi-target mode, the pack that fills the check: its target's, or
   * `repo` for one that checks the repo as a whole. The same in implicit mode
   * when the repo's root marks a pack other than ts (R2.1). Additive field;
   * `schema_version` holds.
   */
  pack?: string;
  /** The directory the check ran from, relative to the repo root, when it isn't the root. Additive field; `schema_version` holds. */
  cwd?: string;
  /**
   * Under `--changed`, the Go package patterns the check narrowed to and the
   * workspace's module count (R10.4). Additive field; `schema_version` holds.
   */
  narrowed?: { units: string[]; total: number };
  adapter: string | null;
  description: string;
  ok: boolean;
  skipped?: boolean;
  /**
   * Why a skipped check sat out; why a failed check whose adapter declares
   * `failOnOutput` failed with exit 0; or, for a check refused before its tool
   * spawned (exit 1), the refusal's first line. Absent otherwise.
   */
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
   * Present when the check spawned its own tool: the command and arguments
   * exactly as handed to `spawn`, after package-manager translation, so the
   * canonical `pnpm exec oxlint` reads `npx --no-install oxlint` under npm.
   * Built-ins and skipped checks have none. Additive field; `schema_version`
   * holds.
   */
  argv?: string[];
  /**
   * Present when the check's tool resolved through a pin source: the one that
   * declared the copy that ran (`js-lockfile`, `mise`), `nix` for a copy a Nix
   * dev shell the repo declares put on `PATH`, or `path` for a tool nothing
   * declared, found on `PATH`. A command spawned as written, a built-in and a
   * skipped check have none. Additive field; `schema_version` holds.
   */
  pin_source?: PinSourceName;
  /**
   * With `pin_source`, the version of the tool that ran when a file read found
   * it, or the pin source itself resolved it, as mise does (R6.3), never by
   * running the tool. Additive field; `schema_version` holds.
   */
  tool_version?: string;
  /**
   * With `pin_source`, in a pack that names a toolchain (`go` for the go
   * pack), the release of that toolchain the check's tool ran on, never by
   * running it: the version its pin source named when the check runs the
   * toolchain itself, mise's answer where mise runs the tool, else the
   * `VERSION` file of the `go` its `PATH` finds. Additive field;
   * `schema_version` holds.
   */
  toolchain_version?: string;
  /**
   * Present only when a baseline masked one or more of this slot's diagnostics:
   * the count of current findings grandfathered by `checkride.baseline.json`.
   * Additive field — absent on runs with no baseline, so `schema_version` holds.
   */
  baselined?: number;
  /**
   * Present only when the check failed with findings a committed baseline
   * doesn't grandfather: how many, every finding of a key it doesn't hold and
   * each one past a key's count. Additive field; `schema_version` holds.
   */
  new_count?: number;
  /**
   * With `new_count`: the keys of those findings, sorted, the first 50 of
   * them. Additive field; `schema_version` holds.
   */
  new?: string[];
  /**
   * Present only when this check ran another copy of its tool than the one
   * the committed baseline records capturing its keys with: that record, the
   * pin source and the version it named. Its new keys may be the tool's churn
   * rather than new debt, and the ratchet held its keys back. Additive field;
   * `schema_version` holds.
   */
  baseline_captured_with?: { pin_source: string; tool_version?: string; toolchain_version?: string };
};

/**
 * A check that ran another copy of its tool than its baseline keys were
 * captured with: what the run's notice names. `ran` is how it ran this time,
 * `newKeys` counts the findings the baseline didn't grandfather, and
 * `heldBack` the grandfathered keys this run didn't see, which the ratchet
 * would have pruned and didn't.
 */
export type Drift = {
  name: string;
  tool: string;
  /** The toolchain the check's pack runs it on, by its executable, which the notice names a `toolchain_version` by. */
  toolchain?: string;
  captured: { pin_source: string; tool_version?: string; toolchain_version?: string };
  ran: { pin_source?: string; tool_version?: string; toolchain_version?: string; toolchain_pinned?: boolean };
  newKeys: number;
  heldBack: number;
};

/**
 * What a run selected (R8.1): `partial`, plus each selection or mode flag the
 * run was given and nothing for one it wasn't. Paths are absolute.
 */
export type SummaryRun = {
  /**
   * True when `--only`, `--skip`, `--changed` or `--static-only` narrowed the
   * run, or `--bail` stopped it at a failure: the test that keeps the run from
   * ratcheting the baseline, so the two always agree.
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

/**
 * One target a multi-target run checked (R8.1): its name, its pack, and its
 * root relative to the repo root, with `.` for the root itself, and
 * `discovered` when `--discover` proposed it rather than the config.
 */
export type SummaryTarget = { name: string; pack: string; root: string; discovered?: true };

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
  /**
   * The targets a multi-target run checked, in config order; absent in
   * implicit mode. A later run reads it to clear the directories of the
   * targets the config dropped. Additive field; `schema_version` holds.
   */
  targets?: SummaryTarget[];
  checks: SummaryCheck[];
};

/**
 * What a {@link CheckRunner} resolves to: the raw outcome, plus `argv` when the
 * runner spawned the check's own tool, the `pin_source` and `tool_version` it
 * resolved through, and the `toolchain_version` it ran on. The summary records
 * those as the check's own. `toolchain_pinned`, with `toolchain_version`, says
 * whether a pin of the repo's chose that release rather than the machine; the
 * summary leaves it out, and `baseline --versions` reads it from the run.
 */
export type RunnerOutcome = CheckOutcome & {
  argv?: string[];
  pin_source?: PinSourceName;
  tool_version?: string;
  toolchain_version?: string;
  toolchain_pinned?: boolean;
};

/** Low-level runner: executes one active check and returns its raw outcome. */
export type CheckRunner = (
  resolved: ResolvedCheck,
  /**
   * `cwd` is the directory the check runs from: its target's root, else the
   * repo root. `base` is the ref a `--changed` run measures from, present
   * exactly when `changed` is. `out` is what `{out}` expands to, the check's
   * own artifact directory: in implicit mode the absolute output directory
   * when `--out` or `CHECKRIDE_OUT` named one, and `.check` when omitted; in
   * multi-target mode the absolute `<out>/<target>` for a target's check, and
   * the absolute output directory for the rest. `pm` is the package manager
   * declared nearest the check's directory. `repo` is the repo root, where a
   * pin search stops, `pins` the check's pin chain and `requirePins` the
   * config's switch; omitted, they read as `cwd`, the `js-lockfile` source
   * alone, and off. `packEnv` holds the variables the check's pack sets over
   * the user's own (R6.4); omitted, it sets none.
   */
  ctx: {
    cwd: string;
    changed: boolean;
    base?: string;
    out?: string;
    pm: PackageManager;
    timeout?: number;
    repo?: string;
    pins?: readonly PinSourceName[];
    requirePins?: boolean;
    packEnv?: Readonly<Record<string, string>>;
    /** The `--pins` file's tools by mise id, each with its version, which the `override` source at the head of `pins` reads (R13.3). */
    overrides?: ReadonlyMap<string, string>;
    /** Under `--static-only`, a tool that would need an install skips its check, rather than fail it (R6.2). */
    staticOnly?: boolean;
  },
) => Promise<RunnerOutcome>;

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
  /**
   * The output directory `--out` or `CHECKRIDE_OUT` named, in place of
   * `<cwd>/.check`; a relative path resolves against `cwd`. The summary, the
   * raw files and the digest land there, and `{out}` expands to it as an
   * absolute path. A directory outside `cwd` makes this a consumer run, which
   * never ratchets the baseline.
   */
  out?: string;
  /**
   * The defaults layer `--defaults` or `CHECKRIDE_DEFAULTS` named (R13.1): the
   * file's absolute `path`, which the summary records as `run.defaults`, and
   * its `config`, as `loadDefaultsFile` read it. Its entries fill only the
   * slots `config` and detection leave empty, and its `timeout` and
   * `requirePins` apply where `config` sets neither. A run with it is a
   * consumer run, which never ratchets the baseline.
   */
  defaults?: { path: string; config: CheckrideConfig };
  /**
   * The `--pins` or `CHECKRIDE_PINS` file (R13.3): its absolute `path`, which
   * the summary records as `run.pins`, and the `tools` it pins, by mise id,
   * each with its version. They form an `override` source at the head of
   * every pin chain, run as `mise exec <id>@<version>`, and record
   * `pin_source: "override"`. A run with it never ratchets the baseline.
   */
  pins?: { path: string; tools: ReadonlyMap<string, string> };
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
 *
 * `name` is the check's name, which keys its baseline entry: the slot itself
 * in implicit mode, `<target>:<slot>` for a target's check. `root` is that
 * target's root, relative to the repo root, which the baseline joins onto each
 * path the tool printed, so the keys stay repo-root-relative.
 */
export type CheckRun = { slot: string; adapter: Adapter; outcome: RunnerOutcome; name: string; root?: string };

export type RunResult = { ok: boolean; summary: Summary; exitCode: number; runs: CheckRun[] };
