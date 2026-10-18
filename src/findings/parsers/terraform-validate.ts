/**
 * `terraform validate -json`, and OpenTofu's alike: `{ valid, diagnostics:
 * [{ severity, summary, detail, range: { filename, start: { line, column } }
 * }] }`, its line and column 1-based and its `filename` relative to the root
 * module, a child module's file included. A diagnostic names no rule, and one
 * about the configuration as a whole, such as a provider `init` hasn't
 * installed, gives no range.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/** Where a diagnostic sits: its file, and where it starts, each `{}` when it gives no range. */
function rangeOf(diagnostic: Record<string, unknown>): { file: string; start: Record<string, unknown> } {
  const range = isRecord(diagnostic['range']) ? diagnostic['range'] : {};
  return { file: str(range['filename']), start: isRecord(range['start']) ? range['start'] : {} };
}

/**
 * Every diagnostic with a summary, its message the summary followed by its
 * detail, which says what the summary is about. An error gates, since it's
 * what exits 1, and a warning never does. Served to `checkride/findings` but
 * never keyed into the baseline, since type errors aren't grandfathered
 * (D31). A diagnostic with no range stays a finding with no file.
 *
 * Returns `null` for output with no `diagnostics` list: a run that finished
 * prints one, empty when the configuration is valid, while one that couldn't
 * load it prints none.
 */
export const terraformValidateParser: Parser = {
  stream: 'artifact',
  parseOnly: true,
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !Array.isArray(payload['diagnostics'])) return null;
    const findings: KeyedFinding[] = [];
    for (const diagnostic of asArray(payload['diagnostics'])) {
      if (!isRecord(diagnostic)) continue;
      const summary = str(diagnostic['summary']);
      if (!summary) continue;
      const detail = str(diagnostic['detail']);
      const message = detail ? `${summary}: ${detail}` : summary;
      const severity = str(diagnostic['severity']);
      const { file, start } = rangeOf(diagnostic);
      const path = rebasePath(context, file);
      findings.push({
        file: path,
        ...located(oneBased(start['line'], 1), oneBased(start['column'], 1)),
        rule: '',
        message,
        ...(severity ? { severity } : {}),
        gates: severity === 'error',
        key: findingKey(path, '', message),
      });
    }
    return findings;
  },
};
