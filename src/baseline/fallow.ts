/**
 * Fallow (v7) report parsing, gating, and fingerprinting.
 *
 * Fallow fills three slots — `dead` (dead-code), `dupes` (duplication), and
 * `health` (complexity) — and checkride owns the pass/fail *verdict* for all
 * three by parsing fallow's JSON, rather than trusting its process exit code.
 * That is deliberate: fallow 3.5.0's exit code does NOT reliably gate. Verified
 * against fallow 3.5.0:
 *   - `fallow --format json --fail-on-issues` (combined) exits 0 with issues.
 *   - `fallow dupes --format json` exits 0 no matter how much duplication (its
 *     `--threshold` defaults to `0` = "no limit").
 *   - only `fallow dead-code`/`health` with `--fail-on-issues` exit 1 on findings.
 * Keying pass/fail off the exit code (as the orchestrator does for every other
 * adapter) therefore let a green ✔ hide real findings. checkride reads the
 * authoritative issue count out of the JSON instead, so every fallow slot gates
 * uniformly — and an *unrecognized* schema fails loudly rather than passing
 * silently (the count can't be trusted, so the slot can't be green).
 *
 * The JSON is fallow's `schema_version: 7` shape (fallow >= 3.5; fallow 2.x was
 * schema 4 with a different layout and is no longer supported). Each analysis
 * kind has its own layout, so parsing dispatches on the top-level `kind`.
 */

import type { Fingerprint } from './fingerprint.js';
import { applyBaseline } from './store.js';

/**
 * Minimum fallow JSON schema version checkride understands. fallow 3.5.0 and
 * 3.6.0 both emit schema_version 7; 2.x emitted 4 with an incompatible layout.
 * A report below this floor — or one whose kind/shape we can't read — is a
 * hard failure, never a silent pass.
 */
const FALLOW_SCHEMA_MIN = 7;

/** A parsed fallow report, or the reason it could not be read. */
type ParsedFallow =
  | { ok: true; kind: string; findings: string[]; issueCount: number }
  | { ok: false; reason: string };

/** Narrow to a plain object (arrays and null excluded). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field as a trimmed string, or `''` when missing/not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Fingerprint key for one dead-code finding: `dead-code:<category>:<identity>`,
 * where identity is a file and/or symbol (never a line or column, so the key
 * survives edits that only move the code). Cross-file findings (cycles) key on
 * the sorted set of files. Returns `null` when no stable identity can be read —
 * the finding still counts toward `issueCount`, it just can't be individually
 * grandfathered (which keeps the slot conservatively red, never silently green).
 */
/** Finding fields that carry a single stable symbol identity, in priority order. */
const SYMBOL_FIELDS = [
  'export_name',
  'name',
  'type_name',
  'member',
  'package_name',
  'dependency',
  'specifier',
] as const;

/** The first non-empty symbol field on a finding, or `''` when none is present. */
function symbolIdentity(item: Record<string, unknown>): string {
  for (const field of SYMBOL_FIELDS) {
    const value = str(item[field]);
    if (value) return value;
  }
  return '';
}

/**
 * Key a cross-file finding (circular_dependencies, re_export_cycles) on its
 * sorted file membership — a list of files/segments rather than one location.
 * Returns `null` when the item carries no such list.
 */
function cycleKey(category: string, item: Record<string, unknown>): string | null {
  for (const field of ['cycle', 'files', 'chain']) {
    const arr = item[field];
    if (!Array.isArray(arr)) continue;
    const files = arr
      .map((x) => (typeof x === 'string' ? x : isPlainObject(x) ? str(x['path']) || str(x['file']) : ''))
      .filter(Boolean)
      .toSorted();
    if (files.length > 0) return `dead-code:${category}:${files.join('->')}`;
  }
  return null;
}

