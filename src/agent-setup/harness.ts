/**
 * The shape a harness writer fills in, and the one routine that drives it.
 *
 * Every harness needs the same two writes — merge its hook entries into its
 * config file, then drop whichever scripts those entries invoke — and differs
 * only in *where* each lands, *how* its config merges, and how much of the work
 * its config can do without a script at all. Keeping that common body here is
 * what makes a new harness a description rather than a copy: a `HarnessSpec`
 * plus a merge function, and nothing else.
 */

import { gatePreflight, type HarnessName } from '../gate.js';
import { detectPackageManager, type PackageManager, runScript } from '../pm/index.js';
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
  return `checkride gate — running \`${runScript(pm, 'check')}\``;
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
  /**
   * Where each hook's script lives, relative to the repo root — for the hooks
   * that still need one.
   *
   * A hook is absent here when the harness can express it as *configuration*
   * instead: Claude Code's `protect` is a `permissions.deny` rule and its
   * `dirty` is an inline one-liner, so neither writes a file. Generated code in
   * a consumer's repo is a cost — a file to review, to keep in sync, and to
   * wonder about — and it should be paid only where config cannot do the job.
   */
  scripts: Partial<Record<HookName, string>>;
  /**
   * Scripts an earlier checkride wrote for this harness that this one does not.
   * Deleted whenever their hook is written or removed, so a repo upgrading into
   * the config-only form does not keep a dead file it will never run again.
   */
  retired?: Partial<Record<HookName, string>>;
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
  // Read on every write, which is what makes the preflight the one seam that
  // survives a refresh: `hooks add` rewrites the script and re-points the
  // harness config, and re-derives this from the repo's own config each time.
  const preflight = gatePreflight(cwd);

  const bodies: Record<HookName, () => string> = {
    // The gate guards on the edit marker only when the hook that sets it is
    // written too; alone, the guard would disarm the gate entirely. Removing
    // `dirty` therefore rewrites a surviving gate unguarded, which is why the
    // config merge and the script bodies both read the post-removal selection.
    gate: () =>
      gateScript(pm, {
        harness: spec.name,
        dirtyGuard: names.includes('dirty'),
        ...(preflight === null ? {} : { preflight }),
      }),
    dirty: dirtyScript,
    protect: protectScript,
  };

  const config = await putJson<T>(
    cwd,
    spec.configFile,
    (c) => spec.apply(spec.remove(c, gone), names, pm),
    { dryRun, skipIfMissing: names.length === 0 },
  );
  // A hook this harness expresses as config has no script to write, and may have
  // a retired one to clear away. `touched` is both directions at once, because a
  // dead file is worth deleting whether the hook is arriving or leaving.
  const touched = HOOK_NAMES.filter((name) => names.includes(name) || gone.includes(name));
  const [written, removed, swept] = await Promise.all([
    Promise.all(
      HOOK_NAMES.filter((name) => names.includes(name) && spec.scripts[name] !== undefined).map((name) =>
        putFile(cwd, spec.scripts[name] ?? '', bodies[name](), { dryRun, executable: true }),
      ),
    ),
    Promise.all(
      HOOK_NAMES.filter((name) => gone.includes(name) && spec.scripts[name] !== undefined).map((name) =>
        dropFile(cwd, spec.scripts[name] ?? '', { dryRun }),
      ),
    ),
    Promise.all(
      touched
        .map((name) => spec.retired?.[name])
        .filter((path): path is string => path !== undefined)
        .map((path) => dropFile(cwd, path, { dryRun })),
    ),
  ]);
  // Only report a retired script that was actually there. Every repo set up
  // after these became configuration has none, and listing files that never
  // existed as "absent" would make the common run read like a cleanup.
  return [config, ...written, ...removed, ...swept.filter((f) => f.changed)];
}
