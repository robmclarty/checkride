/**
 * A local target: an entry that says `"local": true` and keeps the rest of
 * itself in `<root>/checkride.config.json`, the file a team owns beside its
 * code. The entry holds `root`, `local` and `note`; the file holds the
 * target's `lang`, `checks`, `include`, `exclude`, `timeout` and `extends`,
 * and nothing that belongs to the whole repo.
 *
 * This file is the rules about keys, and the shape the two halves compose
 * into: an ordinary target entry that still says `local: true`. It reads no
 * file. `../config.ts` reads the local file and its presets, and
 * `./resolve.ts` holds a composed entry to every rule a target keeps.
 */

import { posix } from 'node:path';

import { isRecord } from '../json.js';

/** What a local target's entry may hold; the rest lives in its file. */
const LOCAL_ENTRY_KEYS: readonly string[] = ['root', 'local', 'note'];

/** What a local target's file hands its target, `extends` aside, which folds away as the file loads. */
const COMPOSED_KEYS: readonly string[] = ['lang', 'include', 'exclude', 'checks', 'timeout'];

/** Every key a local target's file may hold. */
const LOCAL_FILE_KEYS: readonly string[] = ['$schema', 'note', 'extends', ...COMPOSED_KEYS];

/** The keys of {@link COMPOSED_KEYS}, as a message lists them. */
const HOLDS = 'lang, checks, include, exclude, timeout and extends';

/** True for a target entry that says `"local": true`. */
export function isLocalEntry(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && entry['local'] === true;
}

/** True when `targets` declares a local target. */
export function declaresLocal(targets: unknown): targets is Record<string, unknown> {
  return isRecord(targets) && Object.values(targets).some(isLocalEntry);
}

/** The file of the local target at `root`, relative to the repo root, where `fileName` is the config file's name for the suite. */
export function localFileOf(root: string, fileName: string): string {
  return posix.join(root, fileName);
}

/**
 * Why the entry of local target `name` can't hold what it holds, or `null`:
 * any key beside `root`, `local` and `note` belongs in `file`, since a key in
 * two places has no ranking.
 */
export function localEntryProblem(name: string, entry: Record<string, unknown>, file: string): string | null {
  const extra = Object.keys(entry).find((key) => !LOCAL_ENTRY_KEYS.includes(key));
  if (extra === undefined) return null;
  return `targets.${name} sets ${extra} beside local: true, and a local target's entry holds only ${LOCAL_ENTRY_KEYS.join(', ')}: move ${extra} to ${file}`;
}

/**
 * Why local file `file` can't hold a key it writes itself, or `null`:
 * `repoKeys` are the keys of a repo's own config, and each one a local file
 * doesn't take belongs to the whole repo. A key no config reads is left for a
 * warning ({@link unreadKeys}).
 */
export function localFileProblem(own: Record<string, unknown>, file: string, repoKeys: ReadonlySet<string>): string | null {
  const refused = Object.keys(own).find((key) => repoKeys.has(key) && !LOCAL_FILE_KEYS.includes(key));
  if (refused === undefined) return null;
  return `${file} sets ${refused}, which belongs to the whole repo: a local target's file holds ${HOLDS}, so set ${refused} in the repo's own config`;
}

/** The top-level keys of `parsed`, one file's own, that a local target's file doesn't read. */
function unreadKeys(parsed: Record<string, unknown>): string[] {
  return Object.keys(parsed).filter((key) => !LOCAL_FILE_KEYS.includes(key));
}

/** The entries of `parsed`'s `checks` for a repo-scope slot (`repoSlots`), which no target's checks can hold. */
function unreadChecks(parsed: Record<string, unknown>, repoSlots: ReadonlySet<string>): string[] {
  const checks = parsed['checks'];
  return isRecord(checks) ? Object.keys(checks).filter((key) => repoSlots.has(key)) : [];
}

/**
 * One warning for each part of `parsed`, a file named `label`, that the local
 * file `file` doesn't read: a top-level key outside the ones it holds, and,
 * in a preset the local file extends, a `checks` entry for a repo-scope
 * slot, since a preset is written for a root config. The local file's own
 * entry for such a slot is a config error, which the target's rules raise.
 */
export function unreadWarnings(parsed: Record<string, unknown>, label: string, file: string, repoSlots: ReadonlySet<string>): string[] {
  const subject = label === file ? "a local target's file" : `${file}, a local target's file,`;
  return [
    ...unreadKeys(parsed).map((key) => `checkride: ${label} has a top-level key ${JSON.stringify(key)}, which ${subject} doesn't read (it reads ${HOLDS})`),
    ...(label === file ? [] : unreadChecks(parsed, repoSlots)).map((key) => `checkride: ${label} configures ${key}, a repo-scope slot, which ${subject} doesn't read (configure it in the repo's top-level checks)`),
  ];
}

/**
 * `base`, a preset a local file extends, with only what a local file may
 * hold: its other top-level keys dropped, and each `checks` entry for a
 * repo-scope slot with them.
 */
export function heldByLocal(base: Record<string, unknown>, repoSlots: ReadonlySet<string>): Record<string, unknown> {
  const held = Object.fromEntries(Object.entries(base).filter(([key]) => LOCAL_FILE_KEYS.includes(key)));
  const checks = held['checks'];
  if (!isRecord(checks)) return held;
  return { ...held, checks: Object.fromEntries(Object.entries(checks).filter(([key]) => !repoSlots.has(key))) };
}

/**
 * A local target as a run reads it: its entry's `root`, `local` and `note`,
 * with the `lang`, `include`, `exclude`, `checks` and `timeout` its file
 * holds. `file` is the local file's content, presets folded in.
 */
export function composedEntry(entry: Record<string, unknown>, file: Record<string, unknown>): Record<string, unknown> {
  const held = Object.fromEntries(COMPOSED_KEYS.flatMap((key) => (file[key] === undefined ? [] : [[key, file[key]]])));
  const note = entry['note'] ?? file['note'];
  return { ...held, root: entry['root'], local: true, ...(note === undefined ? {} : { note }) };
}