function deadKey(category: string, item: unknown): string | null {
  if (!isPlainObject(item)) return null;
  const file = str(item['path']) || str(item['file']);
  const symbol = symbolIdentity(item);
  if (file || symbol) {
    const identity = [file, symbol].filter(Boolean).join(':');
    return `dead-code:${category}:${identity}`;
  }
  return cycleKey(category, item);
}

/**
 * Extract dead-code findings and the authoritative issue count (`total_issues`).
 * Findings come from the top-level detail arrays (`unused_exports`,
 * `unused_dev_dependencies`, `circular_dependencies`, …) rather than the summary
 * keys: the summary aggregates a few categories under one name (e.g. dev and
 * optional deps both count as `unused_dependencies`) whose items live in
 * separately-named arrays, so keying off the summary would miss them. Iterating
 * every array and letting {@link deadKey} return `null` for non-finding arrays
 * (`next_steps`) covers whatever categories fallow reports — including ones added
 * in a future minor — without a hand-maintained list. A category whose items
 * carry no stable identity simply isn't fingerprinted; it still counts toward
 * `total_issues`, so the slot stays red (never masked) until it's fixed.
 */
function parseDeadCode(j: Record<string, unknown>): ParsedFallow {
  const summary = isPlainObject(j['summary']) ? j['summary'] : {};
  const total = summary['total_issues'] ?? j['total_issues'];
  if (typeof total !== 'number') {
    return { ok: false, reason: 'fallow dead-code JSON missing summary.total_issues' };
  }
  const findings: string[] = [];
  for (const [category, value] of Object.entries(j)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const key = deadKey(category, item);
      if (key !== null) findings.push(key);
    }
  }
  return { ok: true, kind: 'dead-code', findings, issueCount: total };
}

/**
 * Extract duplication findings. Each clone group carries a content-hash
 * `fingerprint` (`dup:…`) that is stable across line moves — the ideal key. The
 * issue count is the number of clone groups.
 */
function parseDupes(j: Record<string, unknown>): ParsedFallow {
  const groups = j['clone_groups'];
  if (!Array.isArray(groups)) {
    return { ok: false, reason: 'fallow dupes JSON missing clone_groups' };
  }
  const findings: string[] = [];
  for (const g of groups) {
    if (!isPlainObject(g)) continue;
    const fp = str(g['fingerprint']);
    if (fp) findings.push(`dupes:${fp}`);
  }
  return { ok: true, kind: 'dupes', findings, issueCount: groups.length };
}

/**
 * Extract health (complexity) findings — one per function over threshold, keyed
 * on file + function name (no line, so the key survives edits above it). The
 * issue count is the number of findings.
 */
function parseHealth(j: Record<string, unknown>): ParsedFallow {
  const findings = j['findings'];
  if (!Array.isArray(findings)) {
    return { ok: false, reason: 'fallow health JSON missing findings' };
  }
  const keys: string[] = [];
  for (const f of findings) {
    if (!isPlainObject(f)) continue;
    keys.push(`health:${str(f['path'])}:${str(f['name'])}`);
  }
  return { ok: true, kind: 'health', findings: keys, issueCount: findings.length };
}

/**
 * Parse a fallow report into findings + an issue count, or the reason it could
 * not be trusted. Every failure path (bad JSON, missing/old schema, unknown
 * kind, missing count field) is a *loud* failure the caller turns into a red
 * slot — checkride never treats an unreadable fallow report as "clean".
 */
/**
 * The reason a report's schema can't be trusted, or `null` when it is a
 * supported version. Split out so {@link parseFallow} stays a thin dispatcher.
 */
function fallowSchemaError(j: Record<string, unknown>): string | null {
  const schema = j['schema_version'];
  if (typeof schema !== 'number') return 'fallow JSON has no schema_version';
  if (schema < FALLOW_SCHEMA_MIN) {
    return `unsupported fallow schema_version ${schema}; checkride needs fallow >= 3.5 (schema_version ${FALLOW_SCHEMA_MIN}). Run \`pnpm up fallow\`.`;
  }
  return null;
}

