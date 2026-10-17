/**
 * Paths in findings, and so in baseline keys, are relative to the repo root
 * (D50, R12.4). A check that runs from a target's root prints its paths
 * relative to that root, so each parser joins the root on before keying:
 * `src/a.ts` from `apps/web` keys as `apps/web/src/a.ts`, and the same file
 * keys the same way whichever directory checked it. A check at the repo root
 * keeps every path as printed, so every implicit-mode key is unchanged, and so
 * does an absolute path.
 */

import { isAbsolute, posix } from 'node:path';

/** `file` as the baseline keys it, given `root`, the directory its check ran from relative to the repo root. */
export function rebasePath(root: string | undefined, file: string): string {
  if (root === undefined || root === '.' || file === '' || isAbsolute(file)) return file;
  return posix.join(root, file);
}
