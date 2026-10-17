/**
 * golangci-lint `--output.json.path=stdout`: `{ Issues: [{ FromLinter, Text,
 * Severity, Pos: { Filename, Line, Column } }], Report }`, its line and column
 * 1-based, a column of 0 meaning none (a `typecheck` issue that wraps a
 * compiler error names line 1, column 0).
 *
 * Paths are relative to the directory of the config file golangci-lint
 * loaded, by v2's default `relative-path-mode: cfg`. The adapter is detected
 * by that config file in the target's root, so they read as relative to the
 * check's root.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Every issue that names a file and a message, keyed on the linter that
 * reported it. golangci-lint exits non-zero on any issue whatever its
 * `Severity`, so every issue gates.
 *
 * Returns `null` for output that holds no `Issues` array: a run that finished
 * prints one, empty when clean, while a config it can't load prints nothing
 * on stdout, and reading that as clean would let the ratchet prune every
 * grandfathered key.
 */
export const golangciLintParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !Array.isArray(payload['Issues'])) return null;
    const findings: KeyedFinding[] = [];
    for (const issue of asArray(payload['Issues'])) {
      if (!isRecord(issue)) continue;
      const pos = isRecord(issue['Pos']) ? issue['Pos'] : {};
      const file = str(pos['Filename']);
      const message = str(issue['Text']);
      if (!file || !message) continue;
      const rule = str(issue['FromLinter']);
      const severity = str(issue['Severity']);
      const path = rebasePath(context, file);
      findings.push({
        file: path,
        ...located(oneBased(pos['Line'], 1), oneBased(pos['Column'], 1)),
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
