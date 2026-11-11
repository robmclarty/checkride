/**
 * A run's findings as GitHub Actions workflow commands, so each shows on the
 * pull request's diff and in the job's annotation list. A run asked for them
 * (`--annotate github`, else `CHECKRIDE_ANNOTATE`) writes them to stderr once
 * its report and footer are out; nothing else about the run changes, and a
 * green run writes none.
 *
 * Each red check is annotated with what the report prints beneath its status
 * line, decided once by the excerpt's `shownOf` and read from what that
 * extracted: one annotation for each test it lists as failing; one for each
 * finding it lists, all of them where the excerpt stops at five; where the
 * report lists the check's new findings instead, one for each of those; and
 * otherwise one with no file, holding the check's reason, else the first
 * line of its excerpt, else the file that holds its output. The one parse
 * made here is of a check whose new findings the report lists by key.
 *
 * GitHub shows at most {@link ANNOTATION_CAP} error annotations for a step,
 * so a run writes that many, in the order it reports its checks, and one
 * notice counting the rest.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { rawPointer } from '../digest/index.js';
import type { KeyedFinding } from '../findings/index.js';
import type { Named } from '../suite.js';
import type { FailedTest, Failure, Shown } from './excerpt.js';
import { failureFindings, named, shaped, shownFirstLine, shownTests } from './excerpt.js';

/** The variable that asks a run for annotations, the way `--annotate` does (the flag wins). The gate strips it from the check it spawns. */
export const ANNOTATE_ENV = 'CHECKRIDE_ANNOTATE';

/** The annotation formats a run can write. */
const ANNOTATE_FORMATS = ['github'] as const;

/** An annotation format a run can write: GitHub Actions workflow commands, the only one. */
export type AnnotateFormat = (typeof ANNOTATE_FORMATS)[number];

/** How many error annotations a run writes: as many as GitHub shows for one step. */
export const ANNOTATION_CAP = 10;

/**
 * The format `asked` names (`--annotate`, else `CHECKRIDE_ANNOTATE`), or
 * `null` when neither was given. Any value but an accepted one is a usage
 * error naming what named it and what it accepts.
 */
export function annotateFormat(asked: Named | null): AnnotateFormat | null {
  if (asked === null) return null;
  const format = ANNOTATE_FORMATS.find((f) => f === asked.value);
  if (format === undefined) throw new Error(`invalid ${asked.from} '${asked.value}' (expected ${ANNOTATE_FORMATS.join(' | ')})`);
  return format;
}

/**
 * The findings a red check failed on that its baseline doesn't grandfather:
 * `keys`, the keys the baseline doesn't hold, and `excess`, each key it holds
 * that was found more often than it grandfathers, with both counts.
 */
export type Fresh = { keys: ReadonlySet<string>; excess: ReadonlyMap<string, { found: number; allowed: number }> };

/**
 * A red check as its annotations are drawn: the failure its excerpt reads,
 * what the report shows beneath its status line (`shownOf`), its `reason`
 * line when it printed one, and `fresh`, its new findings when the report
 * lists those, `null` for a check no baseline masked.
 */
export type RedCheck = { failure: Failure; shown: Shown; reason: string | null; fresh: Fresh | null };

/**
 * Where a run's paths sit: `top`, the real path of the top level of its git
 * work tree, or of its own directory outside a repository; `summary`, its
 * summary file as its lines name it; and `realFile`, the real path of an
 * absolute path that is a regular file, else `null`, which tests replace.
 */
export type AnnotateScope = { top: string; summary: string; realFile?: (path: string) => string | null };

/** One annotation before it's escaped: where it points, when anywhere, what it says, and `counts`, what follows its message uncut. */
type Annotation = { title: string; message: string; counts?: string; file?: string; line?: number; column?: number };

