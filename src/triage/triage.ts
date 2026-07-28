/**
 * Assembling the triage report — everything the skill reasons over, and nothing
 * it would have to open a file to learn.
 *
 * The shape is deliberately a *model*, not text: the run's provenance, one row
 * per slot with its raw output located and sized, what the run did and did not
 * cover, and the traps (vacuous green, narrow green, baselined findings, stale
 * artifacts) each surfaced as its own field. Rendering is `./render.ts`'s job.
 *
 * Two facts drive almost all of it. First, the summary is an index, not
 * evidence: it is overwritten by every run, so triage runs the gate itself and
 * then checks that the summary on disk is the one that run wrote. Second, sizes
 * are the product: `mutation.json` is 2.3 MB in this repo, and a reader that
 * reports contents instead of bytes has spent the context it exists to save.
 */

import { join } from 'node:path';

import type { ArtifactFile, RawOutput, SummaryRead } from '../artifacts/index.js';
import { CHECK_DIR, configuredSlots, readSummary, resolveRawOutput, runWindowStart, statArtifact } from '../artifacts/index.js';
import { DIGEST_FILE } from '../digest/index.js';
import type { SummaryCheck } from '../orchestrator.js';
import type { DoctorFold } from './doctor-fold.js';
import { foldDoctor } from './doctor-fold.js';
import type { TriageEnv } from './env.js';
import type { GateOutcome } from './gate.js';
import { isHarnessProblem, runGate } from './gate.js';

export type SlotStatus = 'pass' | 'fail' | 'skipped';

/** One slot as the report presents it: outcome, plus where its bytes are. */
export type SlotRow = {
  slot: string;
  adapter: string | null;
  status: SlotStatus;
  exitCode: number | null;
  durationMs: number;
  /** Findings a committed baseline grandfathered; `null` when none were masked. */
  baselined: number | null;
  /** Why a skipped slot sat out. */
  reason: string | null;
  raw: RawOutput | null;
};

/** What the run actually verified — and, where knowable, what it did not. */
export type Coverage = {
  ran: string[];
  skipped: string[];
  /**
   * Slots named in `checkride.config.json` and not disabled, or `null` when the
   * repo has no config file (the default catalogue applies and this reader will
   * not guess at it).
   */
  configured: string[] | null;
  /** Configured slots with no entry in this run's summary at all. */
  uncovered: string[];
};

export type TriageReport = {
  cwd: string;
  gate: GateOutcome;
  /** Present only on the broken-harness branch, where it is the diagnosis. */
  doctor: DoctorFold | null;
  summary: SummaryRead;
  /**
   * Whether the summary on disk was written by the run just made. `null` when
   * there is no readable summary, or no run to compare it against.
   */
  fromThisRun: boolean | null;
  windowStart: number | null;
  rows: SlotRow[];
  failing: SlotRow[];
  coverage: Coverage;
  /** `ok: true` with `checks_run: 0` — nothing was verified. */
  vacuous: boolean;
  /** `.check/digest.md`; its existence means the run that wrote it had failures. */
  digest: ArtifactFile | null;
  /** Every measured file older than this run's start, deduped by path. */
  stale: ArtifactFile[];
};

/**
 * mtime can be second-granular on older filesystems, so a summary written a
 * moment after the gate started could otherwise read as older than it. The
 * tolerance is far smaller than any real gate run, so it cannot launder a
 * genuinely stale summary into a fresh one.
 */
const MTIME_TOLERANCE_MS = 1000;

function statusOf(check: SummaryCheck): SlotStatus {
  if (check.skipped === true) return 'skipped';
  return check.ok ? 'pass' : 'fail';
}

async function buildRow(checkDir: string, check: SummaryCheck, windowStart: number | null): Promise<SlotRow> {
  // A skipped slot produced no output; any file under its name is a leftover
  // from an earlier run, and offering it would be the stale read this module
  // exists to prevent.
  const raw = check.skipped === true ? null : await resolveRawOutput(checkDir, check.name, check.output_file, windowStart);
  return {
    slot: check.name,
    adapter: check.adapter,
    status: statusOf(check),
    exitCode: check.exit_code,
    durationMs: check.duration_ms,
    baselined: check.baselined ?? null,
    reason: check.reason ?? null,
    raw,
  };
}

function buildCoverage(cwd: string, rows: readonly SlotRow[]): Coverage {
  const configured = configuredSlots(cwd);
  const present = new Set(rows.map((r) => r.slot));
  return {
    ran: rows.filter((r) => r.status !== 'skipped').map((r) => r.slot),
    skipped: rows.filter((r) => r.status === 'skipped').map((r) => r.slot),
    configured,
    uncovered: (configured ?? []).filter((slot) => !present.has(slot)),
  };
}

/** Whether the summary on disk is the one the gate just wrote. */
function writtenByThisRun(summary: SummaryRead, gate: GateOutcome): boolean | null {
  if (summary.state === 'missing' || summary.state === 'unreadable') return null;
  if (gate.verdict === 'not-run') return null;
  return summary.mtimeMs >= gate.startedMs - MTIME_TOLERANCE_MS;
}

/** Every stale file the run measured, deduped — a stale read is the classic wrong answer. */
function collectStale(rows: readonly SlotRow[], digest: ArtifactFile | null): ArtifactFile[] {
  const measured = [...rows.flatMap((r) => r.raw?.candidates ?? []), ...(digest ? [digest] : [])];
  const stale = new Map<string, ArtifactFile>();
  for (const file of measured) {
    if (file.freshness.state === 'stale') stale.set(file.path, file);
  }
  return [...stale.values()];
}

type Artifacts = {
  summary: SummaryRead;
  windowStart: number | null;
  rows: SlotRow[];
  digest: ArtifactFile | null;
};

/** Read everything the run left behind, measuring and never opening. */
async function readArtifacts(cwd: string): Promise<Artifacts> {
  const checkDir = join(cwd, CHECK_DIR);
  const summary = await readSummary(cwd);
  const windowStart = summary.state === 'ok' ? runWindowStart(summary.summary) : null;
  const checks: readonly SummaryCheck[] = summary.state === 'ok' ? summary.summary.checks : [];
  const [rows, digest] = await Promise.all([
    Promise.all(checks.map((check) => buildRow(checkDir, check, windowStart))),
    statArtifact(checkDir, DIGEST_FILE, windowStart),
  ]);
  return { summary, windowStart, rows, digest };
}

function isVacuous(summary: SummaryRead): boolean {
  return summary.state === 'ok' && summary.summary.ok && summary.summary.checks_run === 0;
}

/**
 * Run the gate, then read what it wrote. On the broken-harness branch `doctor`
 * is folded in first, because there the environment is the finding and the
 * slot table is not evidence of anything.
 */
export async function triage(cwd: string, env: TriageEnv): Promise<TriageReport> {
  const gate = await runGate(cwd, env);
  const doctor = isHarnessProblem(gate.verdict) ? await foldDoctor(cwd, env) : null;
  const { summary, windowStart, rows, digest } = await readArtifacts(cwd);
  return {
    cwd,
    gate,
    doctor,
    summary,
    fromThisRun: writtenByThisRun(summary, gate),
    windowStart,
    rows,
    failing: rows.filter((r) => r.status === 'fail'),
    coverage: buildCoverage(cwd, rows),
    vacuous: isVacuous(summary),
    digest,
    stale: collectStale(rows, digest),
  };
}
