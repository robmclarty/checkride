/**
 * oxlint `--format=json`: `{ diagnostics: [{ filename, code, message, severity,
 * labels: [{ span: { line, column } }] }] }`, its line and column 1-based.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, Parser } from '../types.js';

/** oxlint severities that never fail a run on their own; any other value gates. */
const OXLINT_ADVISORY: ReadonlySet<string> = new Set(['warning', 'advice']);

/**
 * Whether every oxlint diagnostic can fail the run, not only `error` ones.
 * `--deny-warnings` and `--max-warnings` make warnings gate while each still
 * reports `severity: "warning"`, so only the argv shows them. An argv that
 * hides oxlint's flags, or none at all, counts as gating everything: keying a
 * warning that can't fail costs a false red, while skipping one that can
 * would mask a red run green.
 */
function oxlintWarningsGate(argv: Argv): boolean {
  if (argv === undefined || !runsTool(argv, ['oxlint'])) return true;
  return argv.some((arg) => arg === '--deny-warnings' || arg === '--max-warnings' || arg.startsWith('--max-warnings='));
}

/** A diagnostic's first labelled span, where oxlint places it, or `{}` when it has none. */
function firstSpan(d: Record<string, unknown>): Record<string, unknown> {
  const [label] = asArray(d['labels']);
  return isRecord(label) && isRecord(label['span']) ? label['span'] : {};
}

/**
 * Every diagnostic that names a file and a message. One that can only advise
 * is marked as not gating, so the baseline doesn't key it: an advisory
 * warning's key would block masking when it first appears on an otherwise
 * grandfathered red run, though it could never fail the check itself.
 */
export const oxlintParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const findings: KeyedFinding[] = [];
    const all = oxlintWarningsGate(context.argv);
    const payload = parseJson(raw);
    const diagnostics = isRecord(payload) ? asArray(payload['diagnostics']) : [];
    for (const d of diagnostics) {
      if (!isRecord(d)) continue;
      const file = str(d['filename']);
      const message = str(d['message']);
      if (!file || !message) continue;
      const severity = str(d['severity']);
      const rule = str(d['code']);
      const path = rebasePath(context, file);
      const span = firstSpan(d);
      findings.push({
        file: path,
        ...located(oneBased(span['line'], 1), oneBased(span['column'], 1)),
        rule,
        message,
        ...(severity ? { severity } : {}),
        gates: all || !OXLINT_ADVISORY.has(severity),
        key: findingKey(path, rule, message),
      });
    }
    return findings;
  },
};
