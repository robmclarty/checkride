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

import type { ArtifactFile, SummaryRead } from '../artifacts/index.js';
import { outDir, outLabel, readSummary, runWindowStart } from '../artifacts/index.js';
import { configuredSlots } from '../config.js';
import type { SummaryCheck } from '../orchestrator/index.js';
import { enableCandidates, enableEntry } from '../orchestrator/index.js';
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
  /** The check that writes it: the slot, or `<target>:<slot>` for a target's. */
  name: string;
  /** Path within the output directory: `dead.json`, or `web/dead.json` for a target's check. */
  artifact: string;
  /**
   * Named in `checkride.config.json`; `null` when the repo has no config, and
   * for a target's check, whose entry may sit in its target's or its pack's
   * block rather than the top level this reads.
   */
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
  /**
   * The output directory as the report names it: relative to {@link cwd} when
   * it sits inside it (`.check` by default), absolute otherwise.
   */
  outLabel: string;
  summary: SummaryRead;
  windowStart: number | null;
  /** Age of the run that wrote the summary, measured from its end. */
  summaryAgeMs: number | null;
  /** Slots the summary says actually ran — the covered list D12 requires. */
  covered: string[];
  skipped: string[];
  configured: string[] | null;
  ledger: LedgerEntry[];
  /** Each artifact folded, in ledger order: one per ledger entry whose file held the report it should. */
  folds: QaFold[];
};

/** One artifact folded, named for the check that wrote it. */
export type QaFold =
  | { name: string; slot: 'mutation'; extract: MutationExtract }
  | { name: string; slot: 'dead'; extract: DeadExtract }
  | { name: string; slot: 'dupes'; extract: DupesExtract }
  | { name: string; slot: 'health'; extract: HealthExtract };

type ArtifactSpec = { slot: QaFold['slot']; artifact: string; remedy: string };

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
 * One artifact a check wrote: its spec, the check's name, its path in the
 * output directory, and the summary's entry for the check, when it lists one.
 */
type Instance = { spec: ArtifactSpec; name: string; artifact: string; check: SummaryCheck | undefined };

/**
 * Where each artifact is: one per target's check the summary lists for its
 * slot, under `<target>/`, and otherwise the one at the output directory's
 * root, which is every artifact in a repo without targets.
 *
 * A target's `mutation.json` is where its stryker config's
 * `jsonReporter.fileName` puts it, relative to the target's root, so it's read
 * here only when that path lands in the target's output directory; checkride
 * routes no file of stryker's own.
 */
function instancesOf(spec: ArtifactSpec, summary: SummaryRead): Instance[] {
  const all = summary.state === 'ok' ? summary.summary.checks : [];
  const checks = all.filter((c) => c.target !== undefined && c.slot === spec.slot);
  if (checks.length === 0) return [{ spec, name: spec.slot, artifact: spec.artifact, check: all.find((c) => c.name === spec.slot) }];
  return checks.map((c) => ({ spec, name: c.name, artifact: `${c.target ?? ''}/${spec.artifact}`, check: c }));
}

/** The opening every `dead` remedy for a check fallow doesn't fill shares: why there's no fold. */
const FALLOW_ONLY = "qa reads only fallow's report";

/** The remedy for a `dead` check that sat out: its pack's own tool, or for a ts check, the spec's fallow remedy. */
function satOutRemedy(spec: ArtifactSpec, check: SummaryCheck): string {
  const pack = check.pack ?? 'ts';
  const own = pack === 'ts' ? [] : enableCandidates(spec.slot, pack, []);
  if (own.length === 0) return spec.remedy;
  const add = own.map((a) => enableEntry(a, false)).join(', or ');
  return `${FALLOW_ONLY}, which no ${pack} tool writes. ${check.name} found no tool; add ${add}, then read its raw output in the output directory.`;
}

