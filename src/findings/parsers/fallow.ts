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
 * The JSON is fallow's `schema_version` >= 7 shape, which fallow 2.104 and
 * every 3.x release emit; earlier 2.x releases emitted 3 or 4, with a
 * different layout, and are no longer supported. Its lines are 1-based and
 * its columns 0-based.
 */

import { isRecord } from '../../json.js';
import { parseToolJson } from '../../tool-json.js';
import type { PathBase } from '../paths.js';
import { rebasePath } from '../paths.js';
import { located, oneBased } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Minimum fallow JSON schema version checkride understands, and deliberately a
 * floor rather than an exact match: fallow bumps the number for layout changes
 * that leave the fields below untouched. 2.104.0 and 3.0.0 through 3.9.1
 * emitted 7 for all three kinds; 3.22.0 emitted 11 for health and 9 for
 * dead-code and dupes; and 3.31.0 emits 11 for health, 9 for dead-code and 10
 * for dupes. Every field these parsers read (`findings[].path`/`.name`,
 * `summary.total_issues`, `clone_groups[].fingerprint`) is unchanged across
 * that span — re-verified against 3.31.0 output carrying a real finding of
 * each kind, since a shape drift here would read as zero findings and pass.
 * The fields a boundary import and a package cycle key on (`from_path` and
 * `to_path`, `package_roots`) are checked against 3.31.0 alone; a release
 * whose entries lack them reads as findings the keys miss, which keeps a
 * baseline from masking the check, never as a pass. Earlier 2.x releases
 * emitted 3 (2.0.0) or 4 (2.60.0), with an incompatible layout. A report below this floor — or one whose kind/shape we can't read —
 * is a hard failure, never a silent pass. The floor is named by its schema,
 * never a fallow version, since the releases that emit it don't follow one
 * line.
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
 * fully tracked and the baseline coarsens rather than disabling. `unkeyed`
 * names the array of each counted finding that produced no key, one entry a
 * finding, so a reader can say which findings the keys miss. `stopped` marks
 * a reason fallow gave itself, in its own error report: it never ran its
 * analysis, so the check reached no verdict at all.
 */
export type FallowReport =
  | { ok: true; kind: string; findings: KeyedFinding[]; issueCount: number; fullyTracked: boolean; unkeyed: string[] }
  | { ok: false; reason: string; stopped?: true };

/** Read a field as a trimmed string, or `''` when missing/not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The slot each report kind fills. */
const KIND_SLOTS: Readonly<Record<string, string>> = { 'dead-code': 'dead', dupes: 'dupes', health: 'health' };

/** What a counted finding names beside its key: its file, rule and message, and where it sits. */
type FindingFields = { file: string; line?: number; column?: number; rule: string; message: string; key: string };

/**
 * A counted fallow finding from a report of `kind`. Every one gates, since the
 * verdict counts it; `severity` is the item's own, verbatim, when it carries
 * one.
 */
function finding(kind: string, item: Record<string, unknown>, fields: FindingFields): KeyedFinding {
  const severity = str(item['severity']);
  return { ...fields, ...(severity ? { severity } : {}), gates: true, slot: KIND_SLOTS[kind] ?? kind };
}

