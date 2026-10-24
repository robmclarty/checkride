/**
 * The baseline artifact: its on-disk shape and the pure read / write / apply /
 * ratchet operations a baseline-aware run is built from.
 *
 * This file imports nothing from the orchestrator on purpose: the `baseline`
 * command (`../baseline-command.ts`) bridges to the run pipeline, but a *run* only needs to
 * mask and ratchet an already-captured baseline, so the orchestrator can depend
 * on these helpers without a load-order cycle. Keeping the file I/O and the
 * set algebra here (not in the orchestrator) also preserves the orchestrator's
 * "never parse diagnostics" thesis — fingerprinting stays inside this module.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic.js';
import { currentKey } from '../findings/index.js';
import { isRecord } from '../json.js';
import type { Tally } from './fingerprint.js';

/** The committed baseline artifact, at repo root beside `checkride.config.json`. */
export const BASELINE_FILE = 'checkride.baseline.json';

/** Schema version of the baseline file; independent of the summary schema. */
export const BASELINE_SCHEMA_VERSION = 1;

/**
 * How a check's keys were captured: the pin source its tool resolved through,
 * the version that source named, a file's or the one mise resolved, when it
 * named one, and the release of the toolchain the tool ran on, for a pack
 * that names one. A string rather than a pin source name, so a file a newer
 * checkride wrote reads whole.
 */
export type Captured = { pin_source: string; tool_version?: string; toolchain_version?: string };

/** Shape of `checkride.baseline.json`: per-slot sets of grandfathered keys. */
export type Baseline = {
  schema_version: number;
  slots: Record<string, string[]>;
  /**
   * How `checkride baseline` captured each check's keys, for a check whose
   * tool resolved through a pin source. A tool upgrade re-keys findings, so a
   * run with another copy than the one recorded here is held back from the
   * ratchet ({@link baselineDrift}). Absent when no check recorded one.
   */
  captured_with?: Record<string, Captured>;
  /**
   * How many findings each key grandfathers, for a check whose keys were
   * counted: check name to each key found more than once, with how many times.
   * A key a counted check's entry doesn't name grandfathers one finding. A
   * check this doesn't name was captured before counts, and each of its keys
   * grandfathers any number, as every key did before. Absent when no check is
   * counted.
   */
  counts?: Record<string, Record<string, number>>;
};

/**
 * One check's entry as masking reads it: its keys, and, for a counted check,
 * how many findings each grandfathers ({@link Baseline}'s `counts`).
 */
export type BaselineEntry = { keys: readonly string[]; counts?: Readonly<Record<string, number>> };

/** The entry `baseline` holds for `check`: no keys for a check it doesn't name. */
export function entryFor(baseline: Baseline, check: string): BaselineEntry {
  const counts = baseline.counts?.[check];
  return { keys: baseline.slots[check] ?? [], ...(counts !== undefined ? { counts } : {}) };
}

/**
 * How a check's tool ran this time, as its summary entry records it: any
 * field absent for a check that recorded none. `toolchain_pinned` is the
 * run's alone, never recorded: with `toolchain_version`, whether a pin of the
 * repo's chose that release rather than the machine.
 */
export type RanWith = { pin_source?: string; tool_version?: string; toolchain_version?: string; toolchain_pinned?: boolean };

/** A key the baseline holds that this run found more often than it grandfathers. */
export type Excess = { key: string; found: number; allowed: number };

/** The result of masking one slot's current tally with its baseline. */
export type BaselineAdjustment = {
  /** Grandfathered-adjusted pass: the failure is fully explained by known debt. */
  ok: boolean;
  /** How many current findings the baseline suppressed (the `baselined` count). */
  baselined: number;
  /** Sorted keys present now that the baseline does NOT hold. */
  newKeys: string[];
  /** Sorted by key: the keys it holds that were found more often than it grandfathers. */
  excess: Excess[];
  /** How many current findings the baseline didn't grandfather: every finding of a new key, and each one past a key's count. */
  newFindings: number;
};

