/**
 * `mutation.json` — 2.3 MB and 4453 mutants in this repo — folded into a short
 * list an agent can act on.
 *
 * The scores are stryker's own, computed the way stryker computes them, so the
 * numbers here match the ones its reporter printed: `Ignored` (and any error
 * status) leaves the denominator entirely, `Killed` and `Timeout` are detected,
 * `Survived` and `NoCoverage` are not. Inventing a differently-defined score
 * than the tool prints is the confidently-wrong answer this reader exists to
 * prevent, so the arithmetic is pinned to the tool's.
 *
 * **The ranking is the judgment here.** 777 survivors is not a list anyone
 * reads, so files rank by *undetected* count (`Survived` + `NoCoverage`)
 * descending — that is what "where would tests buy the most" means — with the
 * per-file score shown beside it so a small badly-tested file is still legible
 * next to a large mostly-tested one. Ranking by score alone would put a
 * two-mutant file at the top of a 4453-mutant report; ranking by count alone
 * would say nothing but "the big files are big". Ties break on the worse score,
 * then the path, so the same report always renders the same bytes.
 *
 * Two further cuts carry most of the signal at almost no byte cost. Splitting
 * `NoCoverage` out from `Survived` separates "no test reaches this line" (add
 * any test) from "a test reaches it and asserts nothing about it" (strengthen
 * an assertion). And tallying undetected mutants *by mutator kind* separates
 * real logic gaps (`ConditionalExpression`, `EqualityOperator`) from the
 * `StringLiteral` churn in error messages that no one intends to assert on.
 *
 * The `../qa` barrel is this module's only public surface.
 */

import { asStringOrNull, isRecord } from '../artifacts/index.js';

/** Files listed; the rest are counted, never silently dropped. */
const TOP_FILES = 8;
/** Mutator kinds listed repo-wide, and per file. */
const TOP_MUTATORS = 8;
const TOP_FILE_MUTATORS = 3;
/**
 * Located samples come only from the worst few files, because a line number is
 * the one thing a reader cannot get back without opening the 2.3 MB file.
 */
const SAMPLE_FILES = 3;
const SAMPLES_PER_FILE = 3;
/** A replacement is source text and can be a whole block; only a taste fits. */
const MAX_REPLACEMENT_CHARS = 48;

/** One mutator kind and how many undetected mutants it accounts for. */
export type MutatorCount = { mutator: string; count: number };

/** An undetected mutant, located — enough to open the file at the right line. */
export type MutantSample = {
  path: string;
  line: number | null;
  mutator: string;
  status: string;
  /** First line of the replacement, clipped; `…` marks anything left off. */
  replacement: string;
};

/** One source file's mutation standing. */
export type MutationFile = {
  path: string;
  survived: number;
  noCoverage: number;
  /** Mutants that counted toward the score — detected plus undetected. */
  tested: number;
  /** Percentage, or `null` when no mutant in this file was testable. */
  score: number | null;
  mutators: MutatorCount[];
};

export type MutationExtract = {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  ignored: number;
  /** Compile/runtime errors and any status a future stryker adds. */
  other: number;
  total: number;
  /** Stryker's headline: detected ÷ tested. `null` when nothing was testable. */
  score: number | null;
  /** Stryker's "score covered": the same, ignoring mutants no test reaches. */
  scoreCovered: number | null;
  totalFiles: number;
  files: MutationFile[];
  omittedFiles: number;
  mutators: MutatorCount[];
  samples: MutantSample[];
};

type Tally = {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  ignored: number;
  other: number;
};

/** Stryker status → the bucket it counts in. Anything unlisted is `other`. */
const TALLY_KEY: Readonly<Record<string, keyof Tally>> = {
  Killed: 'killed',
  Timeout: 'timeout',
  Survived: 'survived',
  NoCoverage: 'noCoverage',
  Ignored: 'ignored',
};

/** Every {@link Tally} bucket, so summing two of them needs no type assertion. */
const TALLY_KEYS = ['killed', 'timeout', 'survived', 'noCoverage', 'ignored', 'other'] as const;

function emptyTally(): Tally {
  return { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, other: 0 };
}

function tested(tally: Tally): number {
  return tally.killed + tally.timeout + tally.survived + tally.noCoverage;
}

/** Detected ÷ tested, as stryker computes it. `null` when nothing was tested. */
function scoreOf(tally: Tally): number | null {
  const denominator = tested(tally);
  return denominator === 0 ? null : ((tally.killed + tally.timeout) / denominator) * 100;
}

/** The same score with `NoCoverage` left out — stryker's second column. */
function coveredScoreOf(tally: Tally): number | null {
  const denominator = tally.killed + tally.timeout + tally.survived;
  return denominator === 0 ? null : ((tally.killed + tally.timeout) / denominator) * 100;
}

