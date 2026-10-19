/**
 * ast-grep `--json=compact`: an array of `{ file, ruleId, message, severity,
 * range: { start: { line, column } } }`, its line and column 0-based.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, Parser } from '../types.js';

/** ast-grep severities that never fail a scan on their own; any other value gates. */
const AST_GREP_ADVISORY: ReadonlySet<string> = new Set(['warning', 'info', 'hint']);

/**
 * The rules an ast-grep argv raises to `error`: `'all'` for a bare `--error`,
 * else the ids each `--error=<id>[,<id>]` names. ast-grep already reports a
 * raised rule as `severity: "error"`, so this guards a version that doesn't.
 * An argv that hides ast-grep's flags, or none at all, raises every rule:
 * keying a match that can't fail costs a false red, while skipping one that
 * can would mask a red run green.
 */
function astGrepRaised(argv: Argv): ReadonlySet<string> | 'all' {
  if (argv === undefined || !runsTool(argv, ['ast-grep', 'sg'])) return 'all';
  const rules = new Set<string>();
  for (const arg of argv) {
    if (arg === '--error') return 'all';
    if (!arg.startsWith('--error=')) continue;
    const ids = arg.slice('--error='.length).split(',').filter(Boolean);
    if (ids.length === 0) return 'all';
    for (const id of ids) rules.add(id);
  }
  return rules;
}

/** Where a match starts, or `{}` when it carries no range. */
function rangeStart(m: Record<string, unknown>): Record<string, unknown> {
  const range = m['range'];
  return isRecord(range) && isRecord(range['start']) ? range['start'] : {};
}

/**
 * Every match that names a file and a message. One that can only advise is
 * marked as not gating, for the reason the oxlint parser gives.
 *
 * Returns `null` for output that isn't an array, as the ruff parser does: a
 * clean scan prints `[]`, and anything else is a scan that never finished.
 */
export const astGrepParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!Array.isArray(payload)) return null;
    const findings: KeyedFinding[] = [];
    const raised = astGrepRaised(context.argv);
    for (const m of asArray(payload)) {
      if (!isRecord(m)) continue;
      const file = str(m['file']);
      const message = str(m['message']);
      if (!file || !message) continue;
      const rule = str(m['ruleId']);
      const severity = str(m['severity']);
      const path = rebasePath(context, file);
      const start = rangeStart(m);
      findings.push({
        file: path,
        ...located(oneBased(start['line'], 0), oneBased(start['column'], 0)),
        rule,
        message,
        ...(severity ? { severity } : {}),
        gates: raised === 'all' || raised.has(rule) || !AST_GREP_ADVISORY.has(severity),
        key: findingKey(path, rule, message),
      });
    }
    return findings;
  },
};