function parseFallow(raw: string): ParsedFallow {
  if (raw.trim() === '') return { ok: false, reason: 'fallow produced no JSON output' };
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'fallow did not emit valid JSON' };
  }
  if (!isPlainObject(j)) return { ok: false, reason: 'fallow output was not a JSON object' };

  const schemaError = fallowSchemaError(j);
  if (schemaError !== null) return { ok: false, reason: schemaError };

  const kind = str(j['kind']);
  switch (kind) {
    case 'dead-code':
      return parseDeadCode(j);
    case 'dupes':
      return parseDupes(j);
    case 'health':
      return parseHealth(j);
    default:
      return { ok: false, reason: `unrecognized fallow report kind '${kind || '(missing)'}'` };
  }
}

/**
 * Fallow's fingerprint extractor (baseline part 1), for the extractor registry.
 * Returns the finding keys for a recognized, readable report and an empty set
 * for anything else — the "never throw, empty on malformed" contract every
 * extractor honours. The *gating* verdict (`fallowVerdict`) is where an
 * unreadable report becomes a failure; capture and masking only need the keys.
 */
export function fallowFindings(raw: string): Fingerprint {
  const parsed = parseFallow(raw);
  return new Set(parsed.ok ? parsed.findings : []);
}

/** The verdict for one fallow slot: pass/fail plus the baseline bookkeeping. */
export type FallowVerdict = {
  /** Slot verdict after baseline masking. */
  ok: boolean;
  /** Current findings the baseline grandfathered (the `baselined` count). */
  baselined: number;
  /** Sorted current findings the baseline does NOT cover. */
  newKeys: string[];
  /** All current findings — fed to the ratchet's observed map. */
  findings: Fingerprint;
  /**
   * True only when the report parsed to a recognized schema. The ratchet must
   * not prune a slot's baseline from an *unreadable* run (findings unknown, not
   * "all fixed"), so an unobserved slot is preserved untouched.
   */
  observed: boolean;
  /** A one-line failure explanation for the console, or `null` when green. */
  reason: string | null;
};

/**
 * Decide a fallow slot's verdict from its raw JSON and (optionally) the slot's
 * grandfathered keys. `baselineKeys === null` means no baseline is active (a
 * plain run or a `checkride baseline` capture): the verdict is simply whether
 * fallow found anything. With a baseline, findings are masked — the slot passes
 * when every current finding is grandfathered and fails on any new one.
 *
 * A report that parses to *fewer* fingerprints than its issue count has findings
 * that can't be individually grandfathered; a baseline must never mask such a
 * slot to green, so it stays at the raw findings-based verdict. Correctness over
 * precision: better to keep re-surfacing a finding than to silently pass one.
 */
export function fallowVerdict(raw: string, baselineKeys: readonly string[] | null): FallowVerdict {
  const parsed = parseFallow(raw);
  if (!parsed.ok) {
    return { ok: false, baselined: 0, newKeys: [], findings: new Set(), observed: false, reason: parsed.reason };
  }
  const findings = new Set(parsed.findings);
  const rawOk = parsed.issueCount === 0;
  const issueReason = rawOk ? null : `${parsed.issueCount} finding(s)`;

  if (baselineKeys === null) {
    return { ok: rawOk, baselined: 0, newKeys: [], findings, observed: true, reason: issueReason };
  }

  const adj = applyBaseline(findings, baselineKeys, rawOk);
  const fullyTracked = findings.size === parsed.issueCount;
  // Untracked findings block masking: hold the slot at its raw verdict.
  if (!fullyTracked) {
    return { ok: rawOk, baselined: adj.baselined, newKeys: adj.newKeys, findings, observed: true, reason: issueReason };
  }
  // Fully tracked: a masked slot (all findings grandfathered) is green; a slot
  // that fails does so on `newKeys`, which the orchestrator lists — so no extra
  // reason line is needed either way.
  return { ok: adj.ok, baselined: adj.baselined, newKeys: adj.newKeys, findings, observed: true, reason: null };
}
