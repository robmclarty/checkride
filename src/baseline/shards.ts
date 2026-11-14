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
import { unionBaselines } from './history.js';
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
function readShard(cwd: string, contain: Root, file: string): ShardRead {
  const where = locatedSync(contain, join(cwd, file));
  if (where === 'outside') return { file, baseline: null, state: 'outside' };
  if (where === 'missing') return { file, baseline: null, state: 'absent' };
  return { file, ...readBaselineFile(where.inside) };
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
 * Read every file of `map` from the repo at `cwd`, in the form masking reads.
 * A map of the root file alone reads that one file exactly as
 * `readBaselineStatus` does, and so does a repo with no file at any target's
 * root: either way the root file's baseline comes back untouched.
 */
export function readShards(cwd: string, map: ShardMap): ShardsRead {
  const root = readBaselineStatus(cwd, 'current', map.root);
  const rootRead: ShardRead = { file: map.root, ...root };
  if (map.shards.length === 0) return { ...root, map, files: [rootRead] };
  const contain = repoRoot(cwd);
  const files = [rootRead, ...map.shards.map((shard) => readShard(cwd, contain, shard.file))];
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
