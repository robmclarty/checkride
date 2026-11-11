/**
 * What a red check prints beneath its status line to say why: a short, bounded
 * excerpt of its cause, then one line naming the file that holds all of its
 * output. The excerpt is the first of these that applies: a `go test` run's
 * failing tests, with the last lines they printed; a vitest run's failing
 * tests, each with its error; where the check's tool has
 * a parser, its first findings that can fail it, one line each; and otherwise
 * the last lines the tool printed, from whichever stream holds any, and from
 * both when both do. A check whose cause the lines above already state (a
 * refusal, a run that reached no verdict, a list of its new findings) gets
 * the pointer alone.
 *
 * It bounds through the digest's helpers (`rawPointer`, `streamFiles`,
 * `lastLines`, `capped`), so the file it names for a tool's findings and the
 * lines it counts are the digest's. Pure over its inputs: nothing here reads
 * the filesystem.
 */

import { stripVTControlCharacters } from 'node:util';

import { findingText, gatingFindings } from '../baseline/index.js';
import type { GoTestCase } from '../digest/index.js';
import { capped, caseName, goTestReport, lastLines, rawPointer, streamFiles } from '../digest/index.js';
import type { KeyedFinding } from '../findings/index.js';
import { parseToolJson, parseToolJsonLines } from '../tool-json.js';
import { REPORT_INDENT } from './report.js';
import type { CheckRun, SummaryCheck } from './types.js';
import { vitestFailures } from './vitest-failures.js';

/** How many findings an excerpt lists before it counts the rest. */
export const EXCERPT_FINDINGS = 5;

/** How many of a tool's last lines an excerpt shows in all, where it has no finding to list. */
export const EXCERPT_TAIL_LINES = 8;

/** How long an excerpt's line runs before it's cut, marked `…`. */
export const EXCERPT_LINE_CHARS = 200;

/** How many of a vitest run's failures an excerpt names, each on two lines, before it counts the rest. */
const EXCERPT_VITEST_FAILURES = 4;

/** How many failing or unfinished tests a red go-test check names, of each. */
const TESTS_NAMED = 10;

/**
 * How much of a stream's end is read for its last lines. A stream can run to
 * megabytes, and only its end is shown, so only that much is cleaned of
 * escape sequences: room for {@link EXCERPT_TAIL_LINES} lines many times
 * over, blank ones between them included.
 */
const TAIL_WINDOW_CHARS = 16_384;

/**
 * A failed check and how its output is read: its run and summary entry,
 * `label`, the output directory as the run names it, the `argv` it ran with
 * and the `repoRoot` its paths are named from, and `stated`, whether the
 * lines already printed beneath its status line say what failed it.
 */
export type Failure = {
  run: CheckRun;
  check: SummaryCheck;
  label: string;
  argv: readonly string[];
  repoRoot: string;
  stated: boolean;
};

/** An excerpt's lines, and the files it was read from where those aren't the check's one raw file. */
type Excerpt = { lines: string[]; files?: string };

/**
 * The lines a failed check prints beneath its status line and whatever
 * reason it gave: a `go test` run's tests, else its excerpt unless its cause
 * is `stated`, then `full output: <file>`, the file under the output
 * directory the excerpt was read from, or both files where it shows both
 * streams. A check that captured nothing names no file, and says
 * `no output captured` where nothing above it says more.
 */
export function failureExcerpt(failure: Failure): string[] {
  const { run, check, label, stated } = failure;
  if (!captured(failure)) return stated ? [] : [`${REPORT_INDENT}no output captured (exit ${run.outcome.exit_code})`];
  const tests = goTestLines(run);
  const excerpt = stated || tests.length > 0 ? null : (vitestExcerpt(failure) ?? findingsExcerpt(failure) ?? outputExcerpt(failure));
  const pointer = `full output: ${excerpt?.files ?? rawPointer(check, run.outcome, label)}`;
  return [...tests, ...[...(excerpt?.lines ?? []), pointer].map((line) => `${REPORT_INDENT}${line}`)];
}

/** Whether the run wrote any of the check's output to a file. */
function captured({ run, check }: Failure): boolean {
  return check.output_file !== null || run.outcome.stdout.trim() !== '' || run.outcome.stderr.trim() !== '';
}

/**
 * For a red `go test -json` check, the tests it failed, the first
 * {@link TESTS_NAMED}, then the last lines those tests printed, the first
 * failing test's first and {@link EXCERPT_TAIL_LINES} in all, where `go test`
 * says which assertion failed, then the tests still running when it stopped.
 * Its raw output is events, which a reader can't skim for a name or a
 * message. Nothing for another adapter, or a run that names no test.
 */
