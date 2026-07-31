/**
 * The shape a harness writer fills in, and the one routine that drives it.
 *
 * Every harness needs the same four writes — merge the hook entries into its
 * config file, then drop the three scripts those entries invoke — and differs
 * only in *where* each lands and *how* its config merges. Keeping that common
 * body here is what makes a new harness a description rather than a copy: a
 * `HarnessSpec` plus a merge function, and nothing else.
 */

import type { HarnessName } from '../gate.js';
import { detectPackageManager, type PackageManager } from '../pm/index.js';
import type { HookFile } from './files.js';
import { putFile, putJson } from './files.js';
import { dirtyScript, gateScript, protectScript } from './scripts.js';

/**
 * Every hook `agent-setup` can write; `--hook <a,b>` selects a subset. It lives
 * here rather than in `./hook.ts` so the per-harness writers can name it without
 * importing the module that imports them.
 */
export const HOOK_NAMES = ['gate', 'dirty', 'protect'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * Where one harness keeps its hooks, and how to merge into its config.
 *
 * `T` is that harness's config shape, so each writer keeps its own types all
 * the way through — `apply` is never handed a config it does not understand.
 */
export type HarnessSpec<T> = {
  name: HarnessName;
  /** The harness's hook config, relative to the repo root. */
  configFile: string;
  /** Where each hook's script lives, relative to the repo root. */
  scripts: Record<HookName, string>;
  /** Merge the named hooks into a parsed config. Must be idempotent. */
  apply: (config: T | undefined, names: readonly string[]) => T;
};

export type WriteOptions = { pm?: PackageManager; dryRun?: boolean; hooks: readonly string[] };

/**
 * Write or refresh `spec`'s hooks in `cwd`: the config entries first, then only
 * the scripts the selected hooks actually invoke. Every write is idempotent, and
 * `dryRun` computes the result without touching the disk.
 */
export async function writeHarnessHooks<T extends object>(
  cwd: string,
  spec: HarnessSpec<T>,
  opts: WriteOptions,
): Promise<HookFile[]> {
  const pm = opts.pm ?? detectPackageManager({ cwd });
  const dryRun = opts.dryRun ?? false;
  const names = opts.hooks;

  const bodies: Record<HookName, () => string> = {
    // The gate guards on the edit marker only when the hook that sets it is
    // written too; alone, the guard would disarm the gate entirely.
    gate: () => gateScript(pm, { harness: spec.name, dirtyGuard: names.includes('dirty') }),
    dirty: dirtyScript,
    protect: () => protectScript(spec.name),
  };

  const config = await putJson<T>(cwd, spec.configFile, (c) => spec.apply(c, names), { dryRun });
  const scripts = await Promise.all(
    HOOK_NAMES.filter((name) => names.includes(name)).map((name) =>
      putFile(cwd, spec.scripts[name], bodies[name](), { dryRun, executable: true }),
    ),
  );
  return [config, ...scripts];
}
