/**
 * Reading a failing check's raw output down to an excerpt: the files that
 * hold all of it, its last lines, and a list held to a cap. The digest's
 * sections and the excerpt a run prints beneath a red check's status line
 * both name a check's file through {@link rawPointer} and count lines through
 * {@link lastLines}, so they agree on which file holds a tool's findings and
 * on what a line is. They don't agree on which stream to excerpt where a
 * tool has no parser: the digest tails stdout when it holds anything, and the
 * terminal shows both streams, naming both files.
 */

import { artifactStem, SUMMARY_FILE } from '../artifacts/index.js';
import { parserFor } from '../findings/index.js';
import type { CheckOutcome } from '../links.js';
import type { SummaryCheck } from '../orchestrator/index.js';

/**
 * The output-directory paths a failed check's two streams were persisted to,
 * under `label` as an agent would type them, and matched to how
 * `persistOutput` in `../orchestrator/execute.ts` wrote them: stdout in the
 * file the summary names as `output_file` when the run wrote one, else
 * `<slot>.stdout.txt`, and stderr in `<slot>.stderr.txt`, a target's check
 * under its `<target>/` directory. `null` for a stream the check left empty,
 * which has no file.
 */
export function streamFiles(check: SummaryCheck, outcome: CheckOutcome, label: string): { stdout: string | null; stderr: string | null } {
  const stem = artifactStem(check);
  const text = outcome.stdout.trim() ? `${label}/${stem}.stdout.txt` : null;
  return {
    stdout: check.output_file !== null ? `${label}/${check.output_file}` : text,
    stderr: outcome.stderr.trim() ? `${label}/${stem}.stderr.txt` : null,
  };
}

/**
 * The one file to open for a failed check's full diagnostics
 * (`.check/lint.json`): the stream its tool's parser reads, so a tool that
 * prints its findings on stderr, as markdownlint-cli2 does, is pointed at
 * `<slot>.stderr.txt` whatever its stdout holds; for any other, stdout's file
 * when it wrote one, else stderr's; and the summary for a check that wrote
 * neither.
 */
export function rawPointer(check: SummaryCheck, outcome: CheckOutcome, label: string): string {
  const files = streamFiles(check, outcome, label);
  const onStderr = check.adapter !== null && parserFor(check.adapter)?.stream === 'stderr';
  if (onStderr && files.stderr !== null) return files.stderr;
  return files.stdout ?? files.stderr ?? `${label}/${SUMMARY_FILE}`;
}

/**
 * The last `max` lines of `text` that hold anything but whitespace, where a
 * compiler or a test runner puts its summary, and how many such lines there
 * are in all.
 */
export function lastLines(text: string, max: number): { lines: string[]; total: number } {
  const all = text.split('\n').filter((line) => line.trim() !== '');
  return { lines: all.slice(-max), total: all.length };
}

/** Up to `max` of `items`, then the line `more` makes of how many were left out, when any were. */
export function capped(items: readonly string[], max: number, more: (left: number) => string): string[] {
  const lines = items.slice(0, max);
  return items.length > max ? [...lines, more(items.length - max)] : lines;
}