/**
 * Parse baseline file content; `null` when unusable. The baseline is a
 * committed file a run reads on every invocation, so a malformed one is coerced
 * into a clean shape (or dropped) rather than thrown — a corrupt baseline must
 * never break `checkride`. Takes raw text rather than a path so historical
 * copies (a `git show` blob during recovery) parse under the same tolerance.
 *
 * Content from a *newer* schema is dropped rather than read optimistically. The
 * fields it does not have yet are the ones that would say which findings are
 * masked and why, so guessing means either masking findings it never
 * grandfathered or claiming ones it did. Dropping it fails closed: the run
 * reports the diagnostics that are actually there — more red than the author
 * intended, never a green that was not earned. Same direction as
 * {@link applyBaseline}'s refusal to mask an unparseable run.
 *
 * A key an earlier release wrote for a finding this one keys differently
 * reads as the key it takes now ({@link withCurrentKeys}), so a baseline
 * captured before an upgrade grandfathers the same findings after it.
 */
export function parseBaseline(raw: string): Baseline | null {
  const asWritten = parseAsWritten(raw);
  return asWritten === null ? null : withCurrentKeys(asWritten);
}

/** {@link parseBaseline}, every key left in the form the file holds it in, an earlier release's included. */
function parseAsWritten(raw: string): Baseline | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed['slots'])) return null;
    const version = parsed['schema_version'];
    if (typeof version === 'number' && version > BASELINE_SCHEMA_VERSION) return null;
    const slots: Record<string, string[]> = {};
    for (const [slot, keys] of Object.entries(parsed['slots'])) {
      if (Array.isArray(keys)) slots[slot] = keys.filter((k): k is string => typeof k === 'string');
    }
    return {
      schema_version: typeof version === 'number' ? version : BASELINE_SCHEMA_VERSION,
      slots,
      ...withCaptured(parseCaptured(parsed['captured_with'], slots)),
      ...withCounts(parseCounts(parsed['counts'], slots)),
    };
  } catch {
    return null;
  }
}

/**
 * `baseline` with each key in the form this release writes it (`currentKey`
 * in `../findings`): through 0.18 a fallow `<component>` roll-up, say, keyed
 * with its position, which an edit above it moved. The ratchet, `recover` and
 * `baseline diff` all read through here, so none of them sees the old form.
 * Two old keys that read as one new key in a counted check grandfather as
 * many findings together as they did apart. A baseline with no old key is
 * returned as it is.
 */
function withCurrentKeys(baseline: Baseline): Baseline {
  if (!Object.values(baseline.slots).some((keys) => keys.some((key) => currentKey(key) !== key))) return baseline;
  const slots: Record<string, string[]> = {};
  const counts: Record<string, Record<string, number>> = {};
  for (const [check, keys] of Object.entries(baseline.slots)) {
    slots[check] = [...new Set(keys.map(currentKey))];
    const own = baseline.counts?.[check];
    if (own !== undefined) counts[check] = summedCounts(keys, own);
  }
  return { schema_version: baseline.schema_version, slots, ...withCaptured(baseline.captured_with), ...withCounts(counts) };
}

/** A counted check's counts once each key reads as its current key: the findings a key's old forms grandfathered, added up. */
function summedCounts(keys: readonly string[], counts: Readonly<Record<string, number>>): Record<string, number> {
  const summed = new Map<string, number>();
  for (const key of new Set(keys)) summed.set(currentKey(key), (summed.get(currentKey(key)) ?? 0) + (counts[key] ?? 1));
  return Object.fromEntries([...summed].filter(([, n]) => n >= 2));
}

/**
 * The `captured_with` a parsed file holds, read as tolerantly as its slots:
 * an entry that isn't an object with a `pin_source` string is dropped, a
 * `tool_version` or `toolchain_version` that isn't a string is dropped from
 * its entry, and an entry for a check `slots` doesn't hold is dropped, since
 * it records nothing.
 */
function parseCaptured(raw: unknown, slots: Readonly<Record<string, string[]>>): Record<string, Captured> {
  const captured: Record<string, Captured> = {};
  if (!isRecord(raw)) return captured;
  for (const [check, entry] of Object.entries(raw)) {
    const read = readCaptured(entry);
    if (read !== null && Object.hasOwn(slots, check)) captured[check] = read;
  }
  return captured;
}

