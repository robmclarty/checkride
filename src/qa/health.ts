/**
 * `health.json` — fallow's complexity and maintainability report, ~50 KB of
 * which perhaps twenty numbers are worth an agent's attention.
 *
 * The score is the headline, but a bare `80.7/B` is not actionable: fallow
 * computes it by subtracting named penalties from 100, and the *non-zero*
 * penalties are the whole explanation of the grade. Reporting them ranked, with
 * the zeroes counted rather than listed, turns "the score is B" into "hotspots
 * cost 10 points and unit size cost 8.5" — which names what to fix.
 *
 * Per-function findings are the other half. fallow gates on four independent
 * thresholds (cyclomatic, cognitive, CRAP, unit size) and each finding says in
 * `exceeded` which one it breached, so the findings group by that rather than
 * collapsing into an undifferentiated count: a function over the size threshold
 * and one over CRAP want different fixes.
 *
 * Hotspots (complex *and* frequently changed) are ranked by fallow's own score
 * and capped — they are the input to the fragility judgment the skill makes,
 * not a judgment this reader should be making.
 *
 * The `../qa` barrel is this module's only public surface.
 */

import { asNumberOrNull as num, asRecord, asRecordArray, asStringOrNull, isRecord } from '../artifacts/index.js';

/** Findings listed individually before they collapse to counts by threshold. */
const TOP_FINDINGS = 8;
/** Hotspots listed; the rest are counted. */
const TOP_HOTSPOTS = 6;

/** One named penalty subtracted from a perfect 100. */
export type Penalty = { name: string; points: number };

/** One function over one of fallow's four thresholds. */
export type HealthFinding = {
  path: string;
  name: string;
  line: number | null;
  /** Which threshold it breached: `cyclomatic`, `cognitive`, `crap`, `unit_size`. */
  exceeded: string;
  severity: string;
  cyclomatic: number | null;
  cognitive: number | null;
  lineCount: number | null;
};

/** A file that is both complex and frequently changed. */
export type Hotspot = {
  path: string;
  score: number | null;
  commits: number | null;
  complexityDensity: number | null;
  trend: string;
};

/** The four thresholds a `health` finding can breach, as configured. */
export type Thresholds = {
  cyclomatic: number | null;
  cognitive: number | null;
  crap: number | null;
  unitSize: number | null;
};

export type HealthExtract = {
  score: number | null;
  grade: string;
  formulaVersion: number | null;
  /** Non-zero penalties, worst first — the score's actual causes. */
  penalties: Penalty[];
  /** Penalties that scored zero, counted rather than listed. */
  zeroPenalties: number;
  filesAnalyzed: number | null;
  functionsAnalyzed: number | null;
  averageMaintainability: number | null;
  thresholds: Thresholds;
  totalFindings: number;
  findings: HealthFinding[];
  omittedFindings: number;
  /** Findings per breached threshold, worst first — covers the omitted ones too. */
  byThreshold: { exceeded: string; count: number }[];
  totalHotspots: number;
  hotspots: Hotspot[];
  omittedHotspots: number;
};

/** Non-zero penalties, worst first, plus how many scored zero. */
function readPenalties(scoreBlock: Record<string, unknown>): { penalties: Penalty[]; zeroPenalties: number } {
  const entries = Object.entries(asRecord(scoreBlock['penalties']))
    .map(([name, value]) => ({ name, points: num(value) ?? 0 }));
  return {
    penalties: entries
      .filter((p) => p.points > 0)
      .toSorted((a, b) => b.points - a.points || a.name.localeCompare(b.name)),
    zeroPenalties: entries.filter((p) => p.points <= 0).length,
  };
}

function readThresholds(summary: Record<string, unknown>): Thresholds {
  return {
    cyclomatic: num(summary['max_cyclomatic_threshold']),
    cognitive: num(summary['max_cognitive_threshold']),
    crap: num(summary['max_crap_threshold']),
    unitSize: num(summary['max_unit_size_threshold']),
  };
}

function readFinding(finding: Record<string, unknown>): HealthFinding {
  return {
    path: asStringOrNull(finding['path']) ?? '?',
    name: asStringOrNull(finding['name']) ?? '?',
    line: num(finding['line']),
    exceeded: asStringOrNull(finding['exceeded']) ?? 'unknown',
    severity: asStringOrNull(finding['severity']) ?? 'unknown',
    cyclomatic: num(finding['cyclomatic']),
    cognitive: num(finding['cognitive']),
    lineCount: num(finding['line_count']),
  };
}

/** Every finding grouped by the threshold it breached, worst-populated first. */
function groupByThreshold(findings: readonly HealthFinding[]): { exceeded: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.exceeded, (counts.get(finding.exceeded) ?? 0) + 1);
  return [...counts]
    .map(([exceeded, count]) => ({ exceeded, count }))
    .toSorted((a, b) => b.count - a.count || a.exceeded.localeCompare(b.exceeded));
}

function readHotspot(hotspot: Record<string, unknown>): Hotspot {
  return {
    path: asStringOrNull(hotspot['path']) ?? '?',
    score: num(hotspot['score']),
    commits: num(hotspot['commits']),
    complexityDensity: num(hotspot['complexity_density']),
    trend: asStringOrNull(hotspot['trend']) ?? 'unknown',
  };
}

/**
 * Fold a parsed `health.json` into the report model, or `null` when it carries
 * no `health_score` block — that is not a fallow health report, and saying so
 * beats reporting a zero score that reads like a finding.
 */
export function extractHealth(value: Record<string, unknown>): HealthExtract | null {
  const scoreBlock = value['health_score'];
  if (!isRecord(scoreBlock)) return null;

  const summary = asRecord(value['summary']);
  const { penalties, zeroPenalties } = readPenalties(scoreBlock);
  const findings = asRecordArray(value['findings']).map(readFinding);
  const hotspots = asRecordArray(value['hotspots']).map(readHotspot);

  return {
    score: num(scoreBlock['score']),
    grade: asStringOrNull(scoreBlock['grade']) ?? '?',
    formulaVersion: num(scoreBlock['formula_version']),
    penalties,
    zeroPenalties,
    filesAnalyzed: num(summary['files_analyzed']),
    functionsAnalyzed: num(summary['functions_analyzed']),
    averageMaintainability: num(summary['average_maintainability']),
    thresholds: readThresholds(summary),
    totalFindings: findings.length,
    findings: findings.slice(0, TOP_FINDINGS),
    omittedFindings: Math.max(0, findings.length - TOP_FINDINGS),
    byThreshold: groupByThreshold(findings),
    totalHotspots: hotspots.length,
    hotspots: hotspots.slice(0, TOP_HOTSPOTS),
    omittedHotspots: Math.max(0, hotspots.length - TOP_HOTSPOTS),
  };
}