/** Where an item sits: its `line` (1-based) and `col` (0-based), as 1-based numbers. */
function at(item: Record<string, unknown>, line: string, col: string): { line?: number; column?: number } {
  return located(oneBased(item[line], 1), oneBased(item[col], 0));
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

/** A script file's name, `.ts`, `.mjs` or `.jsx` among them, as against a markup file's. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Whether a health finding's name keys it without its position: a real
 * identifier, or a synthetic unit fallow emits once to a file. A component's
 * roll-up, `<component>`, comes once to a component file, and a `<template>`
 * once to a markup file: an Angular `templateUrl` file, or a `.vue`,
 * `.svelte` or `.astro` component. An inline Angular template sits in a
 * script file beside any others the file holds, with nothing but its
 * decorator's position to tell them apart, so it keeps the position, as
 * `<arrow>` does, and so does a Svelte `<snippet:NAME>`, since two snippets in
 * one file may share a name, and a baseline captured before counts would
 * then grandfather the second under the first's key. Checked against fallow
 * 3.31.0's report over each kind.
 */
function namedUnit(name: string, file: string): boolean {
  if (STABLE_IDENTIFIER.test(name) || name === '<component>') return true;
  return name === '<template>' && !SCRIPT_FILE.test(file);
}

/** A health key with a position appended to one of the units {@link namedUnit} can key without it. */
const POSITIONAL_UNIT = /^health:(.+):(<component>|<template>)(?::\d+){1,2}$/;

/**
 * The key a finding takes now, for a key an earlier release wrote. Through
 * 0.18 a `<component>` roll-up and a markup file's `<template>` keyed with
 * their position appended, so an edit above one moved its key, and a baseline
 * that grandfathered it read it as new (#8). They key without it now
 * ({@link namedUnit}), and a baseline reads such a key in the old form as the
 * new one, so a file captured before still grandfathers them. Every other key
 * is returned as it is.
 */
export function currentKey(key: string): string {
  const match = POSITIONAL_UNIT.exec(key);
  if (match === null) return key;
  const [, file = '', unit = ''] = match;
  return namedUnit(unit, file) ? `health:${file}:${unit}` : key;
}

/**
 * A cross-file finding (circular_dependencies, re_export_cycles,
 * package_cycles), keyed on its sorted membership — a list of files/segments
 * rather than one location: the files a cycle passes through, or a package
 * cycle's `package_roots`, since a package's root names it uniquely where two
 * packages can share a name. Returns `null` when the item carries no such
 * list. Each path is rebased from `base`, as every path in a key is.
 */
function cycleFinding(category: string, item: Record<string, unknown>, base: PathBase): KeyedFinding | null {
  for (const field of ['cycle', 'files', 'chain', 'package_roots']) {
    const arr = item[field];
    if (!Array.isArray(arr)) continue;
    const files = arr
      .map((x) => (typeof x === 'string' ? x : isRecord(x) ? str(x['path']) || str(x['file']) : ''))
      .filter(Boolean)
      .map((file) => rebasePath(base, file))
      .toSorted();
    if (files.length > 0) {
      return finding('dead-code', item, { file: files[0] ?? '', rule: category, message: files.join(' -> '), key: `dead-code:${category}:${files.join('->')}` });
    }
  }
  return null;
}

/**
 * An import that crosses a zone boundary (`boundary_violations`), keyed on its
 * two ends, `<from>:<to>`, and never its position, so the key survives edits
 * that move the import, as a symbol's does. fallow reports one per importing
 * file and file it imports, however many statements import it, through a
 * barrel or not (checked against fallow 3.31.0). Its file is the importing
 * one. Returns `null` for an item that doesn't name both ends. Both paths are
 * rebased from `base`.
 */
function edgeFinding(category: string, item: Record<string, unknown>, base: PathBase): KeyedFinding | null {
  const from = str(item['from_path']);
  const to = str(item['to_path']);
  if (!from || !to) return null;
  const file = rebasePath(base, from);
  const target = rebasePath(base, to);
  return finding('dead-code', item, { file, ...at(item, 'line', 'col'), rule: category, message: `${file} -> ${target}`, key: `dead-code:${category}:${file}:${target}` });
}

/**
 * One dead-code finding, keyed `dead-code:<category>:<identity>`, where
 * identity is a file and symbol (never a line or column, so the key survives
 * edits that only move the code). When a finding has a file but no symbol —
 * `stale_suppressions`, `policy_violations`, `boundary_coverage_violations`
 * and `boundary_call_violations` carry only a path — the path alone would
 * collide with its siblings in the same file, so the position is appended to
 * keep them distinct, at the cost of a key that moves. An import across a
 * boundary keys on its two ends ({@link edgeFinding}), and cross-file
 * findings (cycles) on their sorted membership ({@link cycleFinding}).
 * Returns `null` when no stable identity can be read — the finding still
 * counts toward `issueCount`, it just can't be individually grandfathered
 * (which keeps the slot conservatively red, never silently green). Its file is
 * rebased from `base`.
 */
function deadFinding(category: string, item: unknown, base: PathBase): KeyedFinding | null {
  if (!isRecord(item)) return null;
  const edge = edgeFinding(category, item, base);
  if (edge !== null) return edge;
  const file = rebasePath(base, str(item['path']) || str(item['file']));
  const symbol = symbolIdentity(item);
  const where = at(item, 'line', 'col');
  if (symbol) {
    const key = `dead-code:${category}:${[file, symbol].filter(Boolean).join(':')}`;
    return finding('dead-code', item, { file, ...where, rule: category, message: symbol, key });
  }
  if (file) return finding('dead-code', item, { file, ...where, rule: category, message: '', key: withPosition(`dead-code:${category}:${file}`, item) });
  return cycleFinding(category, item, base);
}

/**
 * Top-level arrays that are NOT counted in `total_issues`, so keying them would
 * push the key count past the issue count and leave the two out of step: the
 * advisory `next_steps`, the project-level `workspace_diagnostics`, the
 * `package_baselines` a `workspaces.changedSince` config makes fallow list,
 * one per package it applied a git ref to, and the three opt-in "health
 * signal" rules that fallow's own `issue-registry.json` marks
 * `counts_in_total: false`. They have to be skipped by name rather than left
 * to {@link deadFinding}: `workspace_diagnostics` carries a `path`, and
 * `thin_wrappers` and `duplicate_prop_shapes` a `file`, so all three key
 * readily, and a `package_baselines` entry, which keys on nothing, would read
 * as a finding the keys miss and keep a baseline from masking the check.
 * Verified against fallow 3.31.0's registry and report types; every other
 * array counts.
 */
const UNCOUNTED_ARRAYS = new Set<string>([
  'next_steps',
  'workspace_diagnostics',
  'package_baselines',
  'prop_drilling_chains',
  'thin_wrappers',
  'duplicate_prop_shapes',
]);

/**
 * Every counted finding in a dead-code report — duplicate keys intact, so a
 * collision stays visible to the caller's tracking check — and the array of
 * each item that carried no stable identity to key on.
 */
function collectDeadFindings(j: Record<string, unknown>, base: PathBase): { findings: KeyedFinding[]; unkeyed: string[] } {
  const findings: KeyedFinding[] = [];
  const unkeyed: string[] = [];
  for (const [category, value] of Object.entries(j)) {
    if (!Array.isArray(value) || UNCOUNTED_ARRAYS.has(category)) continue;
    for (const item of value) {
      const found = deadFinding(category, item, base);
      if (found === null) unkeyed.push(category);
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
function parseDeadCode(j: Record<string, unknown>, base: PathBase): FallowReport {
  const summary = isRecord(j['summary']) ? j['summary'] : {};
  const total = summary['total_issues'] ?? j['total_issues'];
  if (typeof total !== 'number') {
    return { ok: false, reason: 'fallow dead-code JSON missing summary.total_issues' };
  }
  const { findings, unkeyed } = collectDeadFindings(j, base);
  // Two independent ways the keys can fail to cover the findings, both required
  // because either alone has a blind spot. Counting the items we could not key
  // is direct and exact. Comparing against the authoritative `total` catches
  // findings the iteration never reached at all (nothing to count) — and cannot
  // be substituted for the direct count, because a key produced for something
  // `total` omits would otherwise offset a real un-keyable finding back to zero.
  // `findings.length` counts keys BEFORE a set collapses collisions, so a
  // collision still reads as fully tracked.
  const fullyTracked = unkeyed.length === 0 && findings.length === total;
  return { ok: true, kind: 'dead-code', findings, issueCount: total, fullyTracked, unkeyed };
}

/** The `unkeyed` of a report whose one array, `name`, holds `items`, of which `findings` were keyed. */
function missed(name: string, items: readonly unknown[], findings: readonly KeyedFinding[]): string[] {
  return Array.from({ length: items.length - findings.length }, () => name);
}

/**
 * Extract duplication findings. Each clone group carries a content-hash
 * `fingerprint` (`dup:…`) that is stable across line moves — the ideal key,
 * which names no file. A finding names the group's first instance. The issue
 * count is the number of clone groups.
 */
function parseDupes(j: Record<string, unknown>, base: PathBase): FallowReport {
  const groups = j['clone_groups'];
  if (!Array.isArray(groups)) {
    return { ok: false, reason: 'fallow dupes JSON missing clone_groups' };
  }
  const findings: KeyedFinding[] = [];
  for (const g of groups) {
    if (!isRecord(g)) continue;
    const fp = str(g['fingerprint']);
    if (!fp) continue;
    const first: unknown = Array.isArray(g['instances']) ? g['instances'][0] : undefined;
    const instance = isRecord(first) ? first : {};
    const file = rebasePath(base, str(instance['file']));
    findings.push(finding('dupes', g, { file, ...at(instance, 'start_line', 'start_col'), rule: 'code-duplication', message: fp, key: `dupes:${fp}` }));
  }
  return { ok: true, kind: 'dupes', findings, issueCount: groups.length, fullyTracked: findings.length === groups.length, unkeyed: missed('clone_groups', groups, findings) };
}

/**
 * Extract health (complexity) findings — one per function over threshold, keyed
 * on file + function name. A named function, or a unit fallow names by what it
 * is ({@link namedUnit}), stays line-free so its key survives edits above it;
 * an anonymous placeholder (`<arrow>`, `<anonymous>`) shares its name with
 * every sibling in the file, so it gets a position appended to stay distinct.
 * The issue count is the number of findings. Each path is rebased from `base`.
 */
function parseHealth(j: Record<string, unknown>, base: PathBase): FallowReport {
  const items = j['findings'];
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'fallow health JSON missing findings' };
  }
  const findings: KeyedFinding[] = [];
  for (const f of items) {
    if (!isRecord(f)) continue;
    const name = str(f['name']);
    const file = rebasePath(base, str(f['path']));
    const key = `health:${file}:${name}`;
    findings.push(finding('health', f, { file, ...at(f, 'line', 'col'), rule: 'complexity', message: name, key: namedUnit(name, file) ? key : withPosition(key, f) }));
  }
  return { ok: true, kind: 'health', findings, issueCount: items.length, fullyTracked: findings.length === items.length, unkeyed: missed('findings', items, findings) };
}

/**
 * The reason a report's schema can't be trusted, or `null` when it is a
 * supported version. Split out so {@link parseFallowReport} stays a thin dispatcher.
 */
function fallowSchemaError(j: Record<string, unknown>): string | null {
  const schema = j['schema_version'];
  if (typeof schema !== 'number') return 'fallow JSON has no schema_version';
  if (schema < FALLOW_SCHEMA_MIN) {
    return `unsupported fallow schema_version ${schema}; checkride reads schema_version ${FALLOW_SCHEMA_MIN} and later. Upgrade fallow: \`pnpm up fallow\`.`;
  }
  return null;
}

/**
 * The first line of fallow's own error report, which it prints in place of a
 * report when it can't run at all, a `fallow.toml` holding a value it can't
 * read among the causes: an object with `error: true`, its `message` such as
 * `invalid value: integer 1000000, expected u16 in …/fallow.toml`, and
 * `exit_code: 2` (fallow 3.31.0, every subcommand alike). A TOML syntax error
 * runs to several lines, the first naming the file and the position. `null`
 * for any other payload, a report included.
 */
function fallowError(j: Record<string, unknown>): string | null {
  if (j['error'] !== true) return null;
  return str(j['message']).split('\n').map((line) => line.trim()).find(Boolean) ?? 'it gave no message';
}

/**
 * Parse a fallow report into findings + an issue count, or the reason it could
 * not be trusted. Every failure path (bad JSON, fallow's own error report,
 * missing/old schema, unknown kind, missing count field) is a *loud* failure
 * the verdict turns into a red slot — checkride never treats an unreadable
 * fallow report as "clean". Every path in a key is rebased from `base`.
 */
export function parseFallowReport(raw: string, base: PathBase): FallowReport {
  if (raw.trim() === '') return { ok: false, reason: 'fallow produced no JSON output' };
  // Tolerant of a launcher preamble ahead of the report — see `parseToolJson`.
  const parsed = parseToolJson(raw);
  if (!parsed) return { ok: false, reason: 'fallow did not emit valid JSON' };
  const j = parsed.value;
  if (!isRecord(j)) return { ok: false, reason: 'fallow output was not a JSON object' };
  const error = fallowError(j);
  if (error !== null) return { ok: false, reason: `fallow could not run: ${error}`, stopped: true };

  const schemaError = fallowSchemaError(j);
  if (schemaError !== null) return { ok: false, reason: schemaError };

  const kind = str(j['kind']);
  switch (kind) {
    case 'dead-code':
      return parseDeadCode(j, base);
    case 'dupes':
      return parseDupes(j, base);
    case 'health':
      return parseHealth(j, base);
    default:
      return { ok: false, reason: `unrecognized fallow report kind '${kind || '(missing)'}'` };
  }
}

/**
 * Fallow's parser: the findings of a recognized, readable report, and `null`
 * for anything else, since its format can tell an unreadable report from a
 * clean one. The fallow verdict is where an unreadable report becomes a
 * failure; a capture records nothing for it, as for vale's runtime error.
 */
export const fallowParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const report = parseFallowReport(raw, context);
    return report.ok ? report.findings : null;
  },
};
