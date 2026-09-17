/**
 * Option resolution: the defaults every command entry point shares
 * (`runChecks`/`runFix`/`runDoctor`), and the fuller run context `runChecks`
 * builds on top of them — runner, flags, package manager, baseline, pool width.
 */

import type { Adapter, Slot } from '../adapters.js';
import { ADAPTERS, SLOTS } from '../adapters.js';
import type { Baseline, BaselineRead } from '../baseline/index.js';
import { readBaselineStatus } from '../baseline/index.js';
import type { CheckrideConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { PackageManager } from '../pm/index.js';
import { detectPackageManager } from '../pm/index.js';
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
  runner: CheckRunner;
  json: boolean;
  bail: boolean;
  changed: boolean;
  timeout: number | undefined;
  pm: PackageManager;
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
 * Apply every run default: the common options plus runner, flags, PM, and
 * baseline. `nameWidth` is a placeholder here — the selection it measures is
 * not known until after `selectChecks`, so `runChecks` narrows it then.
 */
export function resolveRunContext(options: RunOptions): RunContext {
  const common = resolveCommonOptions(options);
  const read = resolveBaselineRead(options, common.cwd);
  return {
    ...common,
    nameWidth: 8,
    runner: options.runner ?? defaultRunner,
    json: options.json ?? false,
    bail: options.bail ?? false,
    changed: options.changed ?? false,
    timeout: common.config?.timeout,
    pm: options.pm ?? detectPackageManager({ cwd: common.cwd }),
    baseline: read.baseline,
    baselineState: read.state,
    concurrency: Math.max(1, Math.floor(options.concurrency ?? defaultConcurrency())),
  };
}