/**
 * The `counts` a parsed file holds, read so a malformed one fails closed: a
 * check `slots` doesn't hold is dropped, since it counts nothing, a check
 * entry that isn't an object still marks its check counted, every key at one,
 * and so does a `counts` that isn't an object, for every check. Only a file
 * with no `counts` at all was captured before counts, and grandfathers any
 * number of findings under a key.
 */
function parseCounts(raw: unknown, slots: Readonly<Record<string, string[]>>): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  if (raw === undefined) return counts;
  if (!isRecord(raw)) return Object.fromEntries(Object.keys(slots).map((check) => [check, {}]));
  for (const [check, entry] of Object.entries(raw)) {
    const keys = slots[check];
    if (keys !== undefined) counts[check] = readCounts(entry, keys);
  }
  return counts;
}

/** One check's counts: each key its entry holds, with a whole count of two or more; anything else counts once. */
function readCounts(entry: unknown, keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!isRecord(entry)) return counts;
  const held = new Set(keys);
  for (const [key, n] of Object.entries(entry)) {
    if (held.has(key) && typeof n === 'number' && Number.isInteger(n) && n >= 2) counts[key] = n;
  }
  return counts;
}

/** `counts` as a baseline spreads it: present only when it names a check. */
function withCounts(counts: Readonly<Record<string, Record<string, number>>> | undefined): Pick<Baseline, 'counts'> {
  return counts !== undefined && Object.keys(counts).length > 0 ? { counts: { ...counts } } : {};
}

/** One `captured_with` entry, or `null` when it names no pin source. */
function readCaptured(entry: unknown): Captured | null {
  if (!isRecord(entry) || typeof entry['pin_source'] !== 'string' || entry['pin_source'] === '') return null;
  return capturedAs(entry['pin_source'], optionalString(entry['tool_version']), optionalString(entry['toolchain_version']));
}

/** An optional field of a `captured_with` entry as it reads: a string that isn't empty, else nothing. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A record with its fields in the one order the file writes them:
 * `pin_source`, then `tool_version` and `toolchain_version` when there are.
 */
function capturedAs(pinSource: string, toolVersion: string | undefined, toolchainVersion: string | undefined): Captured {
  return {
    pin_source: pinSource,
    ...(toolVersion !== undefined ? { tool_version: toolVersion } : {}),
    ...(toolchainVersion !== undefined ? { toolchain_version: toolchainVersion } : {}),
  };
}

/**
 * The record a capture writes for a check that ran as `ran`, as its summary
 * entry records it: its pin source and the versions it named, in the file's
 * order, or `undefined` for a check whose tool resolved through no pin source.
 */
export function capturedRecord(ran: RanWith): Captured | undefined {
  return ran.pin_source === undefined ? undefined : capturedAs(ran.pin_source, ran.tool_version, ran.toolchain_version);
}

/** `captured_with` as a baseline spreads it: present only when it records a check. */
function withCaptured(captured: Readonly<Record<string, Captured>> | undefined): Pick<Baseline, 'captured_with'> {
  return captured !== undefined && Object.keys(captured).length > 0 ? { captured_with: { ...captured } } : {};
}

/** How reading `checkride.baseline.json` went — see {@link readBaselineStatus}. */
export type BaselineRead = {
  baseline: Baseline | null;
  state: 'absent' | 'ok' | 'unparseable';
};

/**
 * Read the baseline and say *why* it is missing when it is. Absent and
 * unparseable both mask nothing, but they mean different things to the person
 * staring at the resulting red: absent is a repo that never adopted a baseline,
 * unparseable is a file somebody (often a merge) mangled — the run warns about
 * the second so the damage is diagnosed at the moment it bites, not archaeology
 * later.
 *
 * `form` is `'current'` for the keys as this release writes them, the form
 * masking and every comparison read, and `'as-written'` for the keys as the
 * file holds them: what a writer that leaves a check's entry alone, a
 * narrowed capture or `baseline --versions`, writes back for that check.
 */
