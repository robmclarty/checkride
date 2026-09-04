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
 * The JSON is fallow's `schema_version` >= 7 shape (fallow >= 3.5; fallow 2.x
 * was schema 4 with a different layout and is no longer supported). Each
 * analysis kind has its own layout, so parsing dispatches on the top-level
 * `kind`.
 */

import { parseToolJson } from '../tool-json.js';
import type { Fingerprint } from './fingerprint.js';
import { applyBaseline } from './store.js';

/**
 * Minimum fallow JSON schema version checkride understands, and deliberately a
 * floor rather than an exact match: fallow bumps the number for layout changes
 * that leave the fields below untouched. 3.5.0 through 3.9.1 emitted 7 for all
 * three kinds; 3.22.0 emits 11 for health and 9 for dead-code and dupes, and
 * every field these parsers read (`findings[].path`/`.name`,
 * `summary.total_issues`, `clone_groups[].fingerprint`) is unchanged across
 * that span — re-verified against 3.22.0 output, including a health report
 * carrying a real finding, since a shape drift here would read as zero
 * findings and pass. 2.x emitted 4 with an incompatible layout. A report below
 * this floor — or one whose kind/shape we can't read — is a hard failure,
 * never a silent pass.
 */
const FALLOW_SCHEMA_MIN = 7;

/**
 * A parsed fallow report, or the reason it could not be read. `fullyTracked` is
 * true only when every counted finding produced exactly one key, so each can be
 * grandfathered individually — the guard `fallowVerdict` uses to refuse masking
 * a slot it can't fully cover. It is false when a finding carries no stable
 * identity, and equally when the key count disagrees with the authoritative
 * issue count (keys for something uncounted, or findings the parse never read).
 * A key *collision* does not clear it: keys are counted before the Set collapses
 * duplicates, so two findings sharing a key stay fully tracked and the baseline
 * coarsens rather than disabling.
 */
type ParsedFallow =
  | { ok: true; kind: string; findings: string[]; issueCount: number; fullyTracked: boolean }
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
 * Fields naming the declaration that owns a member-scoped finding, in priority
 * order. fallow reports an unused class/enum/store member as `parent_name` +
 * `member_name`, a component binding as `component_name` + `prop_name` /
 * `input_name` / `output_name` / `emit_name` / `event_name`, and a catalog entry
 * as `catalog_name` + `entry_name`. Both halves are needed: the leaf alone is
 * ambiguous (two classes in one file can each have a `render`), and the
 * container alone collapses every member of one declaration onto one key.
 */
const CONTAINER_FIELDS = ['parent_name', 'component_name', 'catalog_name'] as const;

/** Finding fields that carry a stable leaf symbol, in priority order. */
const SYMBOL_FIELDS = [
  'export_name',
  'name',
  'type_name',
  'member',
  'member_name',
  'prop_name',
  'emit_name',
  'input_name',
  'output_name',
  'event_name',
  'entry_name',
  'action_name',
  'key_name',
  'package_name',
  'dependency',
  'specifier',
] as const;

/** The first non-empty field of `fields` on a finding, or `''` when none is set. */
function firstField(item: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = str(item[field]);
    if (value) return value;
  }
  return '';
}

/**
 * A finding's stable symbol identity: `<container>.<leaf>` when it carries both
 * (`Svc.unusedOne`), otherwise whichever half it has, otherwise `''`. Composing
 * the two is what keeps a member-scoped finding line-free — with neither half
 * recognized such a finding has no symbol at all and falls back to
 * `<path>:<line>:<col>`, a key that moves whenever code above it does, so a
 * grandfathered finding resurfaces as new on the next unrelated edit.
 */
function symbolIdentity(item: Record<string, unknown>): string {
  return [firstField(item, CONTAINER_FIELDS), firstField(item, SYMBOL_FIELDS)].filter(Boolean).join('.');
}

/**
 * A finding's `line[:col]` position, or `''` when it carries neither. Only used
 * to disambiguate findings that share every stable identity field (see
 * {@link withPosition}); a keyable finding never falls back to this.
 */
function position(item: Record<string, unknown>): string {
  return [item['line'], item['col']].filter((n): n is number => typeof n === 'number').join(':');
}

