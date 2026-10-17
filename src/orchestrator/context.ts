/**
 * Option resolution: the defaults every command entry point shares
 * (`runChecks`/`runFix`/`runDoctor`), and the fuller run context `runChecks`
 * builds on top of them — runner, flags, package manager, baseline, pool width.
 */

import { resolve } from 'node:path';

import type { Adapter, Slot } from '../adapters.js';
import { ADAPTERS, SLOTS } from '../adapters.js';
import { CHECK_DIR, outDir, outLabel } from '../artifacts/index.js';
import type { Baseline, BaselineRead } from '../baseline/index.js';
import { readBaselineStatus } from '../baseline/index.js';
import type { CheckrideConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { ChangedBase } from '../git.js';
import type { PackageManager } from '../launch/index.js';
import { detectPackageManager, nearestPackageManager } from '../launch/index.js';
import type { Target } from '../targets/index.js';
import { configuredTargets } from '../targets/index.js';
import { defaultConcurrency, defaultRunner } from './spawn.js';
import type { CheckRunner, Out, RunOptions } from './types.js';

/** Options shared by every command entry point (`runChecks`/`runFix`/`runDoctor`). */
type CommonOptions = {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stdout?: Out;
  stderr?: Out;
};

/** The resolved form of {@link CommonOptions}: defaults applied, config loaded. */
type CommonContext = {
  cwd: string;
  slots: readonly Slot[];
  adapters: readonly Adapter[];
  config: CheckrideConfig | null;
  stdout: Out;
  stderr: Out;
};

/**
 * Apply the defaults every command shares: cwd, the slot/adapter catalogues, the
 * config (loaded from `cwd` unless injected), and the two streams, so
 * `runChecks`/`runFix`/`runDoctor` resolve this identical block one way.
 */
export function resolveCommonOptions(options: CommonOptions): CommonContext {
  const cwd = options.cwd ?? process.cwd();
  return {
    cwd,
    slots: options.slots ?? SLOTS,
    adapters: options.adapters ?? ADAPTERS,
    config: options.config !== undefined ? options.config : loadConfig(cwd),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
}

/** The resolved run environment: {@link CommonContext} plus the run-only options. */
export type RunContext = CommonContext & {
  /** The absolute output directory the run writes its artifacts into: `--out`'s, else `<cwd>/.check`. */
  out: string;
  /** How the run's own lines name {@link out} (see `outLabel`): `.check` by default. */
  outLabel: string;
  /**
   * What `{out}` in an adapter's args expands to in implicit mode: the
   * relative `.check` by default, so 0.13's argv holds, and the absolute
   * {@link out} when a flag or variable named it. Multi-target mode expands it
   * per check (see `placeOf`).
   */
  outArg: string;
  /** The targets the config declares, in config order, or `null` in implicit mode. */
  targets: readonly Target[] | null;
  /** The defaults layer's config (`--defaults`, R13.1), or `null` when the run names none. */
  defaults: CheckrideConfig | null;
  /** True when `--discover` proposed {@link targets} rather than the config declaring them. */
  discovered: boolean;
  /** The `--pins` file's tools by mise id, with their versions, or `null` without one: an `override` source heads every chain (R13.3). */
  overrides: ReadonlyMap<string, string> | null;
  runner: CheckRunner;
  json: boolean;
  bail: boolean;
  changed: boolean;
  /**
   * The base a `--changed` run measures from, and `{base}` expands to; `null`
   * off `--changed`. A placeholder here like `nameWidth`: resolving it asks
   * git, so `runChecks` fills it in once the selection is validated.
   */
  changedBase: ChangedBase | null;
  timeout: number | undefined;
  /** The package manager the repo root declares, or the one the caller named. */
  pm: PackageManager;
  /**
   * The package manager a check running from `dir` uses: the nearest one
   * declared from `dir` up to the repo root, so a target with its own lockfile
   * runs under it, or the caller's for every check when it named one.
   */
  pmAt: (dir: string) => PackageManager;
  /**
   * The config's `requirePins`, else the defaults layer's: a tool that
   * resolves from `PATH` with no pin fails its check.
   */
  requirePins: boolean;
  baseline: Baseline | null;
  /**
   * Why `baseline` is null when it is: `absent` is a repo without one,
   * `unparseable` is a mangled committed file — the run warns on the latter.
   */
  baselineState: BaselineRead['state'];
  /** Effective wave pool width (see {@link defaultConcurrency}); unused under `bail`. */
  concurrency: number;
  /** Slot-name column width for this run's status lines (see `nameWidth` in `report.ts`). */
  nameWidth: number;
};

/**
 * The baseline a run masks with: the option override, or the committed file.
 * An injected baseline bypasses the file, so its state carries no file
 * diagnosis — it is classified by presence alone.
 */
function resolveBaselineRead(options: RunOptions, cwd: string): BaselineRead {
  if (options.baseline !== undefined) {
    return { baseline: options.baseline, state: options.baseline === null ? 'absent' : 'ok' };
  }
  return readBaselineStatus(cwd);
}

/**
 * How a run finds a check's package manager: the caller's for every check when
 * it named one, else the nearest declaration from the check's directory up to
 * `repo`, read once per directory.
 */
export function packageManagerAt(named: PackageManager | undefined, repo: string): (dir: string) => PackageManager {
  if (named !== undefined) return () => named;
  const seen = new Map<string, PackageManager>();
  return (dir) => {
    const known = seen.get(dir);
    if (known !== undefined) return known;
    const pm = nearestPackageManager(dir, repo);
    seen.set(dir, pm);
    return pm;
  };
}

/** Where a run writes its artifacts, how its lines name that directory, and what `{out}` expands to. */
function outputOf(options: RunOptions, cwd: string): Pick<RunContext, 'out' | 'outLabel' | 'outArg'> {
  const named = options.out === undefined ? null : resolve(cwd, options.out);
  const out = named ?? outDir(cwd);
  return { out, outLabel: outLabel(cwd, out), outArg: named ?? CHECK_DIR };
}

/**
 * The defaults layer, and the two top-level keys a run reads from the repo's
 * config or, where it sets neither, from the defaults layer's (R13.1).
 */
function layeredKeys(config: CheckrideConfig | null, options: RunOptions): Pick<RunContext, 'defaults' | 'timeout' | 'requirePins'> {
  const defaults = options.defaults?.config ?? null;
  return {
    defaults,
    timeout: config?.timeout ?? defaults?.timeout,
    requirePins: (config?.requirePins ?? defaults?.requirePins) === true,
  };
}

/** The run's flags, each with its default applied. */
function flagsOf(options: RunOptions): Pick<RunContext, 'runner' | 'json' | 'bail' | 'changed' | 'concurrency'> {
  return {
    runner: options.runner ?? defaultRunner,
    json: options.json ?? false,
    bail: options.bail ?? false,
    changed: options.changed ?? false,
    concurrency: Math.max(1, Math.floor(options.concurrency ?? defaultConcurrency())),
  };
}

/**
 * Apply every run default: the common options plus the output directory (and
 * how to name and pass it), runner, flags, PM, and baseline. `nameWidth` is a
 * placeholder here — the selection it measures is not known until after
 * `selectChecks`, so `runChecks` narrows it then — and so is `changedBase`,
 * which `runChecks` resolves through git.
 */
export function resolveRunContext(options: RunOptions): RunContext {
  const common = resolveCommonOptions(options);
  const read = resolveBaselineRead(options, common.cwd);
  return {
    ...common,
    ...outputOf(options, common.cwd),
    ...layeredKeys(common.config, options),
    ...flagsOf(options),
    targets: configuredTargets(common.config),
    discovered: false,
    overrides: options.pins?.tools ?? null,
    nameWidth: 8,
    changedBase: null,
    pm: options.pm ?? detectPackageManager({ cwd: common.cwd }),
    pmAt: packageManagerAt(options.pm, common.cwd),
    baseline: read.baseline,
    baselineState: read.state,
  };
}
