/**
 * Baseline shards: the files a suite's baseline is spread over once a target
 * is local. The root file, `checkride.baseline.json` or a named suite's
 * `checkride.<suite>.baseline.json`, holds the repo-scope checks and every
 * target that isn't local. A local target keeps its own checks' keys in a
 * file of the same name at its root, `web/checkride.baseline.json`, so two
 * changes in two targets edit two files.
 *
 * This file is the map from a check to the file that owns its keys
 * ({@link shardMap}, {@link shardOf}), and the read a run masks with
 * ({@link readShards}): every file as one baseline. The read is wider than
 * the map on purpose, so that making a target local, or turning one back,
 * turns no grandfathered finding red before a writer has moved its keys:
 *
 * - a local target's keys still in the root file are read;
 * - a file left at the root of a declared target that is no longer local is
 *   read, for that target's checks;
 * - and a file at a target's root is read for the checks of the targets at
 *   that root and no others, since that is all it may hold.
 *
 * Each file has its own state. One that can't be parsed masks nothing of its
 * own, and every other file masks as usual.
 *
 * `baseline diff` reads the files a ref committed the same way
 * ({@link readShardsAt}), so a key that moved between files since is no
 * change.
 *
 * A writer goes through the same map ({@link ratchetShards}): each check's
 * keys land in the file that owns them and leave every other file, so a stray
 * key moves home, and a file is written only when what it holds changes. No
 * writer touches a file it couldn't read.
 *
 * A target's root comes from a config, which isn't trusted, so a file at one
 * is read under the containment rule (`../contain.ts`): a link that leads
 * outside the repository is never opened. The root file is read as it always
 * was. Nothing here imports the targets module, which reads baselines itself:
 * the map takes a config's `targets` block as it is composed.
 */

import { rm } from 'node:fs/promises';
import { join, posix } from 'node:path';

import type { Root } from '../contain.js';
import { locatedSync, repoRoot } from '../contain.js';
import { isRecord } from '../json.js';
import type { Tally } from './fingerprint.js';
import type { TreeAtRef } from './history.js';
import { parsedAt, unionBaselines } from './history.js';
import type { Baseline, BaselineRead } from './store.js';
import { BASELINE_SCHEMA_VERSION, baselinesEqual, ratchet, readBaselineFile, readBaselineStatus, writeBaseline } from './store.js';

/** A baseline file at a target's root. */
export type Shard = {
  /** The file, relative to the repo root, with forward slashes: `web/checkride.baseline.json`. */
  file: string;
  /** The declared targets at that root, whose checks are the only ones the file is read for. */
  targets: readonly string[];
  /** The local ones among them, whose checks' keys the file owns. None for a file a target left behind when it stopped being local. */
  local: readonly string[];
};

/** The files of one suite's baseline: the root file, and one at each declared target's root below it, in config order. */
export type ShardMap = { root: string; shards: readonly Shard[] };

/** A target as the map reads it from a config: its name, its root, normalized, and whether it's local. */
type Declared = { name: string; root: string; local: boolean };

/** A root as one path, as the targets module normalizes it: no `./`, no doubled or trailing slash, and `.` for the repo root. */
function normalRoot(root: string): string {
  const normal = posix.normalize(root).replace(/\/+$/, '');
  return normal === '' ? '.' : normal;
}

/** True for a root a file can sit at beside the root file: a directory below the repo root, given relative to it. */
function belowRoot(root: string): boolean {
  return root !== '.' && !posix.isAbsolute(root) && root !== '..' && !root.startsWith('../');
}

/**
 * The targets `targets` declares at a root below the repo's, in its order.
 * An entry no run would accept, with no root or one outside the repo, is left
 * out, since the config's own rules refuse it before any check runs.
 */
function declaredBelow(targets: unknown): Declared[] {
  if (!isRecord(targets)) return [];
  return Object.entries(targets).flatMap(([name, entry]) => {
    if (!isRecord(entry) || typeof entry['root'] !== 'string' || entry['root'] === '') return [];
    const root = normalRoot(entry['root']);
    return belowRoot(root) ? [{ name, root, local: entry['local'] === true }] : [];
  });
}

/**
 * The files the baseline named `baselineFile` at the repo root is spread
 * over, for a config whose composed `targets` block is `targets`: that file,
 * and one of the same name at the root of each declared target below it. A
 * named suite's file is `checkride.<suite>.baseline.json`, so a local
 * target's shard for the suite `evals` is `<root>/checkride.evals.baseline.json`.
 * A config with no target below its root has the root file alone.
 */