export function readBaselineStatus(cwd: string, form: 'current' | 'as-written' = 'current'): BaselineRead {
  const path = join(cwd, BASELINE_FILE);
  if (!existsSync(path)) return { baseline: null, state: 'absent' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { baseline: null, state: 'unparseable' };
  }
  const baseline = form === 'current' ? parseBaseline(raw) : parseAsWritten(raw);
  return baseline === null ? { baseline: null, state: 'unparseable' } : { baseline, state: 'ok' };
}

/** Read `checkride.baseline.json` from `cwd`; `null` when absent or unusable. */
export function loadBaseline(cwd: string): Baseline | null {
  return readBaselineStatus(cwd).baseline;
}

/**
 * Serialize and write the baseline to `cwd` (canonical, pretty-printed,
 * trailing newline, atomic). Written canonical — sorted slots, sorted unique
 * keys — so the committed file diffs deterministically: two branches that
 * grandfather the same debt produce byte-identical files instead of a spurious
 * merge conflict over insertion order, and a merge that doubled a line is
 * written back as the set it always was. The shape is a promised surface — see
 * `docs/contract.md` §`checkride.baseline.json`.
 */
export async function writeBaseline(cwd: string, baseline: Baseline): Promise<void> {
  await writeFileAtomic(join(cwd, BASELINE_FILE), `${JSON.stringify(canonicalize(baseline), null, 2)}\n`);
}

/**
 * Mask one slot's current tally with its entry. Each key grandfathers as many
 * of its findings as the entry allows ({@link allowanceOf}): `newKeys` are the
 * current keys the entry doesn't hold, `excess` the ones it holds that were
 * found more often than it allows, and `baselined` counts the findings it
 * grandfathered.
 *
 * The failure flips to a pass *only* when there are current findings and none
 * of them are new — a tool that produced no parseable diagnostics (a crash, empty
 * output that fingerprints to the empty set) is never masked, so a genuine
 * breakage still fails even while a baseline is active. Correctness beats
 * precision: better to re-surface a masked finding than to silently green a crash.
 */
export function applyBaseline(current: Tally, entry: BaselineEntry, rawOk: boolean): BaselineAdjustment {
  const allowed = allowanceOf(entry);
  const newKeys: string[] = [];
  const excess: Excess[] = [];
  let baselined = 0;
  let newFindings = 0;
  for (const [key, found] of current) {
    const allows = allowed(key);
    baselined += Math.min(found, allows);
    newFindings += Math.max(found - allows, 0);
    if (allows === 0) newKeys.push(key);
    else if (found > allows) excess.push({ key, found, allowed: allows });
  }
  const ok = rawOk || (current.size > 0 && newFindings === 0);
  return { ok, baselined, newKeys: newKeys.toSorted(), excess: excess.toSorted((a, b) => (a.key < b.key ? -1 : 1)), newFindings };
}

/**
 * How many findings of a key an entry grandfathers: none of a key it doesn't
 * hold, the count a counted check records, one when it records none, and any
 * number for a check captured before counts.
 */
function allowanceOf(entry: BaselineEntry): (key: string) => number {
  const held = new Set(entry.keys);
  const { counts } = entry;
  return (key) => {
    if (!held.has(key)) return 0;
    return counts === undefined ? Number.POSITIVE_INFINITY : (counts[key] ?? 1);
  };
}

/**
 * Ratchet the baseline against a fully observed run: for every slot observed this
 * run, keep only the grandfathered keys still present (a fixed diagnostic is
 * dropped); a slot absent from `observed` — disabled, without an extractor, not
 * run, or run without reaching a verdict (`observedTally`) — is preserved
 * untouched. The result never grows: genuinely new findings
 * are the run's failures, not new debt, so only a `checkride baseline` capture
 * ever adds keys. Callers gate this on a full run (no `--only`/`--skip`/
 * `--changed`, no early `--bail` break) so a partial run can't prune keys it
 * simply didn't observe.
 */
