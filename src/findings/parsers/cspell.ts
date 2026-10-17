/**
 * cspell's default reporter: one `<file>:<line>:<col> - <message>` line per
 * unknown word, on stdout, its line and column 1-based.
 */

import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/** cspell default reporter line: `<file>:<line>:<col> - <message>`. */
const CSPELL_LINE = /^(.+?):(\d+):(\d+) - (.+)$/;

/**
 * cspell names no rule, so each finding's rule is `''` and its key is
 * `<file>::<message>`. Every unknown word fails the run.
 */
export const cspellParser: Parser = {
  stream: 'stdout',
  parse: (raw, context) => {
    const findings: KeyedFinding[] = [];
    for (const line of raw.split('\n')) {
      const m = CSPELL_LINE.exec(line.trim());
      if (!m) continue;
      const file = rebasePath(context, m[1] ?? '');
      const message = m[4] ?? '';
      const at = located(oneBased(m[2], 1), oneBased(m[3], 1));
      findings.push({ file, ...at, rule: '', message, gates: true, key: findingKey(file, '', message) });
    }
    return findings;
  },
};
