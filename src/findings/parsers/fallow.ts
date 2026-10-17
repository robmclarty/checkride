/**
 * Fallow (v7) report parsing: one parser for the JSON behind all three fallow
 * slots — `dead` (dead-code), `dupes` (duplication), and `health`
 * (complexity) — which dispatches on the report's top-level `kind`, since each
 * analysis has its own layout.
 *
 * Besides its findings, a report yields the authoritative issue count and
 * whether every counted finding carries its own key, which the baseline's
 * fallow verdict gates on in place of fallow's exit code (see
 * `baseline/fallow.ts`). An unrecognized schema is a reason, never a clean
 * report, so the verdict fails loudly rather than passing silently.
 *
 * The JSON is fallow's `schema_version` >= 7 shape (fallow >= 3.5; fallow 2.x
 * was schema 4 with a different layout and is no longer supported).
 */

import { isRecord } from '../../json.js';
import { parseToolJson } from '../../tool-json.js';
import { rebasePath } from '../paths.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Minimum fallow JSON schema version checkride understands, and deliberately a
 * floor rather than an exact match: fallow bumps the number for layout changes
 * that leave the fields below untouched. 3.5.0 through 3.9.1 emitted 7 for all
 * three kinds; 3.22.0 emitted 11 for health and 9 for dead-code and dupes; and
 * 3.31.0 emits 11 for health, 9 for dead-code and 10 for dupes. Every field
 * these parsers read (`findings[].path`/`.name`, `summary.total_issues`,
 * `clone_groups[].fingerprint`) is unchanged across that span — re-verified
 * against 3.31.0 output carrying a real finding of each kind, since a shape
 * drift here would read as zero findings and pass. 2.x emitted 4 with an
 * incompatible layout. A report below
 * this floor — or one whose kind/shape we can't read — is a hard failure,
 * never a silent pass.
 */
const FALLOW_SCHEMA_MIN = 7;

/**
 * A parsed fallow report, or the reason it could not be read. `fullyTracked` is
 * true only when every counted finding produced exactly one key, so each can be
 * grandfathered individually — the guard the fallow verdict uses to refuse
 * masking a slot it can't fully cover. It is false when a finding carries no
 * stable identity, and equally when the key count disagrees with the
 * authoritative issue count (keys for something uncounted, or findings the
 * parse never read). A key *collision* does not clear it: findings are counted
 * before a key set collapses duplicates, so two findings sharing a key stay
 * fully tracked and the baseline coarsens rather than disabling.
 */
export type FallowReport =
  | { ok: true; kind: string; findings: KeyedFinding[]; issueCount: number; fullyTracked: boolean }
  | { ok: false; reason: string };

/** Read a field as a trimmed string, or `''` when missing/not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A counted fallow finding. Every one gates, since the verdict counts it;
 * `severity` is the item's own, verbatim, when it carries one.
 */