export function ratchet(baseline: Baseline, observed: ReadonlyMap<string, Tally>): Baseline {
  const slots: Record<string, string[]> = {};
  for (const [slot, keys] of Object.entries(baseline.slots)) {
    const current = observed.get(slot);
    slots[slot] = current === undefined ? keys : keys.filter((k) => current.has(k)).toSorted();
  }
  // How each check was captured outlives its keys: only `checkride baseline` writes it.
  return { schema_version: baseline.schema_version, slots, ...withCaptured(baseline.captured_with), ...withCounts(ratchetedCounts(baseline.counts, observed)) };
}

/**
 * A counted check's counts after a run that observed it: each lowered to how
 * many findings of its key the run found. A count only falls, and a check
 * captured before counts stays uncounted: only `checkride baseline` counts one.
 */
function ratchetedCounts(counts: Baseline['counts'], observed: ReadonlyMap<string, Tally>): Record<string, Record<string, number>> | undefined {
  if (counts === undefined) return undefined;
  const ratcheted: Record<string, Record<string, number>> = {};
  for (const [check, entry] of Object.entries(counts)) {
    const current = observed.get(check);
    ratcheted[check] = current === undefined ? entry : lowerCounts(entry, current);
  }
  return ratcheted;
}

/** `entry`'s counts lowered to what `current` found, a count that falls to one or none left out. */
function lowerCounts(entry: Readonly<Record<string, number>>, current: Tally): Record<string, number> {
  const lowered: Record<string, number> = {};
  for (const [key, n] of Object.entries(entry)) {
    const kept = Math.min(n, current.get(key) ?? 0);
    if (kept >= 2) lowered[key] = kept;
  }
  return lowered;
}

/**
 * `baseline` with each entry `renames` names moved to its new name, keys
 * untouched: what `target add` does when a repo's implicit target takes a
 * name, and `lint` becomes `app:lint`. An entry already under a new name keeps
 * its keys, with the moved ones added, and its own capture record.
 */
export function renameBaselineSlots(baseline: Baseline, renames: ReadonlyMap<string, string>): Baseline {
  const slots: Record<string, string[]> = {};
  for (const [name, keys] of Object.entries(baseline.slots)) {
    const to = renames.get(name) ?? name;
    slots[to] = [...(slots[to] ?? []), ...keys];
  }
  return {
    schema_version: baseline.schema_version,
    slots,
    ...withCaptured(renamedCaptured(baseline.captured_with, renames)),
    ...withCounts(renamedCounts(baseline, renames)),
  };
}

/**
 * `baseline`'s counts with each entry moved as {@link renameBaselineSlots}
 * moves the keys. Two entries that land under one name stay counted only
 * when every one holding a key was, the larger count winning, and otherwise
 * the merged check is uncounted, so a key never grandfathers fewer findings
 * than it did.
 */
function renamedCounts(baseline: Baseline, renames: ReadonlyMap<string, string>): Record<string, Record<string, number>> {
  const merged = new Map<string, Record<string, number> | null>();
  for (const [name, keys] of Object.entries(baseline.slots)) {
    const to = renames.get(name) ?? name;
    if (keys.length > 0) merged.set(to, mergedCounts(merged.get(to), baseline.counts?.[name]));
  }
  const counts: Record<string, Record<string, number>> = {};
  for (const [name, entry] of merged) if (entry !== null) counts[name] = entry;
  return counts;
}

/** One more entry's counts, `own`, folded into those already merged under its new name: uncounted, `null`, once either side is. */
function mergedCounts(so: Record<string, number> | null | undefined, own: Readonly<Record<string, number>> | undefined): Record<string, number> | null {
  if (so === null || own === undefined) return null;
  return largerCounts(so ?? {}, own);
}

/** Two checks' counts as one, each key's larger count winning. */
function largerCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const larger: Record<string, number> = { ...a };
  for (const [key, n] of Object.entries(b)) larger[key] = Math.max(larger[key] ?? 0, n);
  return larger;
}