/**
 * What would produce `instance`'s artifact. A `dead` check another tool fills
 * (deadcode, cargo-machete, knip) writes no fallow report, the only one qa
 * folds, so its remedy points at the check's raw output instead; one of
 * another pack that sat out names that pack's own tool, since fallow and knip
 * check only TypeScript. Every other artifact's remedy is its spec's.
 */
function remedyFor(instance: Instance): string {
  const { spec, check } = instance;
  if (spec.slot !== 'dead' || check === undefined || check.adapter === 'fallow') return spec.remedy;
  if (check.adapter === null || check.skipped === true) return satOutRemedy(spec, check);
  const raw = check.output_file ?? `${instance.artifact.replace(/\.json$/, '')}.stdout.txt`;
  return `${FALLOW_ONLY}, and ${check.name} ran ${check.adapter}, which writes none: read its raw output, \`${raw}\` in the output directory.`;
}

/** Fold one artifact's parsed bytes by its slot's extractor, or `null` when they aren't that report. */
function foldOf(name: string, slot: ArtifactSpec['slot'], value: Record<string, unknown>): QaFold | null {
  switch (slot) {
    case 'mutation': {
      const extract = extractMutation(value);
      return extract === null ? null : { name, slot, extract };
    }
    case 'dead': {
      const extract = extractDead(value);
      return extract === null ? null : { name, slot, extract };
    }
    case 'dupes': {
      const extract = extractDupes(value);
      return extract === null ? null : { name, slot, extract };
    }
    default: {
      const extract = extractHealth(value);
      return extract === null ? null : { name, slot, extract };
    }
  }
}

/**
 * One ledger row. `recognized` is false when the bytes parsed but the fold did
 * not find the report it expected — a distinct state from unreadable, because
 * the file is fine and it is the *kind* that is wrong.
 */
function entryFor(instance: Instance, read: ArtifactRead, context: SlotContext, recognized: boolean): LedgerEntry {
  const { spec, name } = instance;
  const problem = problemOf(read);
  const targets = name !== spec.slot;
  return {
    slot: spec.slot,
    name,
    artifact: instance.artifact,
    optedIn: context.configured === null || targets ? null : context.configured.includes(spec.slot),
    ranThisRun: context.ran.has(name),
    file: read.file,
    problem: problem === null && !recognized ? 'unrecognized' : problem,
    detail: detailOf(read),
    remedy: remedyFor(instance),
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
 * Read the output directory's four quality artifacts and fold each to a short
 * list. `out` is the directory `--out` or `CHECKRIDE_OUT` named, or `null`
 * for `<cwd>/.check`. Never throws and never runs anything: every failure is a
 * ledger state.
 */
export async function qaExtract(cwd: string, now: () => number = Date.now, out: string | null = null): Promise<QaReport> {
  const checkDir = out ?? outDir(cwd);
  const summary = await readSummary(checkDir);
  const windowStart = summary.state === 'ok' ? runWindowStart(summary.summary) : null;
  const { covered, skipped } = coverage(summary);
  const context: SlotContext = { configured: configuredSlots(cwd), ran: new Set(covered) };

  const instances = ARTIFACTS.flatMap((spec) => instancesOf(spec, summary));
  const read = await Promise.all(
    instances.map(async (instance) => {
      const artifact = await readJsonArtifact(checkDir, instance.artifact, windowStart);
      const fold = artifact.state === 'ok' ? foldOf(instance.name, instance.spec.slot, artifact.value) : null;
      return { instance, artifact, fold };
    }),
  );

  return {
    cwd,
    outLabel: outLabel(cwd, checkDir),
    summary,
    windowStart,
    summaryAgeMs: summaryAge(summary, now()),
    covered,
    skipped,
    configured: context.configured,
    ledger: read.map(({ instance, artifact, fold }) => entryFor(instance, artifact, context, fold !== null)),
    folds: read.flatMap(({ fold }) => (fold === null ? [] : [fold])),
  };
}