function goTestLines(run: CheckRun): string[] {
  if (run.adapter.name !== 'go-test') return [];
  const report = goTestReport(run.outcome.stdout);
  if (report === null) return [];
  return [...namedTests(report.failed, 'failing test(s)'), ...testOutput(report.failed), ...namedTests(report.running, 'still running when it stopped')];
}

/** A heading with how many cases, then the first {@link TESTS_NAMED} of them, or nothing for none. */
function namedTests(cases: readonly GoTestCase[], what: string): string[] {
  if (cases.length === 0) return [];
  const more = cases.length > TESTS_NAMED ? [`${REPORT_INDENT}  … ${cases.length - TESTS_NAMED} more`] : [];
  return [`${REPORT_INDENT}${cases.length} ${what}:`, ...cases.slice(0, TESTS_NAMED).map((c) => `${REPORT_INDENT}  ${caseName(c)}`), ...more];
}

/** The first {@link EXCERPT_TAIL_LINES} of the lines the failing tests printed, in the tests' order, shaped as any excerpt's. */
function testOutput(failed: readonly GoTestCase[]): string[] {
  const printed = printable(failed.flatMap((c) => c.output).join('\n')).split('\n').filter((line) => line.trim() !== '');
  return printed.slice(0, EXCERPT_TAIL_LINES).map((line) => `${REPORT_INDENT}${shaped(line)}`);
}

/**
 * For a red check the vitest adapter fills, the first
 * {@link EXCERPT_VITEST_FAILURES} failures its reporter printed on stderr
 * ({@link vitestFailures}): what failed, then its error's first line beneath
 * it, and how many more failed. `null` for another adapter, a custom
 * `command` that runs vitest among them, and for a run it reads no failure
 * in, which shows its streams' last lines as any other check does. It names
 * every file the run wrote, since stdout holds the run's totals.
 */
function vitestExcerpt({ run, check, label }: Failure): Excerpt | null {
  if (run.adapter.name !== 'vitest') return null;
  const failures = vitestFailures(run.outcome.stderr);
  if (failures.length === 0) return null;
  const named = failures.slice(0, EXCERPT_VITEST_FAILURES).flatMap(({ name, error }) => [shaped(printable(name)), ...(error === '' ? [] : [shaped(`  ${printable(error)}`)])]);
  const more = failures.length - EXCERPT_VITEST_FAILURES;
  const files = streamFiles(check, run.outcome, label);
  return { lines: more > 0 ? [...named, `… and ${more} more`] : named, files: [files.stdout, files.stderr].filter((file) => file !== null).join(', ') };
}

/**
 * The first {@link EXCERPT_FINDINGS} findings the check's parser read that
 * can fail it, in the tool's order, then how many more, or `null` for a tool
 * with no parser, output its parser can't read, or a run with no such
 * finding. This is the run's first parse of such a check: masking parses only
 * under a baseline entry, and a red check it masked lists its new findings
 * instead, which makes its cause `stated`.
 */
function findingsExcerpt({ run, argv, repoRoot }: Failure): Excerpt | null {
  const { adapter, outcome } = run;
  const found = gatingFindings(adapter.name, findingText(adapter.name, outcome), argv, run.root, repoRoot);
  if (found === null || found.length === 0) return null;
  return { lines: capped(found.map(findingLine), EXCERPT_FINDINGS, (more) => `… and ${more} more`) };
}

/**
 * What the check printed, where no finding of it can be listed: the last
 * lines of whichever stream holds any, and of both when both do, each under
 * its name, {@link EXCERPT_TAIL_LINES} in all. Nothing here guesses which
 * stream holds the cause, except for a tool its `failOnOutput` verdict
 * failed, whose stdout is the cause. A JSON report is never shown as text:
 * its last lines are closing braces, so one line says it holds no finding
 * checkride can read. The files it names are the ones it shows.
 */
function outputExcerpt({ run, check, label }: Failure): Excerpt {
  const { adapter, outcome } = run;
  const json = jsonReport(check, outcome.stdout);
  const byOutput = adapter.failOnOutput === true && outcome.exit_code === 0;
  const { out, err } = sharedTails(json ? '' : outcome.stdout, byOutput ? '' : outcome.stderr);
  const report = json ? [`exit ${outcome.exit_code}, no findings checkride can read in the JSON report`] : [];
  const files = streamFiles(check, outcome, label);
  const shown = [json || out.length > 0 ? files.stdout : null, err.length > 0 ? files.stderr : null].filter((file) => file !== null);
  return { lines: [...report, ...streamLines(out, err, json)], ...(shown.length > 0 ? { files: shown.join(', ') } : {}) };
}

