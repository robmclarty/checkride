/**
 * tsc's plain diagnostics, on stdout when it isn't writing to a terminal: one
 * `<file>(<line>,<col>): error TS<code>: <message>` line per diagnostic, its
 * line and column 1-based and its path relative to the check's root, and a
 * diagnostic with no file (a missing project) as `error TS<code>: <message>`.
 * A chained message continues on the lines after, each indented.
 */

import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased } from '../read.js';
import type { KeyedFinding, ParseContext, Parser } from '../types.js';

/**
 * One diagnostic's first line: an optional `<file>(<line>,<col>): ` place,
 * absent for a diagnostic with no file, then its category, code and message.
 */
const DIAGNOSTIC = /^(?:(.+)\((\d+),(\d+)\): )?(error|warning|message) (TS\d+): (.*)$/;

/** One diagnostic as read so far: its first line's fields, and the message its continuations extend. */
type Diagnostic = { file: string; line?: number; column?: number; rule: string; severity: string; message: string };

/** The diagnostic a line opens, or `null` when it opens none. */
function opened(line: string, context: ParseContext): Diagnostic | null {
  const m = DIAGNOSTIC.exec(line);
  if (!m) return null;
  const [, path, row, column, severity = '', rule = '', message = ''] = m;
  const file = path === undefined ? '' : rebasePath(context, path);
  return { file, ...located(oneBased(row, 1), oneBased(column, 1)), rule, severity, message };
}

/**
 * Every diagnostic, keyed on its `TS` code, a chained message kept whole with
 * the indented lines that directly follow it; any other line closes it, so a
 * `--verbose` build's own indented lists join no diagnostic. Every diagnostic
 * fails the build. Served to `checkride/findings` but never keyed into the
 * baseline, since type errors aren't grandfathered (D31).
 */
export const tscParser: Parser = {
  stream: 'stdout',
  parseOnly: true,
  parse: (raw, context) => {
    const diagnostics: Diagnostic[] = [];
    let open: Diagnostic | null = null;
    for (const line of raw.split('\n')) {
      if (open !== null && /^\s+\S/.test(line)) {
        open.message = `${open.message}\n${line.trimEnd()}`;
        continue;
      }
      open = opened(line.trimEnd(), context);
      if (open !== null) diagnostics.push(open);
    }
    return diagnostics.map((d): KeyedFinding => ({ ...d, gates: true, key: findingKey(d.file, d.rule, d.message) }));
  },
};
