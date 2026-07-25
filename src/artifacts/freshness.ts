/**
 * The freshness window — which `.check/` files belong to the run that wrote the
 * summary sitting beside them.
 *
 * `.check/` is a flat directory of last-write-wins artifacts, and a run only
 * writes the slots it selected: an unselected slot's file lingers with no entry
 * in `summary.json` to contradict it. In this repo's own `.check/`,
 * `mutation.json` and `security.json` routinely sit days older than everything
 * else. Reading one as current is exactly the confidently-wrong answer these
 * readers exist to prevent.
 *
 * The window is `[timestamp - total_duration_ms, ∞)` — the run's *start*, not
 * its end. `timestamp` is stamped when the summary is built (see
 * `buildSummary` in `../orchestrator.ts`), so every artifact the run just wrote
 * is necessarily *older* than it; comparing against `timestamp` alone would
 * label a whole healthy run stale. Both fields are promised surfaces under
 * `schema_version` 1, which is what makes the derivation contract-legal.
 *
 * Anything outside the window is labelled with its age, never silently dropped.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import type { Summary } from '../orchestrator.js';

/** An artifact's standing relative to the run that wrote the summary. */
export type Freshness = {
  /** `unknown` when the summary's `timestamp` could not be parsed. */
  state: 'fresh' | 'stale' | 'unknown';
  /** How long before the run started the file was written; `null` unless stale. */
  ageMs: number | null;
};

const FRESH: Freshness = { state: 'fresh', ageMs: null };
const UNKNOWN: Freshness = { state: 'unknown', ageMs: null };

/**
 * Epoch milliseconds at which the run began, or `null` when `timestamp` is not
 * a parseable date. Callers treat `null` as "cannot judge freshness" rather
 * than guessing in either direction.
 */
export function runWindowStart(summary: Summary): number | null {
  const stamped = Date.parse(summary.timestamp);
  if (Number.isNaN(stamped)) return null;
  return stamped - summary.total_duration_ms;
}

/** Classify one artifact's mtime against the window from {@link runWindowStart}. */
export function classifyFreshness(mtimeMs: number, windowStart: number | null): Freshness {
  if (windowStart === null) return UNKNOWN;
  if (mtimeMs >= windowStart) return FRESH;
  return { state: 'stale', ageMs: windowStart - mtimeMs };
}
