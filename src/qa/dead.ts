/**
 * `dead.json` — fallow's dead-code report, whose shape is ~35 top-level arrays
 * of which almost all are empty almost always.
 *
 * That shape is the extraction problem: printing the report's own summary block
 * means printing 35 zeroes to say "clean", and printing the arrays means
 * printing whatever the biggest one holds. So the fold is "non-empty buckets
 * only", discovered by iterating the arrays rather than matching a hand-kept
 * list of category names — fallow adds categories in minor releases, and a
 * reader with a fixed list would silently omit a new finding type.
 *
 * `total_issues` stays the authoritative count (it is what checkride gates on),
 * and the buckets explain it. Each bucket carries a couple of sample labels so
 * the finding has a location without the file being opened.
 *
 * The `../qa` barrel is this module's only public surface.
 */

import { asNumberOrNull, asRecord, asStringOrNull, isRecord } from '../artifacts/index.js';

/** Buckets listed; the rest are counted. */
const TOP_BUCKETS = 8;
/** Sample labels per bucket. */
const SAMPLES_PER_BUCKET = 3;

/** One non-empty finding category. */
export type DeadBucket = {
  /** fallow's own key: `unused_exports`, `circular_dependencies`, … */
  name: string;
  count: number;
  /** A few findings, labelled `path:symbol` where the shape allows. */
  samples: string[];
};

export type DeadExtract = {
  /** fallow's authoritative count — the number checkride gates the slot on. */
  totalIssues: number | null;
  entryPoints: number | null;
  buckets: DeadBucket[];
  omittedBuckets: number;
};

/**
 * Arrays that are report metadata rather than findings. `next_steps` is
 * fallow's advice list; it is not a finding and does not count toward
 * `total_issues`.
 */
const NON_FINDING_ARRAYS = new Set(['next_steps']);

/** Where a finding says it is, and what it says it is about. */
const FILE_FIELDS = ['path', 'file'] as const;
const SYMBOL_FIELDS = ['export_name', 'name', 'dependency'] as const;

/** The first of `fields` holding a non-empty string, or `''` when none does. */
function firstString(item: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = asStringOrNull(item[field]);
    if (value !== null && value !== '') return value;
  }
  return '';
}

/**
 * A finding's display label: its file, plus whichever symbol field this
 * category happens to use. Purely for reading — unlike the baseline's
 * fingerprint it needs no stability across edits, so a finding with no symbol
 * falls back to a line number rather than to a synthesized identity.
 */
function label(item: unknown): string {
  if (!isRecord(item)) return '(unreadable finding)';
  const file = firstString(item, FILE_FIELDS);
  const symbol = firstString(item, SYMBOL_FIELDS);
  const where = [file, symbol].filter(Boolean).join(':');
  if (where === '') return '(no location)';
  if (symbol !== '') return where;
  const line = asNumberOrNull(item['line']);
  return line === null ? where : `${where}:${line}`;
}

/** Every non-empty finding array, biggest first. */
function collectBuckets(value: Record<string, unknown>): DeadBucket[] {
  const buckets: DeadBucket[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || entry.length === 0 || NON_FINDING_ARRAYS.has(name)) continue;
    buckets.push({ name, count: entry.length, samples: entry.slice(0, SAMPLES_PER_BUCKET).map(label) });
  }
  return buckets.toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Fold a parsed `dead.json` into the report model, or `null` when it carries no
 * issue count in either place fallow writes one — a report whose count cannot
 * be read must not be summarized as clean.
 */
export function extractDead(value: Record<string, unknown>): DeadExtract | null {
  const summary = asRecord(value['summary']);
  const totalIssues = asNumberOrNull(summary['total_issues']) ?? asNumberOrNull(value['total_issues']);
  if (totalIssues === null) return null;

  const buckets = collectBuckets(value);
  return {
    totalIssues,
    entryPoints: asNumberOrNull(asRecord(value['entry_points'])['total']),
    buckets: buckets.slice(0, TOP_BUCKETS),
    omittedBuckets: Math.max(0, buckets.length - TOP_BUCKETS),
  };
}