/** Append `:<line>[:<col>]` to a key when the finding has a position, else leave it. */
function withPosition(key: string, item: Record<string, unknown>): string {
  const pos = position(item);
  return pos ? `${key}:${pos}` : key;
}

/**
 * A function name that is a real, stable identifier (kept line-free so its key
 * survives edits above it). Fallow wraps names it can't resolve to an identity
 * in angle brackets (`<arrow>`, `<anonymous>`); those fail this test and get a
 * position appended, since every such placeholder in a file is otherwise equal.
 */
const STABLE_IDENTIFIER = /^[A-Za-z_$][\w$.]*$/;

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

/**
 * Fingerprint key for one dead-code finding: `dead-code:<category>:<identity>`,
 * where identity is a file and symbol (never a line or column, so the key
 * survives edits that only move the code). When a finding has a file but no
 * symbol — `stale_suppressions`, `policy_violations` and the boundary
 * categories carry only a path — the path alone would collide with its siblings
 * in the same file, so the position is appended to keep them distinct, at the
 * cost of a key that moves. Cross-file findings (cycles) key on the
 * sorted set of files. Returns `null` when no stable identity can be read — the
 * finding still counts toward `issueCount`, it just can't be individually
 * grandfathered (which keeps the slot conservatively red, never silently green).
 */
function deadKey(category: string, item: unknown): string | null {
  if (!isPlainObject(item)) return null;
  const file = str(item['path']) || str(item['file']);
  const symbol = symbolIdentity(item);
  if (symbol) return `dead-code:${category}:${[file, symbol].filter(Boolean).join(':')}`;
  if (file) return withPosition(`dead-code:${category}:${file}`, item);
  return cycleKey(category, item);
}

/**
 * Top-level arrays that are NOT counted in `total_issues`, so keying them would
 * push the key count past the issue count and leave the two out of step: the
 * advisory `next_steps`, the project-level `workspace_diagnostics`, and the
 * three opt-in "health signal" rules that fallow's own `issue-registry.json`
 * marks `counts_in_total: false`. They have to be skipped by name rather than
 * left to {@link deadKey} — `workspace_diagnostics` carries a `path`, and
 * `thin_wrappers` and `duplicate_prop_shapes` a `file`, so all three key
 * readily. Verified against fallow 3.9.1's registry; every other array counts.
 */
const UNCOUNTED_ARRAYS = new Set<string>([
  'next_steps',
  'workspace_diagnostics',
  'prop_drilling_chains',
  'thin_wrappers',
  'duplicate_prop_shapes',
]);

/**
 * Key every counted finding in a dead-code report. Returns the keys — duplicates
 * intact, so a collision stays visible to the caller's tracking check — and how
 * many items carried no stable identity to key on.
 */
function collectDeadKeys(j: Record<string, unknown>): { keys: string[]; unkeyed: number } {
  const keys: string[] = [];
  let unkeyed = 0;
  for (const [category, value] of Object.entries(j)) {
    if (!Array.isArray(value) || UNCOUNTED_ARRAYS.has(category)) continue;
    for (const item of value) {
      const key = deadKey(category, item);
      if (key === null) unkeyed += 1;
      else keys.push(key);
    }
  }
  return { keys, unkeyed };
}

/**
 * Extract dead-code findings and the authoritative issue count (`total_issues`).
 * Findings come from the top-level detail arrays (`unused_exports`,
 * `unused_dev_dependencies`, `circular_dependencies`, …) rather than the summary
 * keys: the summary aggregates a few categories under one name (for example dev and
 * optional deps both count as `unused_dependencies`) whose items live in
 * separately named arrays, so keying off the summary would miss them. Iterating
 * every array except the {@link UNCOUNTED_ARRAYS} covers whatever categories
 * fallow reports — including ones added in a future minor — without a
 * hand-maintained list of the ones that do count. A category whose items carry
 * no stable identity simply isn't fingerprinted; it still counts toward
 * `total_issues`, so the slot stays red (never masked) until it's fixed.
 */
