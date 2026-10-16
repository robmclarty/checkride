/**
 * The target directories in the output directory. In multi-target mode a
 * target's checks write under `<out>/<target>/`, so a target the config later
 * drops leaves a directory that no run refreshes again, and a reader could
 * take its stale reports for current ones. Each run deletes those, and only
 * those (R9): the directories its predecessor's summary listed as targets that
 * the config no longer declares. checkride never deletes a directory it didn't
 * write, so `--out` can point into a folder that holds other things.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { asRecordArray, asStringOrNull } from './json.js';
import { isInside } from './out.js';
import { readSummary } from './summary.js';

/**
 * A name a summary may list as a target, as V1 has every target name be: one
 * lowercase word, so a hand-edited summary can't aim a deletion at `..`, a
 * dot-directory or anything deeper than one level down.
 */
const TARGET_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A target a previous summary listed: its name, and its root when it gave one. */
type Listed = { name: string; root: string | null };

/** The targets the summary in `out` lists, or none when there's no summary there that checkride wrote. */
async function listedTargets(out: string): Promise<Listed[]> {
  const read = await readSummary(out);
  if (read.state !== 'ok') return [];
  return asRecordArray(read.summary.targets).flatMap((t) => {
    const name = asStringOrNull(t['name']);
    return name !== null && TARGET_NAME.test(name) ? [{ name, root: asStringOrNull(t['root']) }] : [];
  });
}

/**
 * True when `dir`, a dropped target's directory, is one to delete: a real
 * directory, not a link, that holds neither the repo `repo` nor the target's own
 * root. An output directory pointed at the repo itself would otherwise put a
 * target's artifacts in its source tree, and a later prune would take the
 * source with them.
 */
async function prunable(dir: string, repo: string, root: string | null): Promise<boolean> {
  const stats = await lstat(dir).catch(() => null);
  if (stats === null || !stats.isDirectory()) return false;
  if (isInside(dir, repo)) return false;
  return root === null || !isInside(dir, join(repo, root));
}

/**
 * Delete each target directory in `out` that the summary there listed and
 * `kept`, the targets the config declares now, leaves out. `repo` is the repo
 * the run checks. A run in implicit mode keeps none, so converting a repo back
 * from targets clears what its targets left.
 */
export async function pruneDroppedTargets(out: string, repo: string, kept: readonly string[]): Promise<void> {
  const dropped = (await listedTargets(out)).filter((t) => !kept.includes(t.name));
  await Promise.all(
    dropped.map(async (t) => {
      const dir = join(out, t.name);
      if (await prunable(dir, repo, t.root)) await rm(dir, { recursive: true, force: true });
    }),
  );
}
