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
 *
 * {@link shownOf} is the one decision of which of those a failure shows, and
 * it holds what it read, every field already made printable. The excerpt's
 * lines ({@link failureExcerpt}) and a run's annotations (`./annotate.ts`)
 * are each formatted from it, so a check is read once and the two never
 * differ on what it found.
 */

import { stripVTControlCharacters } from 'node:util';

import { findingText, gatingFindings } from '../baseline/index.js';
import type { GoTestCase, GoTestReport } from '../digest/index.js';
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

/** What a check with no finding to list printed: whether its stdout is a JSON report, the line that says so, and each stream's last lines. */
type Tails = { json: boolean; report: string[]; out: string[]; err: string[] };

/**
 * What a failed check shows beneath its status line and its reason, and the
 * one thing its annotations are drawn from:
 *
 * - `uncaptured`: it wrote no output, and nothing above says more;
 * - `cases`: a `go test` run's failing and unfinished tests, shown even where
 *   the lines above state its cause;
 * - `stated`: nothing more, since the lines above already say what failed
 *   it (its new findings, or a reason that is the whole cause);
 * - `vitest`: a vitest run's failing tests;
 * - `findings`: the findings its parser read that can fail it;
 * - `output`: its streams' last lines, where it has none of the above.
 */
export type Shown =
  | { kind: 'uncaptured' | 'stated' }
  | { kind: 'cases'; report: GoTestReport }
  | { kind: 'vitest'; tests: FailedTest[] }
  | { kind: 'findings'; findings: KeyedFinding[] }
  | ({ kind: 'output' } & Tails);

/**
 * Which of those `failure` shows, the first that applies in the order
 * {@link Shown} lists them, with what was read to decide it. This is the
 * run's first parse of a red check with a parser: masking parses only under
 * a baseline entry, and a red check it masked lists its new findings
 * instead, which makes its cause `stated`.
 */
export function shownOf(failure: Failure): Shown {
  if (!captured(failure)) return { kind: failure.stated ? 'stated' : 'uncaptured' };
  const report = goReport(failure.run);
  if (report !== null && report.failed.length + report.running.length > 0) return { kind: 'cases', report };
  if (failure.stated) return { kind: 'stated' };
  return unstatedShown(failure);
}

/** {@link shownOf} for a check whose cause nothing above states: its failing vitest tests, else its findings, else its output. */
function unstatedShown(failure: Failure): Shown {
  const tests = vitestTests(failure.run);
  if (tests.length > 0) return { kind: 'vitest', tests };
  const findings = failureFindings(failure) ?? [];
  return findings.length > 0 ? { kind: 'findings', findings } : { kind: 'output', ...outputTails(failure) };
}

/**
 * The lines a failed check prints beneath its status line and whatever
 * reason it gave: what it `shown` ({@link shownOf}), then
 * `full output: <file>`, the file under the output directory the excerpt was
 * read from, or both files where it shows both streams. A check that
 * captured nothing names no file, and says `no output captured` where
 * nothing above it says more.
 */
export function failureExcerpt(failure: Failure, shown: Shown = shownOf(failure)): string[] {
  const { run, check, label } = failure;
  if (shown.kind === 'uncaptured') return [`${REPORT_INDENT}no output captured (exit ${run.outcome.exit_code})`];
  if (!captured(failure)) return [];
  const tests = shown.kind === 'cases' ? goTestLines(shown.report) : [];
  const excerpt = excerptOf(failure, shown);
  const pointer = `full output: ${named(excerpt?.files ?? rawPointer(check, run.outcome, label))}`;
  return [...tests, ...[...(excerpt?.lines ?? []), pointer].map((line) => `${REPORT_INDENT}${line}`)];
}

