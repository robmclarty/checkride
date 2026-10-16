/**
 * The upward walk every pin source shares: from the directory a check runs in
 * up to the repo root, and no further.
 *
 * A pin outside the repo isn't the repo's. A `mise.toml` in a home directory or
 * a `node_modules` in some parent of the checkout would make a verdict depend
 * on what happens to sit above the clone, so each walk stops at the root.
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * The directories from `cwd` up to `repo`, nearest first, both included. A
 * `cwd` outside `repo` walks nowhere: it's the only directory searched.
 */
export function dirsUpTo(cwd: string, repo: string): string[] {
  const from = resolve(cwd);
  const top = resolve(repo);
  const rel = relative(top, from);
  if (rel.startsWith('..') || isAbsolute(rel)) return [from];
  const dirs = [from];
  let dir = from;
  while (dir !== top) {
    dir = dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}
