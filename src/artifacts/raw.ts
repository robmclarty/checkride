/**
 * Locating a slot's raw output — the bytes the summary indexes but usually does
 * not name.
 *
 * `output_file` is populated only when a tool emits JSON on stdout, so most
 * slots carry `null` there while their real output sits in `.check/` under the
 * documented convention (`<slot>.json`, else `<slot>.stdout.txt` /
 * `<slot>.stderr.txt`). On a full run of this repo, 8 of 17 checks name no file
 * — `test` among them, the slot most likely to need triage. A reader that
 * reported "no output" for those would be wrong about the one thing it exists
 * to get right, so it owns the convention as a fallback.
 *
 * Everything found is measured, never opened: the readers report *sizes* and
 * point at the file. `mutation.json` in this repo is 2.3 MB; `test.json` is
 * 650 KB beside a 5 KB `test.stdout.txt` saying the same thing, which is why a
 * smaller text sibling wins over a large JSON one.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Freshness } from './freshness.js';
import { classifyFreshness } from './freshness.js';

/** One measured `.check/` file. Size and standing only — never contents. */
export type ArtifactFile = {
  /** Name within `.check/`, as an agent would type it: `lint.json`. */
  file: string;
  /** Absolute path, for a caller that does choose to open it. */
  path: string;
  bytes: number;
  mtimeMs: number;
  freshness: Freshness;
};

/**
 * A slot's raw output: the file worth reading first, plus every other candidate
 * found — so a caller can say what else is there instead of implying the chosen
 * one is all of it.
 */
export type RawOutput = { chosen: ArtifactFile; candidates: ArtifactFile[] };

/** Measure one `.check/` file, or `null` when it does not exist. */
export async function statArtifact(
  checkDir: string,
  file: string,
  windowStart: number | null,
): Promise<ArtifactFile | null> {
  const path = join(checkDir, file);
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    return { file, path, bytes: stats.size, mtimeMs: stats.mtimeMs, freshness: classifyFreshness(stats.mtimeMs, windowStart) };
  } catch {
    return null;
  }
}

/**
 * Measure every file directly in `checkDir`, name-ordered so the render is
 * byte-stable. Subdirectories and anything that vanishes mid-read drop out;
 * an absent directory is `[]`, because "there is nothing there" is an answer.
 *
 * This is the fallback index. Normally the summary names what to look at and
 * {@link resolveRawOutput} locates it, but when the summary cannot be parsed
 * the directory itself is the only inventory that exists — and a reader that
 * gave up there would leave an agent to run `ls` by hand, which is the
 * unbounded read this module exists to prevent.
 */
export async function listArtifacts(checkDir: string, windowStart: number | null): Promise<ArtifactFile[]> {
  let names: string[];
  try {
    names = await readdir(checkDir);
  } catch {
    return [];
  }
  const found = await Promise.all(
    names.toSorted().map((name) => statArtifact(checkDir, name, windowStart)),
  );
  return found.filter((file): file is ArtifactFile => file !== null);
}

/**
 * The convention, in priority order: what the summary named, then the JSON file,
 * then the captured streams. Deduped, because `output_file` is usually
 * `<slot>.json` when it is set at all.
 */
function candidateNames(slot: string, outputFile: string | null): string[] {
  const names = [outputFile, `${slot}.json`, `${slot}.stdout.txt`, `${slot}.stderr.txt`];
  return [...new Set(names.filter((name): name is string => name !== null))];
}

/**
 * Pick what to read first. The convention order wins, except that a *smaller*
 * text sibling beats a large JSON file: `test.stdout.txt` (5 KB) carries the
 * same failure `test.json` (650 KB) does, and a reader that sends an agent to
 * the big one has spent the context it was built to save. A text file that is
 * already first stays first — stdout is the diagnostics, stderr the leftovers.
 */
function chooseRaw(first: ArtifactFile, rest: readonly ArtifactFile[]): ArtifactFile {
  if (first.file.endsWith('.txt')) return first;
  return rest.find((c) => c.file.endsWith('.txt') && c.bytes < first.bytes) ?? first;
}

/**
 * Resolve a slot's raw output under `checkDir`, freshness-gating whatever it
 * finds — a stale candidate is labelled, not dropped. `null` only when the slot
 * genuinely wrote nothing.
 */
export async function resolveRawOutput(
  checkDir: string,
  slot: string,
  outputFile: string | null,
  windowStart: number | null,
): Promise<RawOutput | null> {
  const found = await Promise.all(
    candidateNames(slot, outputFile).map((name) => statArtifact(checkDir, name, windowStart)),
  );
  const [first, ...rest] = found.filter((c): c is ArtifactFile => c !== null);
  if (first === undefined) return null;
  return { chosen: chooseRaw(first, rest), candidates: [first, ...rest] };
}