export function shardMap(baselineFile: string, targets: unknown): ShardMap {
  const byRoot = new Map<string, Declared[]>();
  for (const target of declaredBelow(targets)) byRoot.set(target.root, [...(byRoot.get(target.root) ?? []), target]);
  const shards = [...byRoot].map(([root, at]) => ({
    file: posix.join(root, baselineFile),
    targets: at.map((t) => t.name),
    local: at.filter((t) => t.local).map((t) => t.name),
  }));
  return { root: baselineFile, shards };
}

/** The target a check named `check` is of, `web` for `web:lint`, or `null` for a repo-scope check or one in a repo without targets. */
function targetOf(check: string): string | null {
  const colon = check.indexOf(':');
  return colon === -1 ? null : check.slice(0, colon);
}

/** True when `shard` may hold `check`: a check of a target at its root. */
function holds(shard: Shard, check: string): boolean {
  const target = targetOf(check);
  return target !== null && shard.targets.includes(target);
}

/**
 * The file that owns `check`'s keys, relative to the repo root: a local
 * target's own file for one of its checks, and the root file for every other
 * check. A writer puts a check's keys here and nowhere else.
 */
export function shardOf(map: ShardMap, check: string): string {
  const target = targetOf(check);
  if (target === null) return map.root;
  return map.shards.find((shard) => shard.local.includes(target))?.file ?? map.root;
}

/**
 * How reading one file went: `absent`, `ok` and `unparseable` as
 * `readBaselineStatus` says them, and `outside` for a file at a target's
 * root that resolves outside the repository, which is never opened.
 */
export type ShardRead = { file: string; baseline: Baseline | null; state: BaselineRead['state'] | 'outside' };

/**
 * Every file of a baseline as a run reads it: `baseline`, what the files
 * grandfather together, or `null` when none of them could be read; `state`,
 * the root file's; `files`, each file's own read, the root file first; and
 * `map`, the map they were read by.
 */
export type ShardsRead = BaselineRead & { map: ShardMap; files: readonly ShardRead[] };

/** The file at a target's root, read where it really is, or not at all when that is outside the repository. */
function readShard(cwd: string, contain: Root, file: string, form: 'current' | 'as-written'): ShardRead {
  const where = locatedSync(contain, join(cwd, file));
  if (where === 'outside') return { file, baseline: null, state: 'outside' };
  if (where === 'missing') return { file, baseline: null, state: 'absent' };
  return { file, ...readBaselineFile(where.inside, form) };
}

/** `baseline` with only the checks `keep` admits: their keys, their capture records and their counts. */
function entriesOf(baseline: Baseline, keep: (check: string) => boolean): Baseline {
  const kept = <T>(entries: Readonly<Record<string, T>> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(entries ?? {}).filter(([check]) => keep(check)));
  const captured = kept(baseline.captured_with);
  const counts = kept(baseline.counts);
  return {
    schema_version: baseline.schema_version,
    slots: kept(baseline.slots),
    ...(Object.keys(captured).length > 0 ? { captured_with: captured } : {}),
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
  };
}

/**
 * What the files grandfather together, or `null` when none was read. Each
 * file gives the checks it may hold, and for a check two files hold, the file
 * that owns it comes first: its capture record stands, a key's count is the
 * one it gives, and a key only the other file holds grandfathers what that
 * file says, or one finding where the owner counts its check and the other
 * doesn't (`unionBaselines`). So a stray key never grandfathers more than the
 * file that owns its check allows.
 */
function together(map: ShardMap, files: readonly ShardRead[]): Baseline | null {
  const owned: Baseline[] = [];
  const stray: Baseline[] = [];
  for (const { file, baseline } of files) {
    if (baseline === null) continue;
    const shard = map.shards.find((s) => s.file === file);
    const read = shard === undefined ? baseline : entriesOf(baseline, (check) => holds(shard, check));
    owned.push(entriesOf(read, (check) => shardOf(map, check) === file));
    stray.push(entriesOf(read, (check) => shardOf(map, check) !== file));
  }
  return owned.length === 0 ? null : unionBaselines([...owned, ...stray]);
}

