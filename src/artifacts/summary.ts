/**
 * The `.check/summary.json` read — the one place either reader parses it.
 *
 * The summary is checkride's promised index: `schema_version`-ed, additive-only,
 * deterministically ordered and crash-consistent. This module turns it into a
 * four-state result rather than a value-or-throw, because every failure mode is
 * something a reader has to *report* — a missing summary means the gate never
 * wrote one, and a `schema_version` this reader does not understand means stop,
 * not guess.
 *
 * Validation here is deliberately structural, not schematic: the full JSON
 * Schema lives in `schema/checkride.summary.schema.json` and is the engine's
 * job. All this needs is enough narrowing that the fields the readers touch are
 * the types they claim to be, with no cast onto unvalidated bytes.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Summary, SummaryCheck } from '../orchestrator.js';
import type { JsonRecord } from './json.js';
import { isRecord, parseJson } from './json.js';

/** The gitignored directory every run writes its artifacts into. */
export const CHECK_DIR = '.check';

/** The aggregate report, beside the raw artifacts under {@link CHECK_DIR}. */
const SUMMARY_FILE = 'summary.json';

/**
 * The only `schema_version` these readers understand.
 *
 * Deliberately a literal, not the engine's `SCHEMA_VERSION` import: the
 * additive-only guarantee holds *within* a version and promises nothing across
 * one, so a bump has to stop the reader loudly rather than be silently
 * followed. `artifacts.test.ts` asserts this equals the engine's constant, so a
 * future bump turns a test red — a deliberate update, never a quiet change of
 * behavior.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** The outcome of reading `.check/summary.json`. Every state is reportable. */
export type SummaryRead =
  | { state: 'ok'; path: string; mtimeMs: number; summary: Summary }
  | { state: 'schema-mismatch'; path: string; mtimeMs: number; found: unknown }
  | { state: 'unreadable'; path: string; detail: string }
  | { state: 'missing'; path: string };

/**
 * Name, adapter and description are present and the right type. Bracket access
 * throughout: these are unvalidated bytes, and reading them as a dynamic record
 * is what they are.
 */
function hasCheckIdentity(value: JsonRecord): boolean {
  return (
    typeof value['name'] === 'string' &&
    typeof value['description'] === 'string' &&
    (typeof value['adapter'] === 'string' || value['adapter'] === null)
  );
}

/** The result fields the readers render are present and the right type. */
function hasCheckOutcome(value: JsonRecord): boolean {
  return (
    typeof value['ok'] === 'boolean' &&
    typeof value['duration_ms'] === 'number' &&
    (typeof value['exit_code'] === 'number' || value['exit_code'] === null) &&
    (typeof value['output_file'] === 'string' || value['output_file'] === null)
  );
}

/**
 * One `checks[]` entry. The optional additive fields (`skipped`, `reason`,
 * `baselined`) are read through `??` at the point of use, so they need no guard.
 */
function isCheck(value: unknown): value is SummaryCheck {
  return isRecord(value) && hasCheckIdentity(value) && hasCheckOutcome(value);
}

/** Every required top-level field, and a well-formed `checks[]`. */
function isSummary(value: JsonRecord): value is JsonRecord & Summary {
  const checks = value['checks'];
  return (
    typeof value['timestamp'] === 'string' &&
    typeof value['ok'] === 'boolean' &&
    typeof value['checks_run'] === 'number' &&
    typeof value['total_duration_ms'] === 'number' &&
    Array.isArray(checks) &&
    checks.every(isCheck)
  );
}

/** Classify already-read bytes. Split out so tests can drive every state. */
export function parseSummary(raw: string, path: string, mtimeMs: number): SummaryRead {
  const value = parseJson(raw);
  if (!isRecord(value)) return { state: 'unreadable', path, detail: 'not a JSON object' };
  // Version first: a summary this reader cannot read is a version problem, not
  // a shape problem, even when its other fields also fail to narrow.
  if (value['schema_version'] !== SUPPORTED_SCHEMA_VERSION) {
    return { state: 'schema-mismatch', path, mtimeMs, found: value['schema_version'] };
  }
  if (!isSummary(value)) return { state: 'unreadable', path, detail: 'missing or mistyped required field(s)' };
  return { state: 'ok', path, mtimeMs, summary: value };
}

/** Read and classify `<cwd>/.check/summary.json`. Never throws. */
export async function readSummary(cwd: string): Promise<SummaryRead> {
  const path = join(cwd, CHECK_DIR, SUMMARY_FILE);
  try {
    const [stats, raw] = await Promise.all([stat(path), readFile(path, 'utf8')]);
    return parseSummary(raw, path, stats.mtimeMs);
  } catch {
    return { state: 'missing', path };
  }
}