/** Descending by count, then by name — the same tallies always sort the same. */
function rankMutators(counts: ReadonlyMap<string, number>, limit: number): MutatorCount[] {
  return [...counts]
    .map(([mutator, count]) => ({ mutator, count }))
    .toSorted((a, b) => b.count - a.count || a.mutator.localeCompare(b.mutator))
    .slice(0, limit);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The `mutants` array of one `files` entry, with non-object entries dropped. */
function mutantsOf(entry: unknown): Record<string, unknown>[] {
  if (!isRecord(entry)) return [];
  const mutants = entry['mutants'];
  return Array.isArray(mutants) ? mutants.filter(isRecord) : [];
}

/** `location.start.line`, or `null` when the mutant carries no usable position. */
function lineOf(mutant: Record<string, unknown>): number | null {
  const location = mutant['location'];
  if (!isRecord(location)) return null;
  const start = location['start'];
  if (!isRecord(start)) return null;
  return typeof start['line'] === 'number' ? start['line'] : null;
}

/**
 * The first line of a replacement, clipped. A trailing `…` covers both cuts —
 * a long first line and any lines after it — so the excerpt never reads as the
 * whole replacement.
 */
function excerptReplacement(mutant: Record<string, unknown>): string {
  const text = asStringOrNull(mutant['replacement']) ?? '';
  const [firstLine = ''] = text.split('\n');
  const clipped = firstLine.slice(0, MAX_REPLACEMENT_CHARS);
  return clipped.length < text.length ? `${clipped}…` : clipped;
}

/** Everything one file's mutants contribute, in a single pass over them. */
type FileScan = { tally: Tally; mutators: Map<string, number>; undetected: Record<string, unknown>[] };

function scanFile(mutants: readonly Record<string, unknown>[]): FileScan {
  const tally = emptyTally();
  const mutators = new Map<string, number>();
  const undetected: Record<string, unknown>[] = [];
  for (const mutant of mutants) {
    const status = asStringOrNull(mutant['status']) ?? '';
    tally[TALLY_KEY[status] ?? 'other'] += 1;
    if (status !== 'Survived' && status !== 'NoCoverage') continue;
    bump(mutators, asStringOrNull(mutant['mutatorName']) ?? 'unknown');
    if (undetected.length < SAMPLES_PER_FILE) undetected.push(mutant);
  }
  return { tally, mutators, undetected };
}

function undetectedOf(file: MutationFile): number {
  return file.survived + file.noCoverage;
}

/**
 * Worst first: most undetected mutants, then the lower score, then the path.
 * See this module's header for why count leads and score breaks the tie.
 */
function byUrgency(a: MutationFile, b: MutationFile): number {
  return (
    undetectedOf(b) - undetectedOf(a) ||
    (a.score ?? 0) - (b.score ?? 0) ||
    a.path.localeCompare(b.path)
  );
}

function sampleFrom(path: string, mutant: Record<string, unknown>): MutantSample {
  return {
    path,
    line: lineOf(mutant),
    mutator: asStringOrNull(mutant['mutatorName']) ?? 'unknown',
    status: asStringOrNull(mutant['status']) ?? 'unknown',
    replacement: excerptReplacement(mutant),
  };
}

type Scanned = { file: MutationFile; undetected: Record<string, unknown>[] };

function scanAll(files: Record<string, unknown>): { scanned: Scanned[]; total: Tally; mutators: Map<string, number> } {
  const total = emptyTally();
  const mutators = new Map<string, number>();
  const scanned: Scanned[] = [];
  for (const [path, entry] of Object.entries(files)) {
    const { tally, mutators: fileMutators, undetected } = scanFile(mutantsOf(entry));
    for (const key of TALLY_KEYS) total[key] += tally[key];
    for (const [mutator, count] of fileMutators) mutators.set(mutator, (mutators.get(mutator) ?? 0) + count);
    scanned.push({
      file: {
        path,
        survived: tally.survived,
        noCoverage: tally.noCoverage,
        tested: tested(tally),
        score: scoreOf(tally),
        mutators: rankMutators(fileMutators, TOP_FILE_MUTATORS),
      },
      undetected,
    });
  }
  return { scanned, total, mutators };
}

/**
 * Fold a parsed `mutation.json` into the report model, or `null` when it is not
 * a stryker report (no `files` object) — the ledger reports that rather than
 * this returning an empty extract that would read as "nothing survived".
 */
export function extractMutation(value: Record<string, unknown>): MutationExtract | null {
  const files = value['files'];
  if (!isRecord(files)) return null;

  const { scanned, total, mutators } = scanAll(files);
  const ranked = scanned.toSorted((a, b) => byUrgency(a.file, b.file));
  const shown = ranked.slice(0, TOP_FILES);
  const samples = ranked
    .slice(0, SAMPLE_FILES)
    .flatMap(({ file, undetected }) => undetected.map((mutant) => sampleFrom(file.path, mutant)));

  return {
    ...total,
    total: tested(total) + total.ignored + total.other,
    score: scoreOf(total),
    scoreCovered: coveredScoreOf(total),
    totalFiles: ranked.length,
    files: shown.map(({ file }) => file),
    omittedFiles: ranked.length - shown.length,
    mutators: rankMutators(mutators, TOP_MUTATORS),
    samples,
  };
}
