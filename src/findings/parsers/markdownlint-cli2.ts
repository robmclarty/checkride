/**
 * markdownlint-cli2's default formatter, on stderr: one
 * `<file>:<line>[:<col>] <severity> <rule>/<alias>… <description> [<detail>]
 * [Context: "…"]` line per finding, its line and column 1-based, the column
 * absent when the rule names a whole line.
 */

import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased } from '../read.js';
import type { KeyedFinding, ParseContext, Parser } from '../types.js';

/** One finding line: file, line, optional column, severity, rule names, then the rest. */
const FINDING_LINE = /^(.+?):(\d+)(?::(\d+))? (error|warning) (\S+) (.+)$/;

/** The finding one line of stderr carries, or `null` when it carries none. */
function lineFinding(line: string, context: ParseContext): KeyedFinding | null {
  const m = FINDING_LINE.exec(line);
  if (!m) return null;
  const [, path = '', row, column, severity = '', names = '', message = ''] = m;
  const file = rebasePath(context, path);
  const rule = names.split('/')[0] ?? '';
  return {
    file,
    ...located(oneBased(row, 1), oneBased(column, 1)),
    rule,
    message,
    severity,
    gates: severity === 'error',
    key: findingKey(file, rule, message),
  };
}

/**
 * Every finding line, keyed on its first rule name (`MD018` of
 * `MD018/no-missing-space-atx`), its description, detail and context the
 * message. Only `error` findings gate: a rule configured as `"warning"`
 * prints as one and leaves the exit code 0, as markdownlint-cli2 0.23.3 does.
 *
 * Returns `null` when stderr holds text but not one finding line: a config
 * markdownlint-cli2 can't load prints an `Error:` and its stack there instead,
 * and reading that as clean would let the ratchet prune every grandfathered
 * key. A clean run leaves stderr empty.
 */
export const markdownlintCli2Parser: Parser = {
  stream: 'stderr',
  parse: (raw, context) => {
    const findings: KeyedFinding[] = [];
    for (const line of raw.split('\n')) {
      const finding = lineFinding(line.trim(), context);
      if (finding !== null) findings.push(finding);
    }
    return findings.length === 0 && raw.trim() !== '' ? null : findings;
  },
};