/** The excerpt of what a check `shown`, or `null` for one that shows its `go test` cases or nothing more. */
function excerptOf(failure: Failure, shown: Shown): Excerpt | null {
  if (shown.kind === 'vitest') return vitestExcerpt(failure, shown.tests);
  if (shown.kind === 'findings') return { lines: capped(shown.findings.map(lineOf), EXCERPT_FINDINGS, (more) => `… and ${more} more`) };
  return shown.kind === 'output' ? outputExcerpt(failure, shown) : null;
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
 * message.
 */
function goTestLines(report: GoTestReport): string[] {
  return [...namedTests(report.failed, 'failing test(s)'), ...testOutput(report.failed), ...namedTests(report.running, 'still running when it stopped')];
}

/** A `go test -json` run's report, or `null` for another adapter's run, or one that names no test. */
function goReport(run: CheckRun): GoTestReport | null {
  return run.adapter.name === 'go-test' ? goTestReport(run.outcome.stdout) : null;
}

/** A heading with how many cases, then the first {@link TESTS_NAMED} of them, or nothing for none. */
function namedTests(cases: readonly GoTestCase[], what: string): string[] {
  if (cases.length === 0) return [];
  const more = cases.length > TESTS_NAMED ? [`${REPORT_INDENT}  … ${cases.length - TESTS_NAMED} more`] : [];
  return [`${REPORT_INDENT}${cases.length} ${what}:`, ...cases.slice(0, TESTS_NAMED).map((c) => `${REPORT_INDENT}  ${shaped(named(caseName(c)))}`), ...more];
}

/** The first {@link EXCERPT_TAIL_LINES} of the lines the failing tests printed, in the tests' order, shaped as any excerpt's. */
function testOutput(failed: readonly GoTestCase[]): string[] {
  const printed = printable(failed.flatMap((c) => c.output).join('\n')).split('\n').filter((line) => line.trim() !== '');
  return printed.slice(0, EXCERPT_TAIL_LINES).map((line) => `${REPORT_INDENT}${shaped(line)}`);
}

/**
 * For a red check the vitest adapter fills, the first
 * {@link EXCERPT_VITEST_FAILURES} of the `failures` its reporter printed on
 * stderr ({@link vitestTests}): what failed, then its error's first line
 * beneath it, and how many more failed. It names every file the run wrote,
 * since stdout holds the run's totals.
 */
function vitestExcerpt({ run, check, label }: Failure, failures: readonly FailedTest[]): Excerpt {
  const listed = failures.slice(0, EXCERPT_VITEST_FAILURES).flatMap(({ name, error }) => [shaped(name), ...(error === '' ? [] : [shaped(`  ${error}`)])]);
  const more = failures.length - EXCERPT_VITEST_FAILURES;
  const files = streamFiles(check, run.outcome, label);
  return { lines: more > 0 ? [...listed, `… and ${more} more`] : listed, files: [files.stdout, files.stderr].filter((file) => file !== null).join(', ') };
}

/**
 * One failing test as a reader names it: what failed, and the line that says
 * why, `''` when it printed none. Both are printable, and each is one line.
 * `file` is the path a vitest name starts with, from the check's root: a
 * test's is `<file> > <suite> > <test>` and a suite's `<file> [ <file> ]`,
 * each after `|<project>| ` in a run of projects. Nothing says it exists,
 * and a `go test` case names a package, so has none.
 */
export type FailedTest = { name: string; error: string; file?: string };

/** What vitest puts before a test's name in a run of projects: the project's name between bars, `|unit| `. */
const VITEST_PROJECT = /^\|[^|]*\| /;

/**
 * The failures a run the vitest adapter fills printed, each field printable,
 * or none for another adapter's run, a custom `command` that runs vitest
 * among them, and for a run {@link vitestFailures} reads no failure in,
 * which shows its streams' last lines as any other check does.
 */
function vitestTests(run: CheckRun): FailedTest[] {
  if (run.adapter.name !== 'vitest') return [];
  return vitestFailures(run.outcome.stderr).map(({ name, error }) => {
    const whole = named(name);
    const [file = ''] = whole.replace(VITEST_PROJECT, '').split(/ > | \[ /);
    return { name: whole, error: named(error), ...(file === '' ? {} : { file }) };
  });
}

/** A line of a `go test` case's output that says why it failed, not one of `go test`'s own `=== RUN` or `--- FAIL` lines. */
const GO_OWN_LINE = /^\s*(===|---) /;

/** The tests a `go test -json` run's `report` failed, each with the first line it printed that says why. */
function goTests(report: GoTestReport): FailedTest[] {
  return report.failed.map((c) => {
    const said = c.output.map(named).find((line) => line !== '' && !GO_OWN_LINE.test(line));
    return { name: named(caseName(c)), error: said ?? '' };
  });
}

/** The tests a check failed, as what it `shown` names them: a `go test` run's or a vitest run's, and none for any other. */
export function shownTests(shown: Shown): FailedTest[] {
  if (shown.kind === 'cases') return goTests(shown.report);
  return shown.kind === 'vitest' ? shown.tests : [];
}

/**
 * Every finding the check's parser read that can fail it, in the tool's
 * order, each made printable ({@link cleanFinding}), or `null` for a tool
 * with no parser or output its parser can't read. What the excerpt lists the
 * first of.
 */
export function failureFindings({ run, argv, repoRoot }: Failure): KeyedFinding[] | null {
  const { adapter, outcome } = run;
  return gatingFindings(adapter.name, findingText(adapter.name, outcome), argv, run.root, repoRoot)?.map(cleanFinding) ?? null;
}

/**
 * A finding with each field a reader is shown made printable: its path and
 * its rule on one line ({@link named}), and its message's first line. A tool
 * prints all three, so none is trusted to hold no escape sequence or control
 * character. Its key is left as the baseline holds it.
 */
function cleanFinding(f: KeyedFinding): KeyedFinding {
  const [first = ''] = printable(f.message).split('\n');
  return { ...f, file: named(f.file), rule: named(f.rule), message: first.trim() };
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
function outputExcerpt({ run, check, label }: Failure, { json, report, out, err }: Tails): Excerpt {
  const { outcome } = run;
  const files = streamFiles(check, outcome, label);
  const shown = [json || out.length > 0 ? files.stdout : null, err.length > 0 ? files.stderr : null].filter((file) => file !== null);
  return { lines: [...report, ...streamLines(out, err, json)], ...(shown.length > 0 ? { files: shown.join(', ') } : {}) };
}

/** The {@link Tails} of a check with no finding to list. */
function outputTails({ run, check }: Failure): Tails {
  const { adapter, outcome } = run;
  const json = jsonReport(check, outcome.stdout);
  const byOutput = adapter.failOnOutput === true && outcome.exit_code === 0;
  const report = json ? [`exit ${outcome.exit_code}, no findings checkride can read in the JSON report`] : [];
  return { json, report, ...sharedTails(json ? '' : outcome.stdout, byOutput ? '' : outcome.stderr) };
}

/**
 * The first line the excerpt of a check with no test or finding to list
 * shows, without a stream's name above it: that it captured no output, else
 * its JSON report's line, else the first of its last lines, stderr's before
 * stdout's. `null` for a check that shows something else, or whose streams
 * hold no printable line.
 */
export function shownFirstLine(shown: Shown, exitCode: number): string | null {
  if (shown.kind === 'uncaptured') return `no output captured (exit ${exitCode})`;
  if (shown.kind !== 'output') return null;
  return [...shown.report, ...shown.err, ...shown.out].map((line) => line.trim()).find((line) => line !== '') ?? null;
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
  return lineOf(cleanFinding(f));
}

/** {@link findingLine} for a finding whose fields are already printable. */
function lineOf(f: KeyedFinding): string {
  const rule = f.message === '' || f.rule === '' ? f.rule : `[${f.rule}]`;
  return shaped([placeOf(f), f.message, rule].filter((part) => part !== '').join('  '));
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

/**
 * A name a tool printed (a path, a rule, a test) as one printable line: no
 * escape sequence or control character, each line break in it a space, and
 * no space around it. A name is kept whole, where a message keeps its first
 * line, since half a path names another file.
 */
export function named(text: string): string {
  return printable(text).replaceAll(/\s*\n\s*/g, ' ').trim();
}

/**
 * A line the report already printed before any excerpt (a reason, a
 * finding as its tool printed it) without what a terminal would act on: no
 * escape sequence, and no control character but a tab or a line break.
 * Nothing else about it changes: it isn't trimmed, joined or re-spaced.
 */
export function plain(text: string): string {
  return stripVTControlCharacters(text).replaceAll(/[^\P{Cc}\n\t]/gu, '');
}

/** One control character as JSON writes it in a string: `\n`, `\t`, or `\u001b`. */
function escaped(char: string): string {
  const json = JSON.stringify(char).slice(1, -1);
  return json === char ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : json;
}

/**
 * A baseline key as the report prints it: every printable character as it
 * is, so the key can be copied and matched against the baseline file, and
 * each control character written the way that file's JSON writes it, `\n` or
 * `\u001b`, where a terminal would otherwise act on it or hide it.
 */
export function visibleKey(key: string): string {
  return key.replaceAll(/\p{Cc}/gu, escaped);
}

/** One printable line as an excerpt shows it: no trailing space, and cut at {@link EXCERPT_LINE_CHARS}. */
export function shaped(line: string): string {
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
