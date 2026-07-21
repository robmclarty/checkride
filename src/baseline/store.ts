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

/** Narrow to a plain object so fields can be read without an unsafe assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read `checkride.baseline.json` from `cwd`; `null` when absent or unusable. The
 * baseline is a committed file a run reads on every invocation, so a malformed
 * one is coerced into a clean shape (or dropped) rather than thrown — a corrupt
 * baseline must never break `checkride`.
 */
export function loadBaseline(cwd: string): Baseline | null {
  const path = join(cwd, BASELINE_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed['slots'])) return null;
    const slots: Record<string, string[]> = {};
    for (const [slot, keys] of Object.entries(parsed['slots'])) {
      if (Array.isArray(keys)) slots[slot] = keys.filter((k): k is string => typeof k === 'string');
    }
    const version = parsed['schema_version'];
    return { schema_version: typeof version === 'number' ? version : BASELINE_SCHEMA_VERSION, slots };
  } catch {
    return null;
  }
}

/** Serialize and write the baseline to `cwd` (pretty-printed, trailing newline, atomic). */
export async function writeBaseline(cwd: string, baseline: Baseline): Promise<void> {
  await writeFileAtomic(join(cwd, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
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

/** Canonical string form (sorted slots and keys) for order-independent compare. */
function canonicalBaseline(base: Baseline): string {
  const slots: Record<string, string[]> = {};
  for (const key of Object.keys(base.slots).toSorted()) slots[key] = [...(base.slots[key] ?? [])].toSorted();
  return JSON.stringify({ schema_version: base.schema_version, slots });
}

/** Order-independent structural equality, so an unchanged ratchet skips its write. */
export function baselinesEqual(a: Baseline, b: Baseline): boolean {
  return canonicalBaseline(a) === canonicalBaseline(b);
}