/**
 * Read every file of `map` from the repo at `cwd`, in the form masking reads,
 * or with each file's keys `as-written`, for a writer that leaves an entry it
 * doesn't touch as the file holds it. A map of the root file alone reads that
 * one file exactly as `readBaselineStatus` does, and so does a repo with no
 * file at any target's root: either way the root file's baseline comes back
 * untouched.
 */
export function readShards(cwd: string, map: ShardMap, form: 'current' | 'as-written' = 'current'): ShardsRead {
  const root = readBaselineStatus(cwd, form, map.root);
  const rootRead: ShardRead = { file: map.root, ...root };
  if (map.shards.length === 0) return { ...root, map, files: [rootRead] };
  const contain = repoRoot(cwd);
  const files = [rootRead, ...map.shards.map((shard) => readShard(cwd, contain, shard.file, form))];
  if (files.every((read) => read === rootRead || read.state === 'absent')) return { ...root, map, files };
  return { baseline: together(map, files), state: root.state, map, files };
}

/**
 * A baseline handed to a run in place of the files, as a read of the root
 * file alone: what a writer then treats as the one file there is.
 */
export function shardsOfOne(file: string, baseline: Baseline | null): ShardsRead {
  const state = baseline === null ? 'absent' : 'ok';
  return { baseline, state, map: { root: file, shards: [] }, files: [{ file, baseline, state }] };
}

/** One file a writer changes: what it holds from now on, or `null` for a file to remove. */
export type ShardChange = { file: string; baseline: Baseline | null };

/** True for a file no writer may touch: one that couldn't be parsed, or that sits outside the repository. */
function unwritable(read: ShardRead): boolean {
  return read.state === 'unparseable' || read.state === 'outside';
}

/**
 * The first file of a baseline spread over more than one that no writer may
 * touch, or `undefined`: a command that would write stops on it. A baseline
 * that is the root file alone has none, since a capture there replaces a
 * mangled file whole, as it always has.
 */
export function unwritableShard(read: ShardsRead): ShardRead | undefined {
  return read.map.shards.length === 0 ? undefined : read.files.find(unwritable);
}

/** True when the file `file` is read for `check`: the root file for any, a file at a target's root for its targets' alone. */
function admits(map: ShardMap, file: string, check: string): boolean {
  const shard = map.shards.find((s) => s.file === file);
  return shard === undefined || holds(shard, check);
}

/** True when `baseline` holds a check at all, even one with no key. */
function holdsAny(baseline: Baseline): boolean {
  return Object.keys(baseline.slots).length > 0;
}

/** `parts`, which hold no check in common, as one baseline of schema version `version`. */
function joined(parts: readonly Baseline[], version: number): Baseline {
  const held = parts.filter((part) => Object.keys(part.slots).length > 0);
  const [only] = held;
  const whole = held.length === 1 && only !== undefined ? only : unionBaselines(held);
  return { ...whole, schema_version: version };
}

/**
 * What one file holds once `next` is spread over the files: the checks it
 * owns, as `next` has them, with what it already held that isn't a writer's
 * to move, which is every entry the read doesn't admit and each stray one
 * whose owner is a file in `frozen`.
 */
function spreadTo(map: ShardMap, read: ShardRead, next: Baseline, frozen: ReadonlySet<string>): Baseline {
  const shard = map.shards.find((s) => s.file === read.file);
  const stays = (check: string): boolean => (shard !== undefined && !holds(shard, check)) || frozen.has(shardOf(map, check));
  const owned = entriesOf(next, (check) => shardOf(map, check) === read.file);
  const kept = read.baseline === null ? [] : [entriesOf(read.baseline, stays)];
  return joined([owned, ...kept], read.baseline?.schema_version ?? BASELINE_SCHEMA_VERSION);
}

/** The change `spread` makes to the file `read` is of, or none: a file left out when it would hold nothing, and removed when a target left it behind and its keys have gone home. */
function changeTo(map: ShardMap, read: ShardRead, spread: Baseline): ShardChange[] {
  const empty = Object.keys(spread.slots).length === 0;
  if (read.baseline === null) return empty ? [] : [{ file: read.file, baseline: spread }];
  if (baselinesEqual(read.baseline, spread)) return [];
  const leftBehind = map.shards.some((s) => s.file === read.file && s.local.length === 0);
  return [{ file: read.file, baseline: leftBehind && empty ? null : spread }];
}

/**
 * The files to change so that each check of `next`, the whole baseline as it
 * should now read, sits in the file that owns it and in no other. A file
 * that already says so is left out, so it stays byte-identical. A file that
 * couldn't be read is never written, and neither is any other file's entry
 * for a check it owns, which stays where it is until the file is repaired.
 * An entry the read doesn't admit is nobody's to move, and stays too.
 */