function parseDeadCode(j: Record<string, unknown>): ParsedFallow {
  const summary = isPlainObject(j['summary']) ? j['summary'] : {};
  const total = summary['total_issues'] ?? j['total_issues'];
  if (typeof total !== 'number') {
    return { ok: false, reason: 'fallow dead-code JSON missing summary.total_issues' };
  }
  const { keys, unkeyed } = collectDeadKeys(j);
  // Two independent ways the keys can fail to cover the findings, both required
  // because either alone has a blind spot. Counting the items we could not key
  // is direct and exact. Comparing against the authoritative `total` catches
  // findings the iteration never reached at all (nothing to count) — and cannot
  // be substituted for the direct count, because a key produced for something
  // `total` omits would otherwise offset a real un-keyable finding back to zero.
  // `keys.length` is taken BEFORE the Set collapses collisions, so a collision
  // still reads as fully tracked.
  const fullyTracked = unkeyed === 0 && keys.length === total;
  return { ok: true, kind: 'dead-code', findings: keys, issueCount: total, fullyTracked };
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
  return { ok: true, kind: 'dupes', findings, issueCount: groups.length, fullyTracked: findings.length === groups.length };
}

/**
 * Extract health (complexity) findings — one per function over threshold, keyed
 * on file + function name. A named function stays line-free so its key survives
 * edits above it; an anonymous placeholder (`<arrow>`, `<anonymous>`) shares its
 * name with every sibling in the file, so it gets a position appended to stay
 * distinct. The issue count is the number of findings.
 */
function parseHealth(j: Record<string, unknown>): ParsedFallow {
  const findings = j['findings'];
  if (!Array.isArray(findings)) {
    return { ok: false, reason: 'fallow health JSON missing findings' };
  }
  const keys: string[] = [];
  for (const f of findings) {
    if (!isPlainObject(f)) continue;
    const name = str(f['name']);
    const base = `health:${str(f['path'])}:${name}`;
    keys.push(STABLE_IDENTIFIER.test(name) ? base : withPosition(base, f));
  }
  return { ok: true, kind: 'health', findings: keys, issueCount: findings.length, fullyTracked: keys.length === findings.length };
}

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

/**
 * Parse a fallow report into findings + an issue count, or the reason it could
 * not be trusted. Every failure path (bad JSON, missing/old schema, unknown
 * kind, missing count field) is a *loud* failure the caller turns into a red
 * slot — checkride never treats an unreadable fallow report as "clean".
 */
function parseFallow(raw: string): ParsedFallow {
  if (raw.trim() === '') return { ok: false, reason: 'fallow produced no JSON output' };
  // Tolerant of a launcher preamble ahead of the report — see `parseToolJson`.
  const parsed = parseToolJson(raw);
  if (!parsed) return { ok: false, reason: 'fallow did not emit valid JSON' };
  const j = parsed.value;
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
 * Fallow's fingerprint extractor, for the extractor registry.
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
 * A report whose keys don't map one-per-finding onto its issue count — an
 * un-keyable finding, or a key produced for something the count doesn't include
 * — has findings that can't be individually grandfathered; a baseline must never
 * mask such a slot to green, so it stays at the raw findings-based verdict. A key
 * *collision* (two findings sharing a key) is not un-keyable — both are keyed, so
 * the baseline coarsens (grandfathering one grandfathers both) but stays active.
 * Correctness over precision: better to keep re-surfacing a finding than to
 * silently pass one.
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
  // Findings the keys don't cover block masking: hold the slot at its raw
  // verdict. A key collision does NOT (both findings are keyed, so the report
  // stays fully tracked), so it coarsens the baseline instead of disabling it. A
  // *deduplicated* size comparison could not tell the two apart, which is what
  // disabled the whole slot on any collision.
  if (!parsed.fullyTracked) {
    return { ok: rawOk, baselined: adj.baselined, newKeys: adj.newKeys, findings, observed: true, reason: issueReason };
  }
  // Fully tracked: a masked slot (all findings grandfathered) is green; a slot
  // that fails does so on `newKeys`, which the orchestrator lists — so no extra
  // reason line is needed either way.
  return { ok: adj.ok, baselined: adj.baselined, newKeys: adj.newKeys, findings, observed: true, reason: null };
}
