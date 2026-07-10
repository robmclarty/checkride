/**
 * Crash-consistent artifact writes.
 *
 * Consumers parse `.check/summary.json` (and the digest, the raw slot files,
 * and the committed baseline) as machine input; a run killed mid-write must
 * never leave them a half-written file to read. Writing to a temp sibling
 * and renaming into place makes each artifact either the previous complete
 * version or the new complete version — `rename(2)` is atomic within a
 * directory — never torn.
 */

import { rename, rm, writeFile } from 'node:fs/promises';

/** Write `data` to `path` atomically: temp sibling first, then rename over. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
