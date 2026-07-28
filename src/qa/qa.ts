/**
 * Assembling the quality report — the four artifacts checkride already writes,
 * each folded to a short list, behind a ledger saying which of them is actually
 * evidence.
 *
 * This reader runs nothing (D2): it opens `.check/` and reports. That makes the
 * ledger the load-bearing part rather than a preamble. Three of the four
 * artifacts come from opt-in slots and this repo's own gate never runs
 * `mutation` at all, so *partial data is the normal case*, and a reader that
 * treated a gap as an edge case would spend its life reporting edge cases. Each
 * artifact is therefore placed in one of four honest states — read, stale, not
 * opted in, or missing — with the command or config entry that would produce it
 * (D14), and the ones that are missing are as much of the answer as the ones
 * that are not.
 *
 * Freshness is the same window triage uses (D11): an artifact belongs to the
 * run that wrote the summary beside it only if its mtime is at or after that
 * run's *start*. `mutation.json` in this repo is routinely days older than
 * everything else, and reporting it as current is the exact wrong answer this
 * module exists to prevent.
 *
 * Because nothing is run, the summary on disk may describe a narrow run — so
 * the report leads with which slots it covered and how old it is (D12), and
 * every finding below that is qualified by it.
 */

import { join } from 'node:path';

import type { ArtifactFile, SummaryRead } from '../artifacts/index.js';
import { CHECK_DIR, configuredSlots, readSummary, runWindowStart } from '../artifacts/index.js';
import type { DeadExtract } from './dead.js';
import { extractDead } from './dead.js';
import type { DupesExtract } from './dupes.js';
import { extractDupes } from './dupes.js';
import type { HealthExtract } from './health.js';
import { extractHealth } from './health.js';
import type { MutationExtract } from './mutation.js';
import { extractMutation } from './mutation.js';
import type { ArtifactRead } from './read.js';
import { readJsonArtifact } from './read.js';

/** Why an artifact produced no extract. `null` means it produced one. */
export type LedgerProblem = 'absent' | 'too-large' | 'unreadable' | 'unrecognized';

/** One artifact's standing — the honest four-state answer D14 asks for. */
export type LedgerEntry = {
  slot: string;
  /** File name within `.check/`. */
  artifact: string;
  /** Named in `checkride.config.json`; `null` when the repo has no config. */
  optedIn: boolean | null;
  /** Whether the slot has an entry in the summary on disk. */
  ranThisRun: boolean;
  /** Measured and freshness-judged; `null` when nothing is on disk. */
  file: ArtifactFile | null;
  problem: LedgerProblem | null;
  /** What `unreadable` means in this case. */
  detail: string | null;
  /** The command or config entry that would produce this artifact. */
  remedy: string;
};

export type QaReport = {
  cwd: string;
  summary: SummaryRead;
  windowStart: number | null;
  /** Age of the run that wrote the summary, measured from its end. */
  summaryAgeMs: number | null;
  /** Slots the summary says actually ran — the covered list D12 requires. */
  covered: string[];
  skipped: string[];
  configured: string[] | null;
  ledger: LedgerEntry[];
  mutation: MutationExtract | null;
  health: HealthExtract | null;
  dead: DeadExtract | null;
  dupes: DupesExtract | null;
};

type ArtifactSpec = { slot: string; artifact: string; remedy: string };

/**
 * The four artifacts, in the order the skill reasons about them: surviving
 * mutants, then dead code, then duplication, then the complexity score.
 *
 * Each remedy names something real. `dead` is in the default catalogue and the
 * other three are opt-in slots, which is why only they mention `--include`; and
 * `checkride init --add` scaffolds `fallow.toml` but has no stryker template,
 * so `mutation` says its config is hand-written rather than implying otherwise.
 */
const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    slot: 'mutation',
    artifact: 'mutation.json',
    remedy:
      'Opt-in slot. Run `checkride --include mutation` (or add `"mutation": { "use": "stryker" }` to ' +
      '`checkride.config.json`). It detects on a stryker config — `stryker.config.mjs` — which `checkride init` ' +
      'does not scaffold, so that file is written by hand.',
  },
  {
    slot: 'dead',
    artifact: 'dead.json',
    remedy:
      'Default-catalogue slot, so `checkride` already runs it — unless no dead-code tool is detected. Add ' +
      '`fallow.toml` (`checkride init --add dead` scaffolds one) or a knip config, then `checkride --only dead`.',
  },
  {
    slot: 'dupes',
    artifact: 'dupes.json',
    remedy:
      'Opt-in slot. Run `checkride --include dupes` (or add `"dupes": { "use": "fallow" }` to ' +
      '`checkride.config.json`). Needs `fallow.toml` — `checkride init --add dupes` scaffolds one.',
  },
  {
    slot: 'health',
    artifact: 'health.json',
    remedy:
      'Opt-in slot. Run `checkride --include health` (or add `"health": { "use": "fallow" }` to ' +
      '`checkride.config.json`). Needs `fallow.toml` — `checkride init --add health` scaffolds one.',
  },
];

