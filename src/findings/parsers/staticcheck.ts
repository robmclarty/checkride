/**
 * staticcheck `-f json`: one `{ code, severity, location: { file, line, column },
 * message }` object per line, its line and column 1-based. Its paths are
 * absolute, so a finding names its file from the repo root only when the
 * caller passes `repoRoot` (R12.4).
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { jsonLines, located, oneBased, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Every problem that carries a message, keyed on its check code. A problem
 * gates unless its severity is `ignored`, the one staticcheck reports without
 * failing the run.
 *
 * A package that doesn't compile is one `compile` problem with an empty
 * location, which still fails the run, so it stays a finding with no file:
 * dropping it would leave a run red from a compile error looking clean to a
 * baseline that grandfathers the rest.
 */
export const staticcheckParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const findings: KeyedFinding[] = [];
    for (const problem of jsonLines(raw)) {
      if (!isRecord(problem)) continue;
      const message = str(problem['message']);
      if (!message) continue;
      const location = isRecord(problem['location']) ? problem['location'] : {};
      const rule = str(problem['code']);
      const severity = str(problem['severity']);
      const path = rebasePath(context, str(location['file']));
      findings.push({
        file: path,
        ...located(oneBased(location['line'], 1), oneBased(location['column'], 1)),
        rule,
        message,
        ...(severity ? { severity } : {}),
        gates: severity !== 'ignored',
        key: findingKey(path, rule, message),
      });
    }
    return findings;
  },
};
