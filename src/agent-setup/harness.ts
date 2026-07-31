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
import { dropFile, putFile, putJson } from './files.js';
import { dirtyScript, gateScript, protectScript } from './scripts.js';

/**
 * Every hook `agent-setup` can write; `--hook <a,b>` selects a subset. It lives
 * here rather than in `./hook.ts` so the per-harness writers can name it without
 * importing the module that imports them.
 */
export const HOOK_NAMES = ['gate', 'dirty', 'protect'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * Ceiling for the gate run, in seconds, for any harness whose config carries
 * one. Generous on purpose: it exists to break a hang, not to police a slow
 * repo, and checkride's own per-check timeouts fire long before it does.
 *
 * Both harnesses default lower than a real pipeline takes — Cursor's default is
 * short, and Claude Code's is 600s — and both read a timed-out stop hook as a
 * *broken* one, which under Claude Code means the turn simply ends. A gate that
 * quietly stops gating on the slowest repos is the vacuous green the contract
 * exists to prevent, so neither default is left in place.
 */
export const GATE_TIMEOUT_SECONDS = 900;

/**
 * The spinner text a harness shows while the gate runs.
 *
 * Without it the only feedback during a full pipeline run is the harness's
 * default spinner, which is indistinguishable from a hung model — the user is
 * left guessing whether anything is happening at all. Naming the command that
 * is actually running answers that in the one place they are already looking.
 */
export function gateStatusMessage(pm: PackageManager): string {
  return `checkride gate — running \`${pm} check\``;
}

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
  /**
   * Merge the named hooks into a parsed config. Must be idempotent. `pm` is the
   * repo's package manager, which a harness that renders the gate's command in
   * its own UI (Claude Code's `statusMessage`) needs in the config, not just in
   * the script.
   */
  apply: (config: T | undefined, names: readonly string[], pm: PackageManager) => T;
  /** Strip the named hooks from a parsed config. Must be idempotent. */
  remove: (config: T | undefined, names: readonly string[]) => T;
};

export type WriteOptions = {
  pm?: PackageManager;
  dryRun?: boolean;
  hooks: readonly string[];
  /**
   * Hooks to tear out: their config entries are stripped and their scripts
   * deleted. Removal wins over `hooks`, so a name in both is removed — the
   * caller-facing flags (`--hook`/`--remove-hook`) reject that combination
   * before it gets here, and this is the safe reading if one ever slips through.
   */
  remove?: readonly string[];
};

/**
 * Write or refresh `spec`'s hooks in `cwd` and tear out the ones marked for
 * removal: the config entries first, then only the scripts the selected hooks
 * actually invoke. Every write is idempotent, and `dryRun` computes the result
 * without touching the disk.
 *
 * A run that only removes never *creates* the harness's config file — a repo
 * that was never wired for this harness has nothing to un-wire.
 */
export async function writeHarnessHooks<T extends object>(
  cwd: string,
  spec: HarnessSpec<T>,
  opts: WriteOptions,
): Promise<HookFile[]> {
  const pm = opts.pm ?? detectPackageManager({ cwd });
  const dryRun = opts.dryRun ?? false;
  const gone = opts.remove ?? [];
  const names = opts.hooks.filter((name) => !gone.includes(name));

  const bodies: Record<HookName, () => string> = {
    // The gate guards on the edit marker only when the hook that sets it is
    // written too; alone, the guard would disarm the gate entirely. Removing
    // `dirty` therefore rewrites a surviving gate unguarded, which is why the
    // config merge and the script bodies both read the post-removal selection.
    gate: () => gateScript(pm, { harness: spec.name, dirtyGuard: names.includes('dirty') }),
    dirty: dirtyScript,
    protect: () => protectScript(spec.name),
  };

  const config = await putJson<T>(
    cwd,
    spec.configFile,
    (c) => spec.apply(spec.remove(c, gone), names, pm),
    { dryRun, skipIfMissing: names.length === 0 },
  );
  const scripts = await Promise.all([
    ...HOOK_NAMES.filter((name) => names.includes(name)).map((name) =>
      putFile(cwd, spec.scripts[name], bodies[name](), { dryRun, executable: true }),
    ),
    ...HOOK_NAMES.filter((name) => gone.includes(name)).map((name) =>
      dropFile(cwd, spec.scripts[name], { dryRun }),
    ),
  ]);
  return [config, ...scripts];
}