/** The read's failure state, or `null` when it produced a value to extract. */
function problemOf(read: ArtifactRead): LedgerProblem | null {
  if (read.state === 'missing') return 'absent';
  return read.state === 'ok' ? null : read.state;
}

function detailOf(read: ArtifactRead): string | null {
  return read.state === 'unreadable' ? read.detail : null;
}

type SlotContext = { configured: string[] | null; ran: Set<string> };

/**
 * One ledger row. `recognized` is false when the bytes parsed but the fold did
 * not find the report it expected — a distinct state from unreadable, because
 * the file is fine and it is the *kind* that is wrong.
 */
function entryFor(
  spec: ArtifactSpec,
  read: ArtifactRead,
  context: SlotContext,
  recognized: boolean,
): LedgerEntry {
  const problem = problemOf(read);
  return {
    slot: spec.slot,
    artifact: spec.artifact,
    optedIn: context.configured === null ? null : context.configured.includes(spec.slot),
    ranThisRun: context.ran.has(spec.slot),
    file: read.file,
    problem: problem === null && !recognized ? 'unrecognized' : problem,
    detail: detailOf(read),
    remedy: spec.remedy,
  };
}

/** The slots the summary on disk says actually ran, and the ones it skipped. */
function coverage(summary: SummaryRead): { covered: string[]; skipped: string[] } {
  if (summary.state !== 'ok') return { covered: [], skipped: [] };
  const checks = summary.summary.checks;
  return {
    covered: checks.filter((c) => c.skipped !== true).map((c) => c.name),
    skipped: checks.filter((c) => c.skipped === true).map((c) => c.name),
  };
}

/** How long ago the run that wrote the summary finished. */
function summaryAge(summary: SummaryRead, now: number): number | null {
  if (summary.state !== 'ok') return null;
  const ended = Date.parse(summary.summary.timestamp);
  return Number.isNaN(ended) ? null : now - ended;
}

/**
 * Read `.check/`'s four quality artifacts and fold each to a short list.
 * Never throws and never runs anything: every failure is a ledger state.
 */
export async function qaExtract(cwd: string, now: () => number = Date.now): Promise<QaReport> {
  const checkDir = join(cwd, CHECK_DIR);
  const summary = await readSummary(cwd);
  const windowStart = summary.state === 'ok' ? runWindowStart(summary.summary) : null;
  const { covered, skipped } = coverage(summary);
  const context: SlotContext = { configured: configuredSlots(cwd), ran: new Set(covered) };

  const reads = new Map(
    await Promise.all(
      ARTIFACTS.map(
        async (spec) => [spec.slot, await readJsonArtifact(checkDir, spec.artifact, windowStart)] as const,
      ),
    ),
  );

  const MISSING: ArtifactRead = { state: 'missing', file: null };
  const readOf = (slot: string): ArtifactRead => reads.get(slot) ?? MISSING;
  /** Fold a slot's parsed bytes, or `null` when there are none to fold. */
  const fold = <T>(slot: string, extract: (value: Record<string, unknown>) => T | null): T | null => {
    const read = readOf(slot);
    return read.state === 'ok' ? extract(read.value) : null;
  };

  // Named one by one rather than dispatched: each artifact has its own fold
  // with its own return type, and there are exactly four of them.
  const mutation = fold('mutation', extractMutation);
  const dead = fold('dead', extractDead);
  const dupes = fold('dupes', extractDupes);
  const health = fold('health', extractHealth);
  const recognized: Readonly<Record<string, boolean>> = {
    mutation: mutation !== null,
    dead: dead !== null,
    dupes: dupes !== null,
    health: health !== null,
  };

  return {
    cwd,
    summary,
    windowStart,
    summaryAgeMs: summaryAge(summary, now()),
    covered,
    skipped,
    configured: context.configured,
    ledger: ARTIFACTS.map((spec) =>
      entryFor(spec, readOf(spec.slot), context, recognized[spec.slot] ?? false),
    ),
    mutation,
    health,
    dead,
    dupes,
  };
}
