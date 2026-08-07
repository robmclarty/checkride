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
import { isRecord } from '../json.js';
import type { Fingerprint } from './fingerprint.js';

/** The committed baseline artifact, at repo root beside `checkride.config.json`. */
export const BASELINE_FILE = 'checkride.baseline.json';

/** Schema version of the baseline file; independent of the summary schema. */
export const BASELINE_SCHEMA_VERSION = 1;

/** Shape of `checkride.baseline.json`: per-slot sets of grandfathered keys. */
export type Baseline = {
  schema_version: number;
  slots: Record<string, string[]>;
};

/** The result of masking one slot's current fingerprint with its baseline. */
export type BaselineAdjustment = {
  /** Grandfathered-adjusted pass: the failure is fully explained by known debt. */
  ok: boolean;
  /** How many current diagnostics the baseline suppressed (the `baselined` count). */
  baselined: number;
  /** Sorted diagnostics present now that the baseline does NOT grandfather. */
  newKeys: string[];
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
 */
export function parseBaseline(raw: string): Baseline | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed['slots'])) return null;
    const version = parsed['schema_version'];
    if (typeof version === 'number' && version > BASELINE_SCHEMA_VERSION) return null;
    const slots: Record<string, string[]> = {};
    for (const [slot, keys] of Object.entries(parsed['slots'])) {
      if (Array.isArray(keys)) slots[slot] = keys.filter((k): k is string => typeof k === 'string');
    }
    return { schema_version: typeof version === 'number' ? version : BASELINE_SCHEMA_VERSION, slots };
  } catch {
    return null;
  }
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
 */
export function readBaselineStatus(cwd: string): BaselineRead {
  const path = join(cwd, BASELINE_FILE);
  if (!existsSync(path)) return { baseline: null, state: 'absent' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { baseline: null, state: 'unparseable' };
  }
  const baseline = parseBaseline(raw);
  return baseline === null ? { baseline: null, state: 'unparseable' } : { baseline, state: 'ok' };
}

/** Read `checkride.baseline.json` from `cwd`; `null` when absent or unusable. */
export function loadBaseline(cwd: string): Baseline | null {
  return readBaselineStatus(cwd).baseline;
}

/**
 * Serialize and write the baseline to `cwd` (canonical, pretty-printed,
 * trailing newline, atomic). Written canonical — sorted slots, sorted keys — so
 * the committed file diffs deterministically: two branches that grandfather the
 * same debt produce byte-identical files instead of a spurious merge conflict
 * over insertion order.
 */
export async function writeBaseline(cwd: string, baseline: Baseline): Promise<void> {
  await writeFileAtomic(join(cwd, BASELINE_FILE), `${JSON.stringify(canonicalize(baseline), null, 2)}\n`);
}

/**
 * Mask one slot's current fingerprint with its grandfathered keys. Masking is
 * pure set subtraction: `newKeys` are the current diagnostics the baseline does
 * not cover, `baselined` counts the ones it does.
 *
 * The failure flips to a pass *only* when there are current diagnostics and none
 * of them are new — a tool that produced no parseable diagnostics (a crash, empty
 * output that fingerprints to the empty set) is never masked, so a genuine
 * breakage still fails even while a baseline is active. Correctness beats
 * precision: better to re-surface a masked finding than to silently green a crash.
 */
export function applyBaseline(
  current: Fingerprint,
  baselinedKeys: readonly string[],
  rawOk: boolean,
): BaselineAdjustment {
  const grandfathered = new Set(baselinedKeys);
  const newKeys: string[] = [];
  let baselined = 0;
  for (const k of current) {
    if (grandfathered.has(k)) baselined += 1;
    else newKeys.push(k);
  }
  const ok = rawOk || (current.size > 0 && newKeys.length === 0);
  return { ok, baselined, newKeys: newKeys.toSorted() };
}

/**
 * Ratchet the baseline against a fully-observed run: for every slot observed this
 * run, keep only the grandfathered keys still present (a fixed diagnostic is
 * dropped); a slot absent from `observed` — disabled, without an extractor, or
 * not run — is preserved untouched. The result never grows: genuinely new findings
 * are the run's failures, not new debt, so only a `checkride baseline` capture
 * ever adds keys. Callers gate this on a full run (no `--only`/`--skip`/
 * `--changed`, no early `--bail` break) so a partial run can't prune keys it
 * simply didn't observe.
 */
export function ratchet(baseline: Baseline, observed: ReadonlyMap<string, Fingerprint>): Baseline {
  const slots: Record<string, string[]> = {};
  for (const [slot, keys] of Object.entries(baseline.slots)) {
    const current = observed.get(slot);
    slots[slot] = current === undefined ? keys : keys.filter((k) => current.has(k)).toSorted();
  }
  return { schema_version: baseline.schema_version, slots };
}

/** Total grandfathered diagnostics across every slot. */
export function countBaselineKeys(baseline: Baseline): number {
  return Object.values(baseline.slots).reduce((n, keys) => n + keys.length, 0);
}

/** Sorted-slots, sorted-keys copy — the one shape the file is ever written in. */
function canonicalize(base: Baseline): Baseline {
  const slots: Record<string, string[]> = {};
  for (const key of Object.keys(base.slots).toSorted()) slots[key] = [...(base.slots[key] ?? [])].toSorted();
  return { schema_version: base.schema_version, slots };
}

/** Canonical string form (sorted slots and keys) for order-independent compare. */
function canonicalBaseline(base: Baseline): string {
  return JSON.stringify(canonicalize(base));
}

/** Order-independent structural equality, so an unchanged ratchet skips its write. */
export function baselinesEqual(a: Baseline, b: Baseline): boolean {
  return canonicalBaseline(a) === canonicalBaseline(b);
}