function finding(item: Record<string, unknown>, fields: { file: string; rule: string; message: string; key: string }): KeyedFinding {
  const severity = str(item['severity']);
  return { ...fields, ...(severity ? { severity } : {}), gates: true };
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
 * A cross-file finding (circular_dependencies, re_export_cycles), keyed on its
 * sorted file membership — a list of files/segments rather than one location.
 * Returns `null` when the item carries no such list. Each file is joined onto
 * `root`, the check's root, as every path in a key is.
 */
function cycleFinding(category: string, item: Record<string, unknown>, root: string | undefined): KeyedFinding | null {
  for (const field of ['cycle', 'files', 'chain']) {
    const arr = item[field];
    if (!Array.isArray(arr)) continue;
    const files = arr
      .map((x) => (typeof x === 'string' ? x : isRecord(x) ? str(x['path']) || str(x['file']) : ''))
      .filter(Boolean)
      .map((file) => rebasePath(root, file))
      .toSorted();
    if (files.length > 0) {
      return finding(item, { file: files[0] ?? '', rule: category, message: files.join(' -> '), key: `dead-code:${category}:${files.join('->')}` });
    }
  }
  return null;
}

/**
 * One dead-code finding, keyed `dead-code:<category>:<identity>`, where
 * identity is a file and symbol (never a line or column, so the key survives
 * edits that only move the code). When a finding has a file but no symbol —
 * `stale_suppressions`, `policy_violations` and the boundary categories carry
 * only a path — the path alone would collide with its siblings in the same
 * file, so the position is appended to keep them distinct, at the cost of a
 * key that moves. Cross-file findings (cycles) key on the sorted set of files.
 * Returns `null` when no stable identity can be read — the finding still
 * counts toward `issueCount`, it just can't be individually grandfathered
 * (which keeps the slot conservatively red, never silently green). Its file is
 * joined onto `root`, the check's root.
 */
function deadFinding(category: string, item: unknown, root: string | undefined): KeyedFinding | null {
  if (!isRecord(item)) return null;
  const file = rebasePath(root, str(item['path']) || str(item['file']));
  const symbol = symbolIdentity(item);
  if (symbol) {
    return finding(item, { file, rule: category, message: symbol, key: `dead-code:${category}:${[file, symbol].filter(Boolean).join(':')}` });
  }
  if (file) return finding(item, { file, rule: category, message: '', key: withPosition(`dead-code:${category}:${file}`, item) });
  return cycleFinding(category, item, root);
}

/**
 * Top-level arrays that are NOT counted in `total_issues`, so keying them would
 * push the key count past the issue count and leave the two out of step: the
 * advisory `next_steps`, the project-level `workspace_diagnostics`, and the
 * three opt-in "health signal" rules that fallow's own `issue-registry.json`
 * marks `counts_in_total: false`. They have to be skipped by name rather than
 * left to {@link deadFinding} — `workspace_diagnostics` carries a `path`, and
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
 * Every counted finding in a dead-code report — duplicate keys intact, so a
 * collision stays visible to the caller's tracking check — and how many items
 * carried no stable identity to key on.
 */
function collectDeadFindings(j: Record<string, unknown>, root: string | undefined): { findings: KeyedFinding[]; unkeyed: number } {
  const findings: KeyedFinding[] = [];
  let unkeyed = 0;
  for (const [category, value] of Object.entries(j)) {
    if (!Array.isArray(value) || UNCOUNTED_ARRAYS.has(category)) continue;
    for (const item of value) {
      const found = deadFinding(category, item, root);
      if (found === null) unkeyed += 1;
      else findings.push(found);
    }
  }
  return { findings, unkeyed };
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
function parseDeadCode(j: Record<string, unknown>, root: string | undefined): FallowReport {
  const summary = isRecord(j['summary']) ? j['summary'] : {};
  const total = summary['total_issues'] ?? j['total_issues'];
  if (typeof total !== 'number') {
    return { ok: false, reason: 'fallow dead-code JSON missing summary.total_issues' };
  }
  const { findings, unkeyed } = collectDeadFindings(j, root);
  // Two independent ways the keys can fail to cover the findings, both required
  // because either alone has a blind spot. Counting the items we could not key
  // is direct and exact. Comparing against the authoritative `total` catches
  // findings the iteration never reached at all (nothing to count) — and cannot
  // be substituted for the direct count, because a key produced for something
  // `total` omits would otherwise offset a real un-keyable finding back to zero.
  // `findings.length` counts keys BEFORE a set collapses collisions, so a
  // collision still reads as fully tracked.
  const fullyTracked = unkeyed === 0 && findings.length === total;
  return { ok: true, kind: 'dead-code', findings, issueCount: total, fullyTracked };
}

/**
 * Extract duplication findings. Each clone group carries a content-hash
 * `fingerprint` (`dup:…`) that is stable across line moves — the ideal key,
 * which names no file. The issue count is the number of clone groups.
 */
function parseDupes(j: Record<string, unknown>, root: string | undefined): FallowReport {
  const groups = j['clone_groups'];
  if (!Array.isArray(groups)) {
    return { ok: false, reason: 'fallow dupes JSON missing clone_groups' };
  }
  const findings: KeyedFinding[] = [];
  for (const g of groups) {
    if (!isRecord(g)) continue;
    const fp = str(g['fingerprint']);
    if (!fp) continue;
    const first = Array.isArray(g['instances']) ? g['instances'][0] : undefined;
    const file = rebasePath(root, isRecord(first) ? str(first['file']) : '');
    findings.push(finding(g, { file, rule: 'code-duplication', message: fp, key: `dupes:${fp}` }));
  }
  return { ok: true, kind: 'dupes', findings, issueCount: groups.length, fullyTracked: findings.length === groups.length };
}

/**
 * Extract health (complexity) findings — one per function over threshold, keyed
 * on file + function name. A named function stays line-free so its key survives
 * edits above it; an anonymous placeholder (`<arrow>`, `<anonymous>`) shares its
 * name with every sibling in the file, so it gets a position appended to stay
 * distinct. The issue count is the number of findings. Each path is joined
 * onto `root`, the check's root.
 */
function parseHealth(j: Record<string, unknown>, root: string | undefined): FallowReport {
  const items = j['findings'];
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'fallow health JSON missing findings' };
  }
  const findings: KeyedFinding[] = [];
  for (const f of items) {
    if (!isRecord(f)) continue;
    const name = str(f['name']);
    const file = rebasePath(root, str(f['path']));
    const base = `health:${file}:${name}`;
    findings.push(finding(f, { file, rule: 'complexity', message: name, key: STABLE_IDENTIFIER.test(name) ? base : withPosition(base, f) }));
  }
  return { ok: true, kind: 'health', findings, issueCount: items.length, fullyTracked: findings.length === items.length };
}

/**
 * The reason a report's schema can't be trusted, or `null` when it is a
 * supported version. Split out so {@link parseFallowReport} stays a thin dispatcher.
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
 * kind, missing count field) is a *loud* failure the verdict turns into a red
 * slot — checkride never treats an unreadable fallow report as "clean". `root`
 * is the check's root, which every path in a key is joined onto.
 */
export function parseFallowReport(raw: string, root: string | undefined): FallowReport {
  if (raw.trim() === '') return { ok: false, reason: 'fallow produced no JSON output' };
  // Tolerant of a launcher preamble ahead of the report — see `parseToolJson`.
  const parsed = parseToolJson(raw);
  if (!parsed) return { ok: false, reason: 'fallow did not emit valid JSON' };
  const j = parsed.value;
  if (!isRecord(j)) return { ok: false, reason: 'fallow output was not a JSON object' };

  const schemaError = fallowSchemaError(j);
  if (schemaError !== null) return { ok: false, reason: schemaError };

  const kind = str(j['kind']);
  switch (kind) {
    case 'dead-code':
      return parseDeadCode(j, root);
    case 'dupes':
      return parseDupes(j, root);
    case 'health':
      return parseHealth(j, root);
    default:
      return { ok: false, reason: `unrecognized fallow report kind '${kind || '(missing)'}'` };
  }
}

/**
 * Fallow's parser: the findings of a recognized, readable report, and an empty
 * array for anything else, which its format can't tell from a clean run here.
 * The fallow verdict is where an unreadable report becomes a failure; capture
 * and masking only need the keys.
 */
export const fallowParser: Parser = {
  stream: 'artifact',
  parse: (raw, { root }) => {
    const report = parseFallowReport(raw, root);
    return report.ok ? report.findings : [];
  },
};