/**
 * The two streams' last lines as the excerpt prints them: one stream's as
 * they are, and two streams', or stderr's beside a JSON report's line, each
 * under its name and indented beneath it, stderr first.
 */
function streamLines(out: readonly string[], err: readonly string[], besideReport: boolean): string[] {
  const both = err.length > 0 && (out.length > 0 || besideReport);
  if (!both) return [...err, ...out];
  return [...labelled('stderr', err), ...labelled('stdout', out)];
}

/** `lines` under `name:`, each indented beneath it, or nothing for none. */
function labelled(name: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`${name}:`, ...lines.map((line) => `  ${line}`)];
}

/**
 * The last lines of two streams, {@link EXCERPT_TAIL_LINES} between them:
 * half each, and either takes what the other leaves unused.
 */
function sharedTails(stdout: string, stderr: string): { out: string[]; err: string[] } {
  const half = EXCERPT_TAIL_LINES / 2;
  const out = tail(stdout);
  const err = tail(stderr);
  const errKept = Math.min(err.length, Math.max(half, EXCERPT_TAIL_LINES - out.length));
  const outKept = Math.min(out.length, EXCERPT_TAIL_LINES - errKept);
  return { out: outKept === 0 ? [] : out.slice(-outKept), err: errKept === 0 ? [] : err.slice(-errKept) };
}

/**
 * The last {@link EXCERPT_TAIL_LINES} lines of `text` that hold anything,
 * each without its escape sequences and control characters and cut at
 * {@link EXCERPT_LINE_CHARS}, read from the end of the text alone
 * ({@link TAIL_WINDOW_CHARS}).
 */
function tail(text: string): string[] {
  return lastLines(printable(endOf(text)), EXCERPT_TAIL_LINES).lines.map(shaped);
}

/**
 * The last {@link TAIL_WINDOW_CHARS} of `text`, from the start of the first
 * whole line in them, so a line the window cut into isn't shown from its
 * middle. Text that is one line that long is kept as the window holds it.
 */
function endOf(text: string): string {
  if (text.length <= TAIL_WINDOW_CHARS) return text;
  const end = text.slice(-TAIL_WINDOW_CHARS);
  const firstBreak = end.search(/[\r\n]/);
  return firstBreak === -1 ? end : end.slice(firstBreak + 1);
}

/**
 * Whether the check's stdout is a JSON report: the run captured it as its
 * JSON or JSON-lines artifact, or it starts as JSON does and parses as one
 * value or as lines of them.
 */
function jsonReport(check: SummaryCheck, stdout: string): boolean {
  if (check.output_file !== null) return true;
  return /^\s*[[{]/.test(stdout) && (parseToolJson(stdout) !== null || parseToolJsonLines(stdout) !== null);
}

/**
 * A finding on one line: `path:line:col`, its message's first line, and its
 * rule in brackets, two spaces between them, each left out where the tool
 * gave none, the column too. A finding with no message, as fallow's unused
 * file is, names its rule bare.
 */
export function findingLine(f: KeyedFinding): string {
  const [first = ''] = printable(f.message).split('\n');
  const message = first.trim();
  const rule = message === '' || f.rule === '' ? f.rule : `[${f.rule}]`;
  return shaped([placeOf(f), message, rule].filter((part) => part !== '').join('  '));
}

/** Where a finding sits, as an editor or a terminal opens it: `path:line:col`, `path:line` with no column, `path` with no line. */
function placeOf(f: KeyedFinding): string {
  if (f.file === '' || f.line === undefined) return f.file;
  return f.column === undefined ? `${f.file}:${f.line}` : `${f.file}:${f.line}:${f.column}`;
}

/**
 * `text` as a terminal can print it plainly: no escape sequence, a carriage
 * return as the line break a progress line means by it (`\r\n` as one), a
 * tab as two spaces, and no other control character but a newline.
 */
function printable(text: string): string {
  return stripVTControlCharacters(text).replaceAll(/\r\n?/g, '\n').replaceAll('\t', '  ').replaceAll(/[^\P{Cc}\n]/gu, '');
}

/** One printable line as an excerpt shows it: no trailing space, and cut at {@link EXCERPT_LINE_CHARS}. */
function shaped(line: string): string {
  return cutAt(line.trimEnd(), EXCERPT_LINE_CHARS);
}

/** `text` held to `max` UTF-16 units, the last of them a `…` where it's cut, never splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max - 1;
  const code = text.charCodeAt(end - 1);
  // A high surrogate there would lose the low one it pairs with.
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)}…`;
}
