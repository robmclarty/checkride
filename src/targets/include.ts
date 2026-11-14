/**
 * Included config files: a config may list `"include": ["services"]`, and
 * `services/checkride.config.json` then declares targets of its own, with
 * roots relative to itself. An included file may include others. Target
 * names stay one flat set across every file, so `--only api`, `api:lint` in
 * the summary and `.check/api/` mean what they always have: the hierarchy is
 * in where the files sit, never in the names.
 *
 * This file is the rules about what an `include` list and an included file
 * hold, and how an included file's targets join the repo's. It reads no
 * file: `../config.ts` reads each one, under the containment rule, and
 * `./resolve.ts` holds the joined targets to every rule a target keeps.
 */

import { posix } from 'node:path';

import { isRecord } from '../json.js';

/** What an included file may hold: the targets it declares and the files it includes in turn. */
const INCLUDED_KEYS: readonly string[] = ['$schema', 'note', 'targets', 'include'];

/** True for a path that leaves the directory it is relative to, or is relative to none: absolute in any system's spelling, or through `..`. */
function leaves(path: string): boolean {
  return posix.isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith('\\') || path.split(/[/\\]/).includes('..');
}

/**
 * Why `include`, as the file named `file` wrote it, isn't a list of
 * directories, or `null`: each entry is a directory relative to the file that
 * lists it, never absolute and never through `..`.
 */
export function includeListProblem(include: unknown, file: string): string | null {
  const where = `include (in ${file})`;
  if (!Array.isArray(include)) return `${where} must be an array of directories, each holding a config file to include (got ${JSON.stringify(include)})`;
  for (const entry of include) {
    if (typeof entry !== 'string' || entry === '') return `${where} holds ${JSON.stringify(entry)}, which isn't a directory's path`;
    if (leaves(entry)) return `${where} holds ${JSON.stringify(entry)}, which leaves the directory of the file that lists it: give a directory below it`;
  }
  return null;
}

/** The directory an `include` entry of the file in `dir` names, relative to the repo root, with `.` for the root itself. */
export function includedDir(dir: string, entry: string): string {
  const joined = posix.normalize(posix.join(dir, entry)).replace(/\/+$/, '');
  return joined === '' ? '.' : joined;
}

/**
 * Why included file `file` can't hold what it holds, or `null`: it holds
 * `targets`, `include`, `note` and `$schema`, and every other key belongs to
 * the repo's own config.
 */
export function includedFileProblem(parsed: Record<string, unknown>, file: string): string | null {
  const extra = Object.keys(parsed).find((key) => !INCLUDED_KEYS.includes(key));
  if (extra !== undefined) {
    return `${file} sets ${extra}, which an included file can't hold: it holds targets, include, note and $schema, and ${extra} belongs to the repo's own config`;
  }
  const targets = parsed['targets'];
  if (targets !== undefined && !isRecord(targets)) return `targets must be an object of named targets (got ${JSON.stringify(targets)}) (in ${file})`;
  if (targets === undefined && parsed['include'] === undefined) return `${file} is included, and declares no targets and includes no file that could`;
  return null;
}

/**
 * The targets one file declares: the file, relative to the repo root, the
 * directory it sits in, and its `targets` as written. `by` is the file that
 * includes it, absent on the repo's own config.
 */
export type DeclaringFile = { file: string; dir: string; targets: Record<string, unknown>; by?: string };

/** Every file's targets as one flat set, with the file that declared each. */
export type Joined = { targets: Record<string, unknown>; declaredIn: Map<string, string> };

/**
 * Why a target of an included file can't have its root made relative to the
 * repo root, or `null`: the root leaves the file's own directory. An entry
 * with no usable root is left for the target rules to name.
 */
function rootLeaves(name: string, entry: unknown, from: DeclaringFile): string | null {
  if (!isRecord(entry) || typeof entry['root'] !== 'string' || !leaves(entry['root'])) return null;
  return `targets.${name}.root ${JSON.stringify(entry['root'])} leaves the directory of the file that declares it: give a directory relative to ${from.file} (in ${from.file})`;
}

/** One target of the file `from` with its root made relative to the repo root; the repo's own, and an entry with no root to move, as written. */
function rebased(entry: unknown, from: DeclaringFile): unknown {
  if (from.dir === '.' || !isRecord(entry) || typeof entry['root'] !== 'string' || entry['root'] === '') return entry;
  return { ...entry, root: includedDir(from.dir, entry['root']) };
}

/**
 * The targets of every file in `files`, the repo's own first, as one flat
 * set, each included file's roots made relative to the repo root; or the
 * first problem: a name two files declare, naming both, or a root that
 * leaves its file's directory.
 */
export function joinedTargets(files: readonly DeclaringFile[]): Joined | string {
  const targets: Record<string, unknown> = {};
  const declaredIn = new Map<string, string>();
  for (const from of files) {
    for (const [name, entry] of Object.entries(from.targets)) {
      const first = declaredIn.get(name);
      if (first !== undefined) return `target '${name}' is declared twice, in ${first} and in ${from.file}: target names are one flat set across every included file`;
      const problem = from.dir === '.' ? null : rootLeaves(name, entry, from);
      if (problem !== null) return problem;
      targets[name] = rebased(entry, from);
      declaredIn.set(name, from.file);
    }
  }
  return { targets, declaredIn };
}
