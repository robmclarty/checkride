/**
 * typos `--format brief`, on stdout: one `./<file>:<line>:<col>: error:
 * <message>` line per misspelling, its line and column 1-based and its path
 * opening on `./`, relative to the check's root. A misspelled file name
 * prints as a bare `error: <message>`, naming no path at all.
 */

import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased } from '../read.js';
import type { KeyedFinding, ParseContext, Parser } from '../types.js';

/**
 * One misspelling: an optional `<path>:<line>:<col>: ` place, absent for a
 * misspelled file name, then its level and message.
 */
const TYPO_LINE = /^(?:(.+?):(\d+):(\d+): )?(error|warning): (.+)$/;

/** The finding one line of output carries, or `null` when it carries none. */
function typoFinding(line: string, context: ParseContext): KeyedFinding | null {
  const m = TYPO_LINE.exec(line);
  if (!m) return null;
  const [, path, row, column, severity = '', message = ''] = m;
  const file = path === undefined ? '' : rebasePath(context, path.replace(/^\.\//, ''));
  return { file, ...located(oneBased(row, 1), oneBased(column, 1)), rule: '', message, severity, gates: true, key: findingKey(file, '', message) };
}

/**
 * typos names no rule, so each finding's rule is `''`, and every misspelling
 * fails the run. A misspelled file name stays a finding with no file, since
 * it fails the run too, and dropping it would leave a run red from it looking
 * clean to a baseline that grandfathers the rest. The `./` typos opens a path
 * with is dropped, so a file is named as every other tool names it.
 */
export const typosParser: Parser = {
  stream: 'stdout',
  parse: (raw, context) => {
    const findings: KeyedFinding[] = [];
    for (const line of raw.split('\n')) {
      const finding = typoFinding(line.trim(), context);
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};
