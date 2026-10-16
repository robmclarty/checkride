/**
 * Where one check runs, and where what it writes lands (D48). In implicit mode
 * every check runs from the repo root and writes into the output directory,
 * with `{out}` as the run context says: `.check` by default. In multi-target
 * mode a target's check runs from its target root and writes into
 * `<out>/<target>/`, with `{out}` that absolute directory, so two targets' tools
 * never write one report over the other, and a check of the repo as a whole
 * writes into `<out>` with `{out}` absolute too. Scratch follows the working
 * directory, so a built-in's generated files sit at `<target root>/.check/`,
 * where they resolve the target's own modules, and so does the package
 * manager, the nearest one declared from the working directory up.
 */

import { join } from 'node:path';

import type { ResolvedCheck } from '../config.js';
import type { PackageManager } from '../launch/index.js';
import type { RunContext } from './context.js';

/** Where one check runs and writes. */
export type Place = {
  /** The absolute directory the check runs from. */
  cwd: string;
  /** The absolute directory its artifacts land in. */
  dir: string;
  /** What `{out}` in its args expands to. */
  outArg: string;
  /** Where {@link dir} sits in the output directory, as its `output_file` names it: `''`, or `<target>/`. */
  prefix: string;
  /** The package manager the check runs its tools under. */
  pm: PackageManager;
};

/** The absolute directory a check runs from: its target's root under `repo`, else `repo` itself. */
export function checkCwd(repo: string, r: ResolvedCheck): string {
  return r.root === undefined ? repo : join(repo, r.root);
}

/** Where `r` runs and writes in a run with context `ctx`. */
export function placeOf(r: ResolvedCheck, ctx: Pick<RunContext, 'cwd' | 'out' | 'outArg' | 'targets' | 'pmAt'>): Place {
  if (ctx.targets === null) return { cwd: ctx.cwd, dir: ctx.out, outArg: ctx.outArg, prefix: '', pm: ctx.pmAt(ctx.cwd) };
  if (r.target === undefined) return { cwd: ctx.cwd, dir: ctx.out, outArg: ctx.out, prefix: '', pm: ctx.pmAt(ctx.cwd) };
  const dir = join(ctx.out, r.target);
  const cwd = checkCwd(ctx.cwd, r);
  return { cwd, dir, outArg: dir, prefix: `${r.target}/`, pm: ctx.pmAt(cwd) };
}
