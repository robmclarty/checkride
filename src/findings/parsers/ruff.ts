/**
 * ruff `check --output-format=json`: an array of `{ code, message, filename,
 * location: { row, column }, severity }` objects, its row and column 1-based
 * and its `filename` absolute, the real path with every symlink resolved, so
 * a finding names its file from the repo root only when the caller passes
 * `repoRoot` (R12.4). A syntax error is a finding like any other, its code
 * `invalid-syntax`.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased, parseJson, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Every violation that names a file and a message, keyed on its rule code.
 * ruff exits 1 on any violation, so every one gates.
 *
 * Returns `null` for output that isn't an array: a clean run prints `[]`,
 * while a config ruff can't load prints nothing on stdout, and reading that
 * as clean would let the ratchet prune every grandfathered key.
 */
export const ruffParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!Array.isArray(payload)) return null;
    const findings: KeyedFinding[] = [];
    for (const violation of payload) {
      if (!isRecord(violation)) continue;
      const file = str(violation['filename']);
      const message = str(violation['message']);
      if (!file || !message) continue;
      const location = isRecord(violation['location']) ? violation['location'] : {};
      const rule = str(violation['code']);
      const severity = str(violation['severity']);
      const path = rebasePath(context, file);
      findings.push({
        file: path,
        ...located(oneBased(location['row'], 1), oneBased(location['column'], 1)),
        rule,
        message,
        ...(severity ? { severity } : {}),
        gates: true,
        key: findingKey(path, rule, message),
      });
    }
    return findings;
  },
};
