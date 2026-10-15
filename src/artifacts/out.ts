/**
 * The output directory: where a run writes its artifacts, and where every
 * reader looks for them. It is `<cwd>/.check` unless `--out` or
 * `CHECKRIDE_OUT` names another ({@link namedOut}). The engine, the digest,
 * both bundled-plugin readers and `doctor` take the directory from here and
 * name it in text through {@link outLabel}, so none of them spells `.check`
 * itself (the `no-check-dir-literal` rule holds that), and a line that points
 * at an artifact points where the run actually wrote it.
 *
 * Scratch is not output. `snippets` and `smoke` generate files that have to
 * resolve the repo's own modules from where they sit, so they write under
 * `<cwd>/.check/` whatever the output directory is ({@link prepareScratch}),
 * and so does the gate's dirty marker.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { constants, realpathSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The gitignored directory a run writes its artifacts into by default, relative to where it runs. */
export const CHECK_DIR = '.check';

/** The aggregate report, beside the raw artifacts in the output directory. */
export const SUMMARY_FILE = 'summary.json';

/** The variable that names the output directory when `--out` doesn't. */
export const OUT_ENV = 'CHECKRIDE_OUT';

/** The default output directory of a run rooted at `cwd`, absolute. */
export function outDir(cwd: string): string {
  return join(cwd, CHECK_DIR);
}

/**
 * The output directory a command was pointed at: `--out`, else
 * `CHECKRIDE_OUT` (an empty variable counts as unset), resolved against `cwd`.
 * `null` when neither names one, so the command uses {@link outDir}. A flag
 * passed with no directory is a usage error, never the default.
 */
export function namedOut(cwd: string, flag: string | undefined, env: Readonly<Record<string, string | undefined>>): string | null {
  if (flag === '') throw new Error('--out was passed with no directory');
  const variable = env[OUT_ENV];
  const named = flag ?? (variable === '' ? undefined : variable);
  return named === undefined ? null : resolve(cwd, named);
}

/**
 * The real path of `path`. A path that doesn't exist yet keeps its missing
 * tail on the real path of its nearest existing ancestor, so an output
 * directory a run is about to create still compares correctly.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realPath(parent), basename(absolute));
  }
}

/** `path` relative to `root` when it sits inside it, else `null`. */
function insideRelative(root: string, path: string): string | null {
  const rel = relative(realPath(root), realPath(path));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
}

/**
 * True when `path` sits inside `root`. Real paths are compared, so a symlinked
 * prefix (macOS's `/var` is `/private/var`) can't put a file on the wrong side.
 */
export function isInside(root: string, path: string): boolean {
  return insideRelative(root, path) !== null;
}

/**
 * How text names the output directory `dir` of a run in `cwd`: relative to
 * `cwd` when it sits inside it, so `.check` by default, and absolute when it
 * sits outside. Every `report:` line, digest pointer and reader row joins a
 * file name onto this.
 */
export function outLabel(cwd: string, dir: string): string {
  const rel = insideRelative(cwd, dir);
  if (rel === null) return resolve(dir);
  return rel === '' ? '.' : rel;
}

/** Where a built-in run from `root` writes its generated files, whatever the output directory is. */
export function scratchDir(root: string): string {
  return join(root, CHECK_DIR);
}

/**
 * Make the scratch directory under `root` ready to write, or say why it can't
 * be: the `reason` a built-in that needs scratch records when it skips, as it
 * does in a read-only checkout that a run pointed `--out` away from. `null`
 * when the directory exists and is writable.
 */
export async function prepareScratch(root: string): Promise<string | null> {
  const dir = scratchDir(root);
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return null;
  } catch {
    return `needs a writable ./${CHECK_DIR} for scratch files`;
  }
}