/** `captured` with each entry moved as {@link renameBaselineSlots} moves the keys; a check already under the new name keeps its own. */
function renamedCaptured(captured: Readonly<Record<string, Captured>> | undefined, renames: ReadonlyMap<string, string>): Record<string, Captured> {
  const own = captured ?? {};
  const moved: Record<string, Captured> = {};
  for (const [name, entry] of Object.entries(own)) {
    const to = renames.get(name) ?? name;
    if (to === name || !Object.hasOwn(own, to)) moved[to] ??= entry;
  }
  return moved;
}

/**
 * Whether a check ran another copy of its tool than the one its keys were
 * captured with, so its keys may have churned. A toolchain on another minor
 * release is another copy ({@link toolchainMoved}). Past that, where both
 * sides name a version, a different version is another copy, whatever source
 * named it. Where either names none, a different pin source is, such as a
 * capture from `PATH` and a run in a Nix dev shell. So a record from before
 * mise reported the version it resolved, which names none, never drifts from
 * a run through mise.
 */
export function baselineDrift(captured: Captured, ran: RanWith): boolean {
  if (toolchainMoved(captured, ran)) return true;
  if (captured.tool_version !== undefined && ran.tool_version !== undefined) return captured.tool_version !== ran.tool_version;
  return captured.pin_source !== ran.pin_source;
}

/**
 * Whether both sides name the toolchain's release and they're on different
 * minor lines: Go 1.25.3 and 1.26.0 are, and 1.25.3 and 1.25.5 aren't, since
 * a Go patch release fixes bugs and a minor one changes the type checker,
 * gofmt and what the standard library deprecates. A record or run that names
 * no toolchain release never moves it.
 */
function toolchainMoved(captured: Captured, ran: RanWith): boolean {
  if (captured.toolchain_version === undefined || ran.toolchain_version === undefined) return false;
  return minorLine(captured.toolchain_version) !== minorLine(ran.toolchain_version);
}

/** A release's `major.minor`, `1.25` for `1.25.3` or `1.25rc1`, or the whole string when it has none. */
function minorLine(version: string): string {
  return /^\d+\.\d+/.exec(version)?.[0] ?? version;
}

/**
 * A copy of a tool as a drift notice names it: its version and pin source, or
 * where it came from when that names no version, then the toolchain release it
 * ran on, by `toolchain`'s name, when it records one: `2.11.4 (nix) on go
 * 1.25.3`.
 */
export function copyNamed(copy: RanWith, toolchain?: string): string {
  const named = toolCopyNamed(copy);
  return copy.toolchain_version === undefined ? named : `${named} on ${toolchain ?? 'its toolchain'} ${copy.toolchain_version}`;
}

/** The tool's half of {@link copyNamed}: its version and pin source, or where it came from. */
function toolCopyNamed(copy: RanWith): string {
  if (copy.tool_version !== undefined) return `${copy.tool_version} (${copy.pin_source ?? 'no pin source'})`;
  if (copy.pin_source === 'path') return 'from PATH';
  return copy.pin_source === undefined ? 'with no pin source' : `through ${copy.pin_source}`;
}

/**
 * What a `baseline --versions` run saw of one check: the keys it reported, or
 * `null` when it ran without reaching a verdict, and how its tool ran, as its
 * summary entry records it.
 */
export type Observation = { keys: Tally | null; ran: RanWith };

/**
 * What `baseline --versions` did with one check the committed baseline holds:
 * re-recorded it, with the record it had, the one it took and how many keys
 * it pruned; found nothing to change; or left it as it was, and why: it didn't
 * run, it ran without reaching a verdict, it reported keys the entry lacks, or
 * it ran a copy no pin of the repo's chose.
 */
export type Rerecord =
  | { check: string; outcome: 'rerecorded'; from?: Captured; to: Captured; pruned: number }
  | { check: string; outcome: 'unchanged' }
  | { check: string; outcome: 'not-run' }
  | { check: string; outcome: 'no-verdict' }
  | { check: string; outcome: 'new-keys'; newKeys: number; ran: RanWith }
  | { check: string; outcome: 'unpinned'; ran: RanWith };

