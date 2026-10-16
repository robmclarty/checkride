/**
 * The target directories in the output directory. In multi-target mode a
 * target's checks write under `<out>/<target>/`, so a target the config later
 * drops leaves files that no run refreshes again, and a reader could take its
 * stale reports for current ones. Each run clears them (R9): for each target
 * its predecessor's summary listed and the config no longer declares, the
 * files that summary's checks of the target name, then the directory once
 * nothing else is in it. checkride never deletes what it didn't write, so
 * `--out` can point into a folder that holds other things, a folder that
 * shares a target's name included (D57).
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { lstat, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonRecord } from './json.js';
import { asRecordArray, asStringOrNull } from './json.js';
import { isInside } from './out.js';
import { readSummary } from './summary.js';

/**
 * A name a summary may list as a target, as V1 has every target name be: one
 * lowercase word, so a hand-edited summary can't aim a deletion at `..`, a
 * dot-directory or anything deeper than one level down.
 */
const TARGET_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A target a previous summary listed: its name, its root when it gave one, and the files its checks wrote. */
type Listed = { name: string; root: string | null; files: readonly string[] };

/** True for a name that stays inside the directory it's joined onto: one entry, not `.` or `..`. */
function isEntryName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

/**
 * The files one check of target `target` wrote in its directory, as the
 * summary records it: the captured streams and the JSON its slot's name gives
 * by convention, and the `output_file` it named under `<target>/`.
 */
function checkFiles(check: JsonRecord, target: string): string[] {
  const slot = asStringOrNull(check['slot']);
  const output = asStringOrNull(check['output_file']);
  const prefix = `${target}/`;
  const names = [
    ...(slot === null ? [] : [`${slot}.stdout.txt`, `${slot}.stderr.txt`, `${slot}.json`]),
    ...(output?.startsWith(prefix) ? [output.slice(prefix.length)] : []),
  ];
  return names.filter(isEntryName);
}

/** The targets the summary in `out` lists, or none when there's no summary there that checkride wrote. */
async function listedTargets(out: string): Promise<Listed[]> {
  const read = await readSummary(out);
  if (read.state !== 'ok') return [];
  const checks = asRecordArray(read.summary.checks);
  return asRecordArray(read.summary.targets).flatMap((t) => {
    const name = asStringOrNull(t['name']);
    if (name === null || !TARGET_NAME.test(name)) return [];
    const files = checks.filter((c) => c['target'] === name).flatMap((c) => checkFiles(c, name));
    return [{ name, root: asStringOrNull(t['root']), files: [...new Set(files)] }];
  });
}

/**
 * True when `dir`, a dropped target's directory, is one to clear: a real
 * directory, not a link, that holds neither the repo `repo` nor the target's own
 * root. An output directory pointed at the repo itself would otherwise put a
 * target's artifacts in its source tree, and a later prune would reach into it.
 */
async function prunable(dir: string, repo: string, root: string | null): Promise<boolean> {
  const stats = await lstat(dir).catch(() => null);
  if (stats === null || !stats.isDirectory()) return false;
  if (isInside(dir, repo)) return false;
  return root === null || !isInside(dir, join(repo, root));
}

/** Unlink `path`, a file or a link; a directory, or one already gone, stays as it is. */
async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Absent, a directory, or not removable: nothing checkride wrote is lost by leaving it.
  }
}

/** Remove `dir` when it's empty; one that still holds anything belongs to someone else, and stays. */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch {
    // Not empty: what's left isn't checkride's to take.
  }
}

/**
 * Clear, for each target the summary in `out` listed and `kept` (the targets
 * the config declares now) leaves out, the files its checks wrote there, then
 * its directory once nothing else is in it. `repo` is the repo the run checks.
 * A run in implicit mode keeps none, so converting a repo back from targets
 * clears what its targets left.
 */
export async function pruneDroppedTargets(out: string, repo: string, kept: readonly string[]): Promise<void> {
  const dropped = (await listedTargets(out)).filter((t) => !kept.includes(t.name));
  await Promise.all(
    dropped.map(async (t) => {
      const dir = join(out, t.name);
      if (!(await prunable(dir, repo, t.root))) return;
      await Promise.all(t.files.map((file) => removeFile(join(dir, file))));
      await removeIfEmpty(dir);
    }),
  );
}
