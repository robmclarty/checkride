/**
 * The shapes every tool-output parser shares — what it reads, what it is
 * handed beside the raw text, and what it returns — and the public shapes of
 * `checkride/findings` (R12.1).
 */

import type { PathBase } from './paths.js';

/**
 * The stream a parser reads (D49): the JSON `artifact` a check captured from
 * its stdout, its `stdout` text, or its `stderr` text. The artifact holds
 * stdout's bytes from the first JSON character on, so a reader holding only
 * the check's two streams hands an artifact parser stdout, which every JSON
 * parser reads past a launcher preamble to the same value.
 */
export type FindingStream = 'artifact' | 'stdout' | 'stderr';

/** What a check printed: the two streams a parser can be handed. */
export type CheckOutput = { readonly stdout: string; readonly stderr: string };

/**
 * The command a check spawned, then its args. Some tools take a flag that lets
 * a warning fail the run without changing the warning's reported severity, so
 * only the argv can say which findings gate. `undefined` means the caller
 * can't say, and a parser that needs it marks every finding as gating.
 */
export type Argv = readonly string[] | undefined;

/**
 * What a parser reads besides the raw text: the argv the check ran with, and
 * the base each path the tool printed is rebased from (R12.4).
 */
export type ParseContext = PathBase & { readonly argv: Argv };

/**
 * One finding a parser read, with the key the baseline records it under.
 * `file` is already rebased (R12.4); `line` and `column` are 1-based, and
 * absent when the tool gives none; `rule` is `''` when the tool names none;
 * `severity` is the tool's own level string, verbatim, when it reports one,
 * and for eslint, whose report gives a number, the word its formatters print.
 * `gates` says whether the finding can fail the check under the argv that
 * ran, and is absent when the parser can't tell, which the baseline reads as
 * gating. `slot` is set only by a parser whose report says which slot it
 * fills, as fallow's `kind` does.
 */
export type KeyedFinding = {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly rule: string;
  readonly message: string;
  readonly severity?: string;
  readonly gates?: boolean;
  readonly slot?: string;
  readonly key: string;
};

/**
 * One tool format's parser. `parse` never throws: it returns the findings it
 * read, an empty array for a clean run or a payload its format can't tell from
 * one, and `null` for output the format can say is untrustworthy, which a
 * reader takes as "not observed": vale's runtime-error report, a cargo build
 * that never finished, or a JSON format whose payload isn't the shape a clean
 * run prints (oxlint's `diagnostics` record, the array ast-grep, ruff and
 * golangci-lint print). A line-based format (cspell, typos, staticcheck) can't
 * tell empty output from a clean run, so the baseline also asks whether the
 * check reached a verdict before it trusts an empty one. `parseOnly` marks a
 * parser that serves `checkride/findings` but never the baseline: a type
 * checker's errors aren't grandfathered (D31).
 */
export type Parser = {
  readonly stream: FindingStream;
  readonly parse: (raw: string, context: ParseContext) => readonly KeyedFinding[] | null;
  readonly parseOnly?: true;
};

/**
 * One parsed diagnostic, as `checkride/findings` serves it (R12.1). `file` is
 * repo-root-relative with forward slashes, unless the tool printed an absolute
 * path outside the repo; `line` and `column` are 1-based; `rule` is `''` when
 * the tool names none; `severity` is the tool's own level string, verbatim,
 * or eslint's number as the word its formatters print;
 * `gates` says whether the finding can fail the check under the argv that ran,
 * and is absent when that can't be known (R12.3).
 */
export type Finding = {
  adapter: string;
  slot: string;
  file: string;
  line?: number;
  column?: number;
  rule: string;
  message: string;
  severity?: string;
  gates?: boolean;
};

/**
 * What `parseFindings` reads beside the raw text. `slot` defaults to the
 * adapter's slot (fallow's comes from its report), `root` is the check's
 * `cwd`, repo-relative and `''` for the repo root, `repoRoot` is absolute and
 * relativizes a path a tool printed absolute, and `argv` defaults to the
 * adapter's registry args.
 */
export type ParseOptions = {
  slot?: string;
  root?: string;
  repoRoot?: string;
  argv?: readonly string[];
};

/**
 * The fields of a `summary.json` check entry `findingsFor` reads: a parsed
 * entry, or the exported `SummaryCheck`, fits it.
 */
export type FindingsCheck = {
  readonly name: string;
  readonly adapter: string | null;
  readonly target?: string | undefined;
  readonly slot?: string | undefined;
  readonly cwd?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly output_file: string | null;
  readonly skipped?: boolean | undefined;
};
