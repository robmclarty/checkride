/**
 * Toolchain markers (R11.3): the files that mark a directory as holding one
 * language's code, and the repo files `unclaimed` and discovery read them
 * from. Both skip the same directories, and both name a target after its
 * directory the same way.
 *
 * A pack's markers come from `PACKS`, `package.json` and `tsconfig.json` for
 * ts, and a marker is a file name or a glob over one, as terraform's `*.tf`
 * is.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { GitRunner } from '../git.js';
import { PACKS } from '../packs/index.js';
import { globRegExp, listFiles } from './files.js';

/**
 * Directories no marker is read from, at any depth: installed dependencies,
 * build output, virtual environments, checkride's own artifacts and test
 * data, none of which a target is meant to check.
 */
const NEVER_READ: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'target', '.venv', '.terraform', '.check', 'testdata']);

/** The longest target name V1 allows. */
export const NAME_LENGTH = 32;

/** The markers, compiled: the kind a file's name marks, by pattern, from every pack's own. */
const MARKERS: readonly { kind: string; pattern: RegExp }[] = Object.values(PACKS).flatMap((pack) =>
  pack.markers.map((marker) => ({ kind: pack.name, pattern: globRegExp(marker) })),
);

/** True when `marker` is a glob over a file name, such as `*.tf`, rather than a name. */
function isGlob(marker: string): boolean {
  return /[*?[{]/.test(marker);
}

/**
 * Whether a marker sits in `dir` itself: a file of that name, or, for a glob,
 * a file whose name it matches, which is how a root holding only `main.tf`
 * is a Terraform root (R2.1). The directory is listed once, on the first glob
 * asked about, and an unreadable one holds no file.
 */
export function markerAt(dir: string): (marker: string) => boolean {
  let names: readonly string[] | undefined;
  return (marker) => {
    if (!isGlob(marker)) return existsSync(join(dir, marker));
    names ??= filesIn(dir);
    const pattern = globRegExp(marker);
    return names.some((name) => pattern.test(name));
  };
}

/** The names of the files directly in `dir`, or none when it can't be read. */
function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The pack whose markers `path`'s file name matches, or `null`. */
export function markerKind(path: string): string | null {
  const name = posix.basename(path);
  return MARKERS.find((m) => m.pattern.test(name))?.kind ?? null;
}

/** True when `path` sits under a directory no marker is read from, or under `test/fixtures/`. */
function underSkipped(path: string): boolean {
  const dirs = path.split('/').slice(0, -1);
  return dirs.some((dir, i) => NEVER_READ.has(dir) || (dir === 'test' && dirs[i + 1] === 'fixtures'));
}

/**
 * The repo's files, as R11.2 lists them at its root, sorted, less the ones
 * under a directory no marker is read from. Throws when git fails other than
 * by being absent.
 */
export async function repoFiles(repo: string, git: GitRunner): Promise<string[]> {
  return (await listFiles(repo, '.', git, 'the repo')).filter((path) => !underSkipped(path)).toSorted();
}

/** True when `dir` is `root` or lies below it. Every directory lies under `.`. */
export function isWithin(dir: string, root: string): boolean {
  return root === '.' || dir === root || dir.startsWith(`${root}/`);
}

/** `dir`'s last segment as a target name (V1), or `''` when nothing of it survives. */
export function slugName(dir: string): string {
  const base = posix.basename(dir).toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '');
  return base.slice(0, NAME_LENGTH).replace(/-+$/, '');
}

/** `base-2`, `base-3` and so on, the first `taken` lacks. */
export function numbered(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n += 1) {
    const name = `${base.slice(0, NAME_LENGTH - String(n).length - 1)}-${n}`;
    if (!taken.has(name)) return name;
  }
}
