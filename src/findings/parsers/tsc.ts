/**
 * tsc's plain diagnostics, on stdout when it isn't writing to a terminal: one
 * `<file>(<line>,<col>): error TS<code>: <message>` line per diagnostic, its
 * line and column 1-based and its path relative to the check's root, and a
 * diagnostic with no file (a missing project) as `error TS<code>: <message>`.
 * A chained message continues on the lines after, each indented. Checked
 * against tsc 7.0.2.
 */

import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased } from '../read.js';
import type { Argv, CheckOutput, KeyedFinding, ParseContext, Parser, RunContext } from '../types.js';

/**
 * One diagnostic's first line: an optional `<file>(<line>,<col>): ` place,
 * absent for a diagnostic with no file, then its category, code and message.
 */
const DIAGNOSTIC = /^(?:(.+)\((\d+),(\d+)\): )?(error|warning|message) (TS\d+): (.*)$/;

/**
 * A single-quoted span, as tsc quotes the types and names it prints: a quote
 * no letter or digit touches on its outer side, so the apostrophe in "can't"
 * neither opens nor closes one.
 */
const QUOTED = /(?<![\p{L}\p{N}])'.*?'(?![\p{L}\p{N}])/gu;

/**
 * The rest of the text tsc fills into a message, each made `…` in turn after
 * the single-quoted spans: a span in double quotes, as an older tsc prints a
 * module's name, an absolute path among them; one in backticks, a type it
 * suggests; the list a "following …:" message ends on, the members a class
 * misses or the properties a type lacks; and every run of digits, a count or
 * a position. Read from the 74 of tsc 7.0.2's error messages that print
 * something outside single quotes.
 */
const FILLED: readonly (readonly [RegExp, string])[] = [
  [/"[^"]*"/g, '"…"'],
  [/`[^`]*`/g, '`…`'],
  [/(\bfollowing [^:]*: ).*$/, '$1…'],
  [/\d+/g, '…'],
];

/**
 * The codes tsc's parser and scanner report: a syntax error, after which tsc
 * type-checks none of the project it's in. Read from typescript-go's
 * `internal/parser` and `internal/scanner` at `typescript/v7.0.2`, less the
 * regular-expression errors only the checker reports. The checker reports
 * some of these too, 17 of them and a `checkJs` file's JSDoc syntax among
 * them, and a run with one is taken as stopped short all the same: it masks
 * nothing, but never prunes a key it didn't reach.
 */
const SYNTAX_ERRORS: ReadonlySet<number> = new Set([
  1002, 1003, 1005, 1007, 1010, 1011, 1012, 1034, 1068, 1069, 1084, 1109, 1110, 1121, 1124, 1125, 1126, 1127, 1128, 1129,
  1130, 1131, 1132, 1134, 1135, 1136, 1137, 1138, 1139, 1140, 1142, 1144, 1145, 1146, 1160, 1161, 1177, 1178, 1179, 1180,
  1181, 1185, 1198, 1199, 1206, 1209, 1223, 1228, 1260, 1327, 1328, 1351, 1352, 1353, 1357, 1359, 1381, 1382, 1385, 1386,
  1387, 1388, 1389, 1390, 1433, 1434, 1435, 1436, 1437, 1438, 1439, 1440, 1441, 1442, 1443, 1453, 1472, 1477, 1478, 1486,
  1487, 1488, 1489, 1490, 2427, 2457, 2657, 2754, 2809, 2819, 2880, 6188, 6189, 8002, 8003, 8004, 8005, 8006, 8008, 8009,
  8010, 8011, 8012, 8013, 8016, 8017, 8033, 8034, 8037, 8038, 8039, 17002, 17006, 17007, 17008, 17014, 17015, 17021, 18009,
  18016, 18026, 18029, 18030,
]);

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
 * A diagnostic's key: its file, its code, and its message's first line with
 * each quoted span made `'…'` and the rest of what tsc filled in made `…`
 * ({@link FILLED}). That text changes on edits elsewhere (an anonymous object
 * type prints its whole shape, and a property added to a type lengthens the
 * list of the ones a value lacks), so the key names the error rather than
 * what it mentions, and errors it names alike in one file are counted under
 * it.
 */
function keyOf(d: Diagnostic): string {
  const [first = ''] = d.message.split('\n');
  const filled = FILLED.reduce((text, [span, elided]) => text.replace(span, elided), first.replace(QUOTED, "'…'"));
  return findingKey(d.file, d.rule, filled);
}

/**
 * A line a tsc that died part way leaves in its output, from whatever ran it:
 * pnpm 11.28.5's report of a killed command, on stdout, and yarn 1.22.22's, on
 * stderr; Node's dump of the error typescript 7's launcher throws where it
 * can't hand its process over (Node before 22.15, and Windows), naming the
 * signal; a Go runtime's panic or fatal error (tsc 7); and a Node crash (tsc
 * 6 and before): an uncaught exception, which Node ends with its own
 * version, or a heap, stack or assertion failure.
 */
const DIED =
  /killed with SIG[A-Z]+|failed with signal "?SIG[A-Z]+|signal: 'SIG[A-Z]+'|^(?:panic|fatal error|FATAL ERROR): |^Node\.js v\d|Debug Failure\.|Maximum call stack size exceeded/;

/** tsc's build mode, which it takes with one dash or two. */
const BUILD = /^--?(?:b|build)$/i;

/** A finding as tsc printed its first line, place, category, code and message whole: what a reader shows in place of its key. */
function printed(f: KeyedFinding): string {
  const [first = ''] = f.message.split('\n');
  const place = f.file === '' ? '' : `${f.file}(${f.line ?? 0},${f.column ?? 0}): `;
  return `${place}${f.severity ?? 'error'} ${f.rule}: ${first}`;
}

/** `text` as a Markdown code span: in two backticks, a space inside, where it holds one itself, as a template literal type does. */
function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/**
 * Whether a finding says tsc left part of its input unchecked: a diagnostic
 * with no file or on a `.json` file, where tsc reports a config it couldn't
 * read or rejected, and type-checks none of a project whose options it
 * rejects (an unknown option, which it only reports, counts too); a syntax
 * error; or TS6305, a referenced project whose declarations weren't built,
 * whose types every file importing it then lacks.
 */
function stopsChecking(f: KeyedFinding): boolean {
  return f.file === '' || f.file.endsWith('.json') || f.rule === 'TS6305' || SYNTAX_ERRORS.has(Number(f.rule.slice(2)));
}

/**
 * The line in either stream that says tsc died part way ({@link DIED}), or
 * `null`. A diagnostic, and the indented lines it continues on, are passed
 * over, since a type it prints can hold any text.
 */
function diedAt(output: CheckOutput | undefined): string | null {
  if (output === undefined) return null;
  let inDiagnostic = false;
  for (const line of `${output.stdout}\n${output.stderr}`.split('\n')) {
    inDiagnostic = DIAGNOSTIC.test(line.trimEnd()) || (inDiagnostic && /^\s+\S/.test(line));
    if (!inDiagnostic && DIED.test(line)) return line.trim();
  }
  return null;
}

/**
 * Whether `argv` builds with `--stopBuildOnErrors`, which tsc takes with one
 * dash or two and in any case, and turns off with a `false` after it. An
 * argv that hides tsc's flags behind a script reads as tsc's default.
 */
function stopsBuildOnErrors(argv: Argv): boolean {
  let stops = false;
  for (const [i, arg] of (argv ?? []).entries()) {
    if (/^--?stopbuildonerrors$/i.test(arg)) stops = argv?.[i + 1]?.toLowerCase() !== 'false';
  }
  return stops;
}

/** Whether a version names a TypeScript before 5.6, whose `--build` stopped at a project with errors. */
function before56(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  return m !== null && (Number(m[1]) < 5 || (Number(m[1]) === 5 && Number(m[2]) < 6));
}

/**
 * Whether a build spans project references, and so has a project to skip:
 * the projects `--build` names after it, or `tsconfig.json` where it names
 * none, more than one of them, or one whose `references` array holds
 * anything, or that `read` can't read, or no `read` at all, since then
 * nothing vouches for the build.
 */
function buildsReferences(argv: readonly string[], read: RunContext['read']): boolean {
  const named = argv.slice(argv.findIndex((arg) => BUILD.test(arg)) + 1).filter((arg) => !arg.startsWith('-') && !/^(?:true|false|\d+)$/i.test(arg));
  if (named.length > 1 || read === undefined) return true;
  const [project = 'tsconfig.json'] = named;
  const text = read(project.endsWith('.json') ? project : `${project}/tsconfig.json`);
  return text === null || /"references"\s*:\s*\[\s*[^\]\s]/.test(text);
}

/**
 * Why a build that found errors may have skipped a project: each project
 * depending on one with errors is skipped under `--stopBuildOnErrors`, and by
 * default before TypeScript 5.6, when the run's pin names the version and the
 * build spans project references ({@link buildsReferences}).
 */
function skipped({ argv, toolVersion, read }: RunContext): string | null {
  if (stopsBuildOnErrors(argv)) return '`--stopBuildOnErrors` skips each project that depends on one with errors';
  if (argv === undefined || !argv.some((arg) => BUILD.test(arg)) || !before56(toolVersion) || !buildsReferences(argv, read)) return null;
  return `TypeScript ${toolVersion ?? ''}'s \`--build\` skips each project that depends on one with errors, which 5.6 and later check`;
}

