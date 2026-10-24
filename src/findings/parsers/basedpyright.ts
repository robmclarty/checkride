/**
 * basedpyright `--outputjson`: `{ generalDiagnostics: [{ file, severity,
 * message, range: { start: { line, character } }, rule }], summary }`, its
 * line and character 0-based and its `file` absolute, the real path with
 * every symlink resolved, so a finding names its file from the repo root
 * only when the caller passes `repoRoot` (R12.4). A message can run over
 * several lines, and a syntax error names no rule.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, Parser } from '../types.js';

/**
 * Whether a diagnostic of `severity` fails the run: an error always, and an
 * `information` never. A warning fails it under `--warnings`, and also where
 * the config sets `failOnWarnings`, which basedpyright's default
 * `recommended` mode does (checked against 1.40.2), so without the flag the
 * argv can't say, and the finding's `gates` is left out.
 */
function gatesAt(severity: string, argv: Argv): boolean | undefined {
  if (severity === 'error') return true;
  if (severity !== 'warning') return false;
  return argv !== undefined && runsTool(argv, ['basedpyright']) && argv.includes('--warnings') ? true : undefined;
}

/** Where a diagnostic starts, or `{}` when it gives no range. */
function start(diagnostic: Record<string, unknown>): Record<string, unknown> {
  const range = isRecord(diagnostic['range']) ? diagnostic['range'] : {};
  return isRecord(range['start']) ? range['start'] : {};
}

/**
 * Every diagnostic that carries a message, keyed on its rule. Served to
 * `checkride/findings` but never keyed into the baseline: past a syntax
 * error, basedpyright can lose the rest of that file's errors to its parser's
 * recovery, so a run with one can't say which of them were fixed.
 *
 * Returns `null` for output with no `generalDiagnostics` array: a run that
 * finished prints one, empty when clean, while one that couldn't start prints
 * none.
 */
export const basedpyrightParser: Parser = {
  stream: 'artifact',
  parseOnly: true,
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !Array.isArray(payload['generalDiagnostics'])) return null;
    const findings: KeyedFinding[] = [];
    for (const diagnostic of asArray(payload['generalDiagnostics'])) {
      if (!isRecord(diagnostic)) continue;
      const message = str(diagnostic['message']);
      if (!message) continue;
      const rule = str(diagnostic['rule']);
      const severity = str(diagnostic['severity']);
      const path = rebasePath(context, str(diagnostic['file']));
      const at = start(diagnostic);
      const gates = gatesAt(severity, context.argv);
      findings.push({
        file: path,
        ...located(oneBased(at['line'], 0), oneBased(at['character'], 0)),
        rule,
        message,
        ...(severity ? { severity } : {}),
        ...(gates !== undefined ? { gates } : {}),
        key: findingKey(path, rule, message),
      });
    }
    return findings;
  },
};
