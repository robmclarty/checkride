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

import { open, rename, rm } from 'node:fs/promises';

/**
 * Write `data` to `path` atomically: temp sibling, flushed to disk, then
 * renamed over.
 *
 * The `fsync` before the rename is what makes the promise above true rather
 * than nearly true. `rename(2)` is atomic for the *name*, but a write that is
 * still sitting in the page cache when the machine loses power can leave the
 * renamed inode holding nothing — the reader then finds a file that exists and
 * is empty, which is the torn read this exists to prevent, just relocated.
 *
 * The containing directory is deliberately not synced. Without that, the
 * rename itself may not survive a crash — but the reader then sees the
 * *previous complete version*, which is exactly what is promised. Paying a
 * second fsync per artifact to also guarantee which of the two you get is not
 * worth it for a report that the next run rewrites anyway.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