/** One check's step: what was done with it, and the entry it takes when it's re-recorded. */
type RerecordStep = { result: Rerecord; entry?: { keys: string[]; counts?: Record<string, number>; record: Captured } };

/** A check's entry as the committed baseline holds it: its keys and their counts, and how they were captured. */
type HeldEntry = BaselineEntry & { record: Captured | undefined };

/**
 * The committed baseline with each check's capture record moved to the copy
 * that ran, and the keys that copy no longer reports pruned, where that can't
 * change a verdict, with what was done to each check (`checkride baseline
 * --versions`). A check is re-recorded only when it ran to a verdict, every
 * key it reported is already in its entry, and a pin of the repo's own chose
 * its tool, not `path`, and the toolchain it ran on, where it records one, so
 * CI runs the same copy and can't still report a pruned key. Every other
 * check keeps its entry and record as they were. It never adds a key, so a
 * run's verdict is the same before and after.
 */
export function rerecordCopies(baseline: Baseline, observations: ReadonlyMap<string, Observation>): { baseline: Baseline; results: Rerecord[] } {
  const slots: Record<string, string[]> = { ...baseline.slots };
  const captured: Record<string, Captured> = { ...baseline.captured_with };
  const counts: Record<string, Record<string, number>> = { ...baseline.counts };
  const results: Rerecord[] = [];
  for (const check of Object.keys(baseline.slots).toSorted()) {
    const step = rerecordCheck(check, { ...entryFor(baseline, check), record: baseline.captured_with?.[check] }, observations.get(check));
    results.push(step.result);
    if (step.entry === undefined) continue;
    slots[check] = step.entry.keys;
    captured[check] = step.entry.record;
    if (step.entry.counts !== undefined) counts[check] = step.entry.counts;
  }
  return { baseline: { schema_version: baseline.schema_version, slots, ...withCaptured(captured), ...withCounts(counts) }, results };
}

/**
 * What `baseline --versions` does with one check: leave it when the run didn't
 * observe it, or it reported a key its entry lacks or more findings of one
 * than the entry grandfathers, else weigh the copy that ran.
 */
function rerecordCheck(check: string, held: HeldEntry, seen: Observation | undefined): RerecordStep {
  if (seen === undefined) return { result: { check, outcome: 'not-run' } };
  if (seen.keys === null) return { result: { check, outcome: 'no-verdict' } };
  const reported = seen.keys;
  const { newKeys, excess } = applyBaseline(reported, held, false);
  if (newKeys.length + excess.length > 0) return { result: { check, outcome: 'new-keys', newKeys: newKeys.length + excess.length, ran: seen.ran } };
  return rerecordObserved(check, held, reported, seen.ran);
}

/**
 * A check that reported only keys its entry holds: unchanged when its entry
 * and record already say what the run did, left when no pin of the repo's
 * chose the copy that ran, its tool or the toolchain it ran on, and otherwise
 * re-recorded, its unreported keys pruned.
 */
function rerecordObserved(check: string, held: HeldEntry, reported: Tally, ran: RanWith): RerecordStep {
  const record = capturedRecord(ran);
  const next = prunedEntry(held, reported);
  if (sameEntry(held, next, record)) return { result: { check, outcome: 'unchanged' } };
  if (!pinnedCopy(record, ran)) return { result: { check, outcome: 'unpinned', ran } };
  const from = held.record === undefined ? {} : { from: held.record };
  return { result: { check, outcome: 'rerecorded', ...from, to: record, pruned: held.keys.length - next.keys.length }, entry: { ...next, record } };
}

/** `held` with the keys `reported` lacks pruned, and its counts, when it has them, lowered to what was reported. */
function prunedEntry(held: BaselineEntry, reported: Tally): { keys: string[]; counts?: Record<string, number> } {
  const keys = held.keys.filter((k) => reported.has(k)).toSorted();
  return held.counts === undefined ? { keys } : { keys, counts: lowerCounts(held.counts, reported) };
}

