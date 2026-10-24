/**
 * `go build -json`: one event per line, each package's compiler output a
 * series of `{ ImportPath, Action: "build-output", Output }` events, a
 * `# <package>` header first, then one `<file>:<line>[:<col>]: <message>` line
 * per error, its line and column 1-based and its path relative to the check's
 * root. An error's further lines follow it indented, such as the
 * `go get <module>` a missing module suggests.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { jsonLines, located, oneBased, str } from '../read.js';
import type { KeyedFinding, ParseContext, Parser } from '../types.js';

/** An error in a file: path, line, optional column, message. */
const LOCATED = /^(.+?):(\d+)(?::(\d+))?: (.+)$/;

/** A line that is go's own framing, never an error: a package header, or the cap on how many it prints. */
const FRAMING = /^(# \S+|too many errors)$/;

/** One error as read so far: its first line's fields, and the message its continuations extend. */
type BuildError = { file: string; line?: number; column?: number; message: string };

/** The error a line opens: located when it names a file, else one with no file. */
function opened(line: string, context: ParseContext): BuildError {
  const at = LOCATED.exec(line);
  if (!at) return { file: '', message: line };
  return { file: rebasePath(context, at[1] ?? ''), ...located(oneBased(at[2], 1), oneBased(at[3], 1)), message: at[4] ?? '' };
}

/**
 * Each line the build printed, beside the package that printed it. An event's
 * output ends on a newline, so its blank tail is dropped: the package's next
 * event can carry a continuation of the error before it.
 */
function outputLines(raw: string): [string, string][] {
  return jsonLines(raw)
    .filter((e): e is Record<string, unknown> => isRecord(e) && e['Action'] === 'build-output')
    .flatMap((e) => str(e['Output']).split('\n').map((line): [string, string] => [str(e['ImportPath']), line]))
    .filter(([, line]) => line.trim() !== '');
}

/**
 * Every error the build printed, an indented line joined onto the error
 * before it in the same package. go names no rule, so each rule is `''`, and
 * every error fails the build. A line that names no file, such as a package
 * go can't load, is an error with no file. Served to `checkride/findings` but
 * never keyed into the baseline: go stops at ten errors in a package and
 * builds no package that imports a broken one, so a run can't say which of
 * the errors it didn't print were fixed.
 */
export const goBuildParser: Parser = {
  stream: 'artifact',
  parseOnly: true,
  parse: (raw, context) => {
    const errors: BuildError[] = [];
    const open = new Map<string, BuildError>();
    for (const [pkg, line] of outputLines(raw)) {
      const last = open.get(pkg);
      if (last !== undefined && /^\s/.test(line)) {
        last.message = `${last.message}\n${line.trimEnd()}`;
        continue;
      }
      open.delete(pkg);
      if (FRAMING.test(line.trim())) continue;
      const next = opened(line.trim(), context);
      errors.push(next);
      open.set(pkg, next);
    }
    return errors.map((e): KeyedFinding => ({ ...e, rule: '', gates: true, key: findingKey(e.file, '', e.message) }));
  },
};
