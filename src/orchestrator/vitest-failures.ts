/**
 * What a red vitest run says failed, read from what its default reporter
 * prints on stderr, for the excerpt beneath its status line: a tail of that
 * stream ends in a code frame, and names neither the test nor its error.
 *
 * It is a reader's view for display alone, as the `go test` one is. It is not
 * a findings parser: vitest stays unparseable to `checkride/findings`, feeds
 * no baseline, and nothing here reaches the summary or the digest. It reads
 * the reporter's text, which is no contract of vitest's, so a run it reads no
 * failure in (another reporter, a crash before any test ran, a later format)
 * yields none, and its caller falls back to the streams' last lines.
 *
 * The shapes it reads, checked against vitest 5.0.3:
 *
 * - a failed test, ` FAIL  <file> > <suite> > <test>`, then its error line;
 * - a failed suite, ` FAIL  <file> [ <file> ]`, a file that threw as it was
 *   imported, then its error line;
 * - tests that failed on one error, which vitest prints as their ` FAIL `
 *   lines one after another above the error they share;
 * - an error outside any test, under `⎯⎯ Unhandled Rejection ⎯⎯`,
 *   `⎯⎯ Uncaught Exception ⎯⎯` or `⎯⎯ Unhandled Error ⎯⎯`, then its error
 *   line.
 */

import { stripVTControlCharacters } from 'node:util';

/** One failure: what failed, as the reporter names it, and the first line of its error, `''` when it printed none. */
export type VitestFailure = { name: string; error: string };

/** A failed test's or suite's line, its badge's colour already stripped: ` FAIL  <what failed>`. */
const FAIL_LINE = /^ FAIL {2}(\S.*)$/;

/** The rule vitest prints above an error thrown outside any test, which names its kind. */
const UNHANDLED_RULE = /^⎯+ (Unhandled Rejection|Uncaught Exception|Unhandled Error) ⎯+$/;

/**
 * What a line opens a failure with, or `null` for any other line. Only a line
 * that could be one is stripped of its escape sequences, since a run's stderr
 * can be long and nearly all of it is diffs and code frames.
 */
function opened(raw: string): string | null {
  if (!raw.includes('FAIL') && !raw.includes('Unhandled') && !raw.includes('Uncaught')) return null;
  const line = stripVTControlCharacters(raw).trimEnd();
  return FAIL_LINE.exec(line)?.[1] ?? UNHANDLED_RULE.exec(line)?.[1] ?? null;
}

/**
 * The failures a vitest run printed on `stderr`, in the order it printed
 * them. Each one's error is the first line after it that holds anything and
 * isn't another failure's opening line, so tests that share an error each
 * carry it. A rule (`⎯⎯⎯[1/6]⎯`) is never an error line: it ends a block
 * that printed none.
 */
export function vitestFailures(stderr: string): VitestFailure[] {
  const failures: VitestFailure[] = [];
  let waiting = 0;
  for (const raw of stderr.split('\n')) {
    const name = opened(raw);
    if (name !== null) {
      failures.push({ name, error: '' });
    } else if (waiting < failures.length && raw.trim() !== '') {
      const error = stripVTControlCharacters(raw).trim();
      for (const failure of failures.slice(waiting)) failure.error = error.startsWith('⎯') ? '' : error;
      waiting = failures.length;
    }
  }
  return failures;
}