function spreadOver(read: ShardsRead, next: Baseline): ShardChange[] {
  const frozen = new Set(read.files.filter(unwritable).map((file) => file.file));
  return read.files.flatMap((file) => (frozen.has(file.file) ? [] : changeTo(read.map, file, spreadTo(read.map, file, next, frozen))));
}

/**
 * The ratchet over every file: the files a fully observed run changes, each
 * with what it holds from then on. Each check's keys are pruned to what the
 * run found (`ratchet`) and land in the file that owns them, so a key fixed
 * in `web` rewrites `web`'s file alone, a local target's keys still in the
 * root file move to its own, and a file a target left behind gives its keys
 * to the root file and is removed. Nothing here grows what the files
 * grandfather together.
 */
export function ratchetShards(read: ShardsRead, observed: ReadonlyMap<string, Tally>): ShardChange[] {
  return read.baseline === null ? [] : spreadOver(read, ratchet(read.baseline, observed));
}

/** Make `changes` in the repo at `cwd`: each file written canonical and atomically, as `writeBaseline` writes one, or removed. */
export async function writeShards(cwd: string, changes: readonly ShardChange[]): Promise<void> {
  await Promise.all(changes.map(({ file, baseline }) => (baseline === null ? rm(join(cwd, file), { force: true }) : writeBaseline(cwd, baseline, file))));
}

/**
 * The files a capture of every check writes, for `next`, everything it
 * recorded: each check's entry goes to the file that owns it and leaves
 * every other, both ways at once, so a local target's keys leave the root
 * file and a file a target left behind is removed. The root file is always
 * written, and so is a local target's file that is already there, each
 * replaced whole but for an entry the read doesn't admit; a local target
 * with nothing to hold gets no file. A file no writer may touch is left out
 * ({@link unwritableShard}).
 */
export function captureShards(read: ShardsRead, next: Baseline): ShardChange[] {
  const none = new Set<string>();
  const skipped = unwritableShard(read) === undefined ? [] : read.files.filter(unwritable);
  return read.files.flatMap((file) => {
    if (skipped.includes(file)) return [];
    const spread = { ...spreadTo(read.map, file, next, none), schema_version: BASELINE_SCHEMA_VERSION };
    const owner = file.file === read.map.root || (file.baseline !== null && read.map.shards.some((s) => s.file === file.file && s.local.length > 0));
    return owner ? [{ file: file.file, baseline: spread }] : changeTo(read.map, file, spread);
  });
}

/**
 * The files a narrowed capture writes, for `checks`, the ones it recorded,
 * with their new entries in `from`: the file that owns a check takes its
 * entry, every other file that is read for it drops its own, and every
 * other entry stays as `read` has it, which a caller reads `as-written`. A
 * file that owns a recorded check is always written, and any other only when
 * it loses a stray entry.
 */
export function rehomeShards(read: ShardsRead, from: Baseline, checks: ReadonlySet<string>): ShardChange[] {
  return read.files.flatMap((file) => {
    if (unwritable(file)) return [];
    const taken = (check: string): boolean => checks.has(check) && admits(read.map, file.file, check);
    const owned = entriesOf(from, (check) => checks.has(check) && shardOf(read.map, check) === file.file);
    const rest = file.baseline === null ? [] : [entriesOf(file.baseline, (check) => !taken(check))];
    const next = joined([owned, ...rest], BASELINE_SCHEMA_VERSION);
    return holdsAny(owned) ? [{ file: file.file, baseline: next }] : changeTo(read.map, file, next);
  });
}

/** A file's counts for one check's `keys`, each lowered to the count `lowered` gives it, a count that falls to one left out. */
function loweredTo(own: Readonly<Record<string, number>>, lowered: Readonly<Record<string, number>>, keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const n = Math.min(own[key] ?? 1, lowered[key] ?? 1);
    if (n >= 2) counts[key] = n;
  }
  return counts;
}

/**
 * A file's counts for `check` once it is re-recorded as `next` has it: its
 * own, lowered to `next`'s, or as they are where `next` doesn't count the
 * check, and none for an entry that never was counted.
 */