/** Whether a re-record would change nothing: the same keys and counts, and the same copy recorded. */
function sameEntry(held: HeldEntry, next: BaselineEntry, record: Captured | undefined): boolean {
  return next.keys.length === held.keys.length && sameCounts(held.counts, next.counts) && sameRecord(held.record, record);
}

/** Whether a pin of the repo's chose the copy that ran: its tool, through a source other than `PATH`, and its toolchain where it records one. */
function pinnedCopy(record: Captured | undefined, ran: RanWith): record is Captured {
  return record !== undefined && record.pin_source !== 'path' && ran.toolchain_pinned !== false;
}

/** Whether two checks' counts say the same, key order aside; two uncounted checks do. */
function sameCounts(a: Readonly<Record<string, number>> | undefined, b: Readonly<Record<string, number>> | undefined): boolean {
  return countsText(a) === countsText(b);
}

/** A check's counts as text, its keys sorted, for {@link sameCounts}; `''` for an uncounted check. */
function countsText(counts: Readonly<Record<string, number>> | undefined): string {
  return counts === undefined ? '' : JSON.stringify(Object.entries(counts).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

/** Whether two capture records say the same, field order aside; two absent records do. */
function sameRecord(a: Captured | undefined, b: Captured | undefined): boolean {
  const canonical = (r: Captured | undefined): string => (r === undefined ? '' : JSON.stringify(capturedAs(r.pin_source, r.tool_version, r.toolchain_version)));
  return canonical(a) === canonical(b);
}

/** Total grandfathered keys across every slot. */
export function countBaselineKeys(baseline: Baseline): number {
  return Object.values(baseline.slots).reduce((n, keys) => n + keys.length, 0);
}

/**
 * Total grandfathered findings across every slot: each counted key's count,
 * and one for every other key, which for a check captured before counts is
 * the fewest its key grandfathers.
 */
export function countGrandfathered(baseline: Baseline): number {
  let total = 0;
  for (const [check, keys] of Object.entries(baseline.slots)) {
    const counts = baseline.counts?.[check] ?? {};
    for (const key of keys) total += counts[key] ?? 1;
  }
  return total;
}

/**
 * Sorted-slots, sorted-unique-keys copy — the one shape the file is ever
 * written in — with `captured_with` after the slots, sorted, holding only the
 * checks the slots do, each entry's fields in their one order, and left out
 * when it holds none, then `counts`, likewise.
 */
function canonicalize(base: Baseline): Baseline {
  const slots: Record<string, string[]> = {};
  for (const key of Object.keys(base.slots).toSorted()) slots[key] = [...new Set(base.slots[key] ?? [])].toSorted();
  const captured: Record<string, Captured> = {};
  for (const check of Object.keys(slots)) {
    const entry = base.captured_with?.[check];
    if (entry !== undefined) captured[check] = capturedAs(entry.pin_source, entry.tool_version, entry.toolchain_version);
  }
  return { schema_version: base.schema_version, slots, ...withCaptured(captured), ...withCounts(canonicalCounts(slots, base.counts)) };
}

/**
 * `counts` as the file writes it: a sorted entry for each counted check that
 * holds a key, since an empty check grandfathers nothing either way, with its
 * keys sorted, each one the check holds with a count of two or more.
 */
function canonicalCounts(slots: Readonly<Record<string, string[]>>, counts: Baseline['counts']): Record<string, Record<string, number>> {
  const canonical: Record<string, Record<string, number>> = {};
  for (const [check, keys] of Object.entries(slots)) {
    const entry = counts?.[check];
    if (entry === undefined || keys.length === 0) continue;
    canonical[check] = {};
    for (const key of keys) {
      const n = entry[key];
      if (n !== undefined && n >= 2) canonical[check][key] = n;
    }
  }
  return canonical;
}

/** Canonical string form (sorted slots and keys) for order-independent compare. */
function canonicalBaseline(base: Baseline): string {
  return JSON.stringify(canonicalize(base));
}

/** Order-independent structural equality, so an unchanged ratchet skips its write. */
export function baselinesEqual(a: Baseline, b: Baseline): boolean {
  return canonicalBaseline(a) === canonicalBaseline(b);
}