/** A workflow command's message, escaped as GitHub reads it back. */
export function escapeMessage(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** A workflow command's property value, escaped as GitHub reads it back: a message's escapes, and the two characters that end a property. */
export function escapeProperty(text: string): string {
  return escapeMessage(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** `path` with its symlinks resolved, or as it is when it can't be read. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The real path of `path` when it is a regular file on disk, else `null`. */
function realFileOnDisk(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The scope of a run whose findings are named from `root`, its repo root:
 * `top` is the git top level when git gave one, else `root`, as a real path,
 * so a root reached through a symlink still sits beneath it.
 */
export function annotateScope(top: string | null, root: string, summary: string): AnnotateScope {
  return { top: realPath(top ?? root), summary };
}

/**
 * `file`, a path from the repo root `root` or an absolute one, as GitHub
 * names it: from the top level of the work tree, with forward slashes.
 * `null` for no path, for one that is no regular file on disk (a package
 * name a tool put where a path goes), and for one whose real path sits
 * outside the work tree.
 */
export function repoPath(file: string, root: string, scope: AnnotateScope): string | null {
  if (file === '') return null;
  const real = (scope.realFile ?? realFileOnDisk)(resolve(root, file));
  if (real === null) return null;
  const fromTop = relative(scope.top, real);
  const outside = fromTop === '' || fromTop === '..' || fromTop.startsWith(`..${sep}`) || isAbsolute(fromTop);
  return outside ? null : fromTop.split(sep).join('/');
}

/** `n` when it is a line or a column an editor could open, counted from 1. */
function position(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Where a finding points, as an annotation's properties: its file when it is one in the work tree, its line with it, and its column with that. */
function placeOf(f: KeyedFinding, root: string, scope: AnnotateScope): Pick<Annotation, 'file' | 'line' | 'column'> {
  const file = repoPath(f.file, root, scope);
  const line = position(f.line);
  const column = position(f.column);
  if (file === null) return {};
  if (line === undefined) return { file };
  return column === undefined ? { file, line } : { file, line, column };
}

/** The annotation of one finding of the check named `check`: its place, its rule in the title, and its message, or its rule where it has none. */
function findingAnnotation(f: KeyedFinding, { check, repoRoot }: Failure, scope: AnnotateScope): Annotation {
  return {
    title: f.rule === '' ? check.name : `${check.name}: ${f.rule}`,
    message: [f.message, f.rule, 'failed'].find((text) => text !== '') ?? '',
    ...placeOf(f, repoRoot, scope),
  };
}

/**
 * The file a failing test's reader gives for it, as GitHub names it, when it
 * is a real file beneath the check's root, and `null` otherwise: the reader
 * takes it from the test's name, which nothing says is a path.
 */
function testFile(t: FailedTest, { run, repoRoot }: Failure, scope: AnnotateScope): string | null {
  if (t.file === undefined || isAbsolute(t.file)) return null;
  return repoPath(join(run.root ?? '', t.file), repoRoot, scope);
}

/** The annotation of one failing test: its name in the title, its error line as the message, and its file when its name gives a real one. */
function testAnnotation(t: FailedTest, failure: Failure, scope: AnnotateScope): Annotation {
  const file = testFile(t, failure, scope);
  return { title: `${failure.check.name}: ${t.name}`, message: t.error === '' ? 'failed' : t.error, ...(file === null ? {} : { file }) };
}

/**
 * The annotations of a check whose new findings the report lists: every
 * finding under a key the baseline doesn't hold, and, for a key found more
 * often than it grandfathers, the first finding under it alone, with both
 * counts after its message, since no key says which of them is the new one.
 */
function freshAnnotations(failure: Failure, fresh: Fresh, scope: AnnotateScope): Annotation[] {
  const counted = new Set<string>();
  return (failureFindings(failure) ?? []).flatMap((f) => {
    if (fresh.keys.has(f.key)) return [findingAnnotation(f, failure, scope)];
    const over = fresh.excess.get(f.key);
    if (over === undefined || counted.has(f.key)) return [];
    counted.add(f.key);
    return [{ ...findingAnnotation(f, failure, scope), counts: ` (${over.found} found, ${over.allowed} grandfathered)` }];
  });
}

/** The one annotation of a check with nothing to point at: its reason, else its excerpt's first line, else the file that holds its output. */
function bareAnnotation({ failure, shown, reason }: RedCheck): Annotation {
  const { check, run, label } = failure;
  return { title: check.name, message: reason ?? shownFirstLine(shown, run.outcome.exit_code) ?? `failed; see ${rawPointer(check, run.outcome, label)}` };
}

/** The annotations that point at what a red check's report lists: its failing tests, its findings, or its new findings, and none where it lists none of those. */
function listedAnnotations({ failure, shown, fresh }: RedCheck, scope: AnnotateScope): Annotation[] {
  if (shown.kind === 'findings') return shown.findings.map((f) => findingAnnotation(f, failure, scope));
  if (shown.kind === 'stated') return fresh === null ? [] : freshAnnotations(failure, fresh, scope);
  return shownTests(shown).map((t) => testAnnotation(t, failure, scope));
}

/** One red check's annotations, uncapped: one for each thing its report lists, or its one line where it lists nothing. */
function checkAnnotations(red: RedCheck, scope: AnnotateScope): Annotation[] {
  const listed = listedAnnotations(red, scope);
  return listed.length > 0 ? listed : [bareAnnotation(red)];
}

/**
 * One annotation as the workflow command GitHub reads:
 * `::error <properties>::<message>`. Its path, title and message are each
 * made one printable line before they're escaped (a reason line is a tool's
 * own text too), and the title and message are cut as an excerpt's line is.
 */
function errorCommand(a: Annotation): string {
  const properties = [
    ...(a.file === undefined ? [] : [`file=${escapeProperty(named(a.file))}`]),
    ...(a.line === undefined ? [] : [`line=${a.line}`]),
    ...(a.column === undefined ? [] : [`col=${a.column}`]),
    `title=${escapeProperty(shaped(named(a.title)))}`,
  ];
  return `::error ${properties.join(',')}::${escapeMessage(`${shaped(named(a.message))}${a.counts ?? ''}`)}`;
}

/**
 * The lines a run writes for its red checks, in the order it reports them:
 * the first {@link ANNOTATION_CAP} annotations as `::error` commands, then,
 * when there were more, one `::notice` counting them and naming the summary.
 * None for a run with no red check.
 */
export function annotationLines(reds: readonly RedCheck[], scope: AnnotateScope): string[] {
  const all = reds.flatMap((red) => checkAnnotations(red, scope));
  const more = all.length - ANNOTATION_CAP;
  const notice = more > 0 ? [`::notice title=checkride::${escapeMessage(`${more} more finding(s) not annotated; see ${scope.summary}`)}`] : [];
  return [...all.slice(0, ANNOTATION_CAP).map(errorCommand), ...notice];
}