/**
 * Why a run stopped short of some errors, or `null` when it reached them all:
 * a finding saying tsc left part of its input unchecked ({@link stopsChecking}),
 * a line saying it died part way ({@link diedAt}), or, for a run that found
 * anything, a build that skips the projects depending on one with errors.
 */
function stoppedShortOf(findings: readonly KeyedFinding[], context: RunContext): string | null {
  const unchecked = findings.find(stopsChecking);
  if (unchecked !== undefined) return `tsc stopped short at ${codeSpan(printed(unchecked))}`;
  const died = diedAt(context.output);
  if (died !== null) return `tsc stopped short: ${codeSpan(died)}`;
  const skip = findings.length > 0 ? skipped(context) : null;
  return skip === null ? null : `tsc stopped short: ${skip}`;
}

/**
 * Every diagnostic, keyed on its `TS` code ({@link keyOf}), a chained message
 * kept whole with the indented lines that directly follow it; any other line
 * closes it, so a `--verbose` build's own indented lists join no diagnostic.
 * Every diagnostic fails the build.
 *
 * A run stopped short as {@link stoppedShortOf} says. Some of what tsc hides a
 * run can't show: a project's declaration-emit errors, which `--noEmit`
 * reports only for a project with no other error, and a project skipping its
 * emit under `noEmitOnError` never reports; and a referenced project that
 * emitted no declarations, which a file importing it by its package's name
 * reports only as TS2307, a module it can't find, or doesn't report at all
 * where an older build's declarations still sit.
 */
export const tscParser: Parser = {
  stream: 'stdout',
  printed,
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
    return diagnostics.map((d): KeyedFinding => ({ ...d, gates: true, key: keyOf(d) }));
  },
  stoppedShort: stoppedShortOf,
};