function countsHere(held: Baseline, next: Baseline, check: string, keys: readonly string[]): Pick<Baseline, 'counts'> {
  const own = held.counts?.[check];
  if (own === undefined) return {};
  const lowered = next.counts?.[check];
  return { counts: { [check]: lowered === undefined ? own : loweredTo(own, lowered, keys) } };
}

/** One check's entry in a file, re-recorded where it is: the keys of it that `next` still holds, each count lowered to `next`'s, and `next`'s capture record. */
function rerecordedHere(held: Baseline, next: Baseline, check: string): Baseline {
  const kept = new Set(next.slots[check] ?? []);
  const keys = (held.slots[check] ?? []).filter((key) => kept.has(key));
  const record = next.captured_with?.[check];
  return {
    schema_version: held.schema_version,
    slots: { [check]: keys },
    ...(record === undefined ? {} : { captured_with: { [check]: record } }),
    ...countsHere(held, next, check, keys),
  };
}

/**
 * The files `baseline --versions` writes: each of `checks`, the ones it
 * re-recorded, takes `next`'s entry in place, in every file that holds it,
 * and no key moves between files. `written` is the files with their keys as
 * written, so every other entry goes back byte for byte, and `current` the
 * same files as masking reads them, which is the form `next`'s keys are in.
 * A file is written only when an entry of its own changes.
 */
export function rerecordShards(written: ShardsRead, current: ShardsRead, next: Baseline, checks: ReadonlySet<string>): ShardChange[] {
  return written.files.flatMap((file, at) => {
    const now = current.files[at]?.baseline ?? null;
    if (file.baseline === null || now === null) return [];
    const here = Object.keys(now.slots).filter((check) => checks.has(check) && admits(written.map, file.file, check));
    if (here.length === 0) return [];
    const rest = entriesOf(file.baseline, (check) => !here.includes(check));
    const whole = joined([...here.map((check) => rerecordedHere(now, next, check)), rest], BASELINE_SCHEMA_VERSION);
    return baselinesEqual(file.baseline, whole) ? [] : [{ file: file.file, baseline: whole }];
  });
}

/** `first` with each file of `second` it lacks: the files either map names, each read by the map that names it first. */
function eitherMap(first: ShardMap, second: ShardMap): ShardMap {
  const named = new Set(first.shards.map((shard) => shard.file));
  return { root: first.root, shards: [...first.shards, ...second.shards.filter((shard) => !named.has(shard.file))] };
}

/**
 * How the caller reads the `targets` a ref's own config declared, given the
 * ref's tree. This module can't read a config itself, so the caller hands
 * the reader in.
 */
export type DeclaredAt = (read: TreeAtRef['read']) => Promise<unknown>;

/** The baseline a ref committed, every file of it as one, with `unread`, why its own config couldn't be read, or `null`. */
export type ShardsAtRef = { sha: string; baseline: Baseline | null; unread: string | null };

/** The first line of what was thrown, as a reason a message can hold. */
function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}

/**
 * The baseline as `tree`, the commit `ref` names, holds it: the root file,
 * and the file at each target's root that either the working tree's map,
 * `working`, or the config the ref itself committed declares, read as one
 * baseline, the way a run reads the working tree's. So a file only the ref's
 * config declares is read, and a key that has moved between files since
 * compares as the same key. `declared` reads the ref's own targets, and is
 * `null` when one config stands for both sides. A ref's config that can't
 * be read declares nothing, and `unread` says why. A file the commit lacks
 * reads as empty, and one that can't be parsed is an error, as the root
 * file's always was.
 */
export async function readShardsAt(tree: TreeAtRef, ref: string, working: ShardMap, declared: DeclaredAt | null): Promise<ShardsAtRef> {
  const root = parsedAt(await tree.read(working.root), working.root, ref);
  let map = working;
  let unread: string | null = null;
  if (declared !== null) {
    try {
      map = eitherMap(shardMap(working.root, await declared(tree.read)), working);
    } catch (error) {
      unread = reasonOf(error);
    }
  }
  const texts = await Promise.all(map.shards.map((shard) => tree.read(shard.file)));
  const files: ShardRead[] = [working.root, ...map.shards.map((shard) => shard.file)].map((file, at) => {
    const baseline = at === 0 ? root : parsedAt(texts[at - 1] ?? null, file, ref);
    return { file, baseline, state: baseline === null ? 'absent' : 'ok' };
  });
  const alone = files.slice(1).every((file) => file.baseline === null);
  return { sha: tree.sha, baseline: alone ? root : together(map, files), unread };
}
