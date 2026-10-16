/**
 * The `path` pin source: the copy of a tool a machine's `PATH` holds. It
 * declares nothing, so a chain reaches it only when no source before it
 * declares the tool, and a tool found here runs unpinned (D12).
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** True when `file` is a regular file this process may execute. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The first executable named `bin` in `env.PATH`'s directories, in order, or
 * `null` when none has one. An empty entry is skipped rather than read as the
 * working directory, so a stray `::` in `PATH` can't run a file from the
 * checkout being checked.
 */
export function findOnPath(bin: string, env: Readonly<Record<string, string | undefined>>): string | null {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const file = join(dir, bin);
    if (isExecutable(file)) return file;
  }
  return null;
}
