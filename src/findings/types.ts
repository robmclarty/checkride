/**
 * The shapes every tool-output parser shares: what it reads, what it is
 * handed beside the raw text, and what it returns.
 */

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
 * `root`, the directory it ran from relative to the repo root, which each path
 * the tool printed is joined onto.
 */
export type ParseContext = { readonly argv: Argv; readonly root: string | undefined };

/**
 * One finding a parser read, with the key the baseline records it under.
 * `file` is already joined onto the check's root; `rule` is `''` when the
 * tool names none; `severity` is the tool's own level string, verbatim, when
 * it reports one. `gates` says whether the finding can fail the check under
 * the argv that ran, and is absent when the parser can't tell, which the
 * baseline reads as gating.
 */
export type KeyedFinding = {
  readonly file: string;
  readonly rule: string;
  readonly message: string;
  readonly severity?: string;
  readonly gates?: boolean;
  readonly key: string;
};

/**
 * One tool format's parser. `parse` never throws: it returns the findings it
 * read, an empty array for a clean run or a payload its format can't tell from
 * one, and `null` only for output the format can say is untrustworthy (vale's
 * runtime-error report), which a reader takes as "not observed".
 */
export type Parser = {
  readonly stream: FindingStream;
  readonly parse: (raw: string, context: ParseContext) => readonly KeyedFinding[] | null;
};
