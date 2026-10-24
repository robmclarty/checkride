/**
 * mypy `--output json`: one `{ file, line, column, message, hint, code,
 * severity }` object per line, its line 1-based and its column 0-based, each
 * -1 when unknown, and its path relative to the check's root. A note at an
 * error's place rides on that error as its `hint`; a note with no error, such
 * as `reveal_type`'s, is a line of its own with severity `note`. A clean run
 * prints a blank line.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { jsonLines, located, oneBased, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Every error and note that carries a message, keyed on its error code. An
 * error gates and a note doesn't, since mypy exits 0 on notes alone. A line
 * that isn't JSON is passed over, so a stray print hides none of the rest.
 * Served to `checkride/findings` but never keyed into the baseline: a
 * blocking error, as a syntax error or a module shadowing the standard
 * library's is, stops mypy part way, so a run with one can't say which of the
 * errors it never reached were fixed. Checked against mypy 2.4.0.
 */
export const mypyParser: Parser = {
  stream: 'artifact',
  parseOnly: true,
  parse: (raw, context) => {
    const findings: KeyedFinding[] = [];
    for (const error of jsonLines(raw)) {
      if (!isRecord(error)) continue;
      const message = str(error['message']);
      if (!message) continue;
      const rule = str(error['code']);
      const severity = str(error['severity']);
      const path = rebasePath(context, str(error['file']));
      findings.push({
        file: path,
        ...located(oneBased(error['line'], 1), oneBased(error['column'], 0)),
        rule,
        message,
        ...(severity ? { severity } : {}),
        gates: severity === 'error',
        key: findingKey(path, rule, message),
      });
    }
    return findings;
  },
};
