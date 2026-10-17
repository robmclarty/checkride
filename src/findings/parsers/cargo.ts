/**
 * cargo `--message-format=json`, which `cargo clippy` and `cargo check` share:
 * one object per line, each diagnostic a `compiler-message` record carrying
 * `message: { level, code: { code }, message, spans: [{ file_name, line_start,
 * column_start, is_primary }] }`, its line and column 1-based, and a last
 * `build-finished` record. A span's path is relative to the workspace root,
 * which a rust target's root is.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, jsonLines, located, oneBased, str } from '../read.js';
import type { KeyedFinding, ParseContext, Parser } from '../types.js';

/** Where a diagnostic points: its first primary span, or `{}` when it has none. */
function primarySpan(message: Record<string, unknown>): Record<string, unknown> {
  const span = asArray(message['spans']).find((s) => isRecord(s) && s['is_primary'] === true);
  return isRecord(span) ? span : {};
}

/**
 * The finding one `compiler-message` record carries, or `null` when it carries
 * none. A diagnostic gates when its level is `error`, which `-D warnings`
 * makes every warning, or an internal compiler error's `error: …`. One with
 * no span is a finding only when it gates, with no file, so a spanless error
 * still fails a baseline that grandfathers the rest, while a spanless
 * `failure-note` pointing at `rustc --explain` is no finding at all.
 */
function compilerFinding(record: Record<string, unknown>, context: ParseContext): KeyedFinding | null {
  const message = isRecord(record['message']) ? record['message'] : {};
  const text = str(message['message']);
  const level = str(message['level']);
  const gates = level.startsWith('error');
  const span = primarySpan(message);
  const file = str(span['file_name']);
  if (!text || (!file && !gates)) return null;
  const code = isRecord(message['code']) ? str(message['code']['code']) : '';
  const path = rebasePath(context, file);
  return {
    file: path,
    ...located(oneBased(span['line_start'], 1), oneBased(span['column_start'], 1)),
    rule: code,
    message: text,
    ...(level ? { severity: level } : {}),
    gates,
    key: findingKey(path, code, text),
  };
}

/**
 * Every diagnostic a cargo build reported, once. cargo compiles a crate once
 * per target (`lib` and its `lib test`, say) and reports the same diagnostic
 * for each, so a repeat at the same place is dropped.
 *
 * Returns `null` for output with no `build-finished` record: a build that
 * ended early, or a manifest cargo couldn't read, reported only part of what
 * it would have found, and reading that as complete would let the ratchet
 * prune keys it never checked.
 */
function parseCargo(raw: string, context: ParseContext): KeyedFinding[] | null {
  const records = jsonLines(raw).filter(isRecord);
  if (!records.some((r) => r['reason'] === 'build-finished')) return null;
  const seen = new Set<string>();
  const findings: KeyedFinding[] = [];
  for (const record of records) {
    if (record['reason'] !== 'compiler-message') continue;
    const finding = compilerFinding(record, context);
    if (finding === null) continue;
    const identity = JSON.stringify([finding.key, finding.line, finding.column, finding.severity]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    findings.push(finding);
  }
  return findings;
}

/** `cargo clippy --message-format=json`, the rust pack's `lint`. */
export const clippyParser: Parser = { stream: 'artifact', parse: parseCargo };

/**
 * `cargo check --message-format=json`, the rust pack's `types`: the same
 * format, served to `checkride/findings` but never keyed into the baseline,
 * since type errors aren't grandfathered (D31).
 */
export const cargoCheckParser: Parser = { stream: 'artifact', parse: parseCargo, parseOnly: true };
