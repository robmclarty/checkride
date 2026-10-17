/**
 * Paths in findings, and so in baseline keys, are relative to the repo root
 * (D50, R12.4). A check that runs from a target's root prints its paths
 * relative to that root, so each parser joins the root on before keying:
 * `src/a.ts` from `apps/web` keys as `apps/web/src/a.ts`, and the same file
 * keys the same way whichever directory checked it. A check at the repo root
 * keeps every path as printed, so every implicit-mode key is unchanged. An
 * absolute path, which staticcheck prints for every finding, is made relative
 * to the repo root when the caller names it, as a run, a capture and the
 * digest all do, so a key names its file the same way on every machine.
 */

import { isAbsolute, posix, relative, sep } from 'node:path';

/**
 * Where a check's paths are rebased from: `root`, the directory it ran from
 * relative to the repo root, and `repoRoot`, the repo root's absolute path,
 * when the caller knows it.
 */
export type PathBase = { readonly root: string | undefined; readonly repoRoot?: string | undefined };

/**
 * An absolute `file` relative to `repoRoot`, with forward slashes. A file
 * outside the repo, or with no `repoRoot` to measure from, stays absolute:
 * a `../` path would name a file from a directory nobody ran in.
 */
function repoRelative(file: string, repoRoot: string | undefined): string {
  if (repoRoot === undefined) return file;
  const rel = relative(repoRoot, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return file;
  return rel.split(sep).join('/');
}

/** `file` as a finding names it, from where its check ran (`base`). */
export function rebasePath(base: PathBase, file: string): string {
  if (file === '') return file;
  if (isAbsolute(file)) return repoRelative(file, base.repoRoot);
  if (base.root === undefined || base.root === '.') return file;
  return posix.join(base.root, file);
}
