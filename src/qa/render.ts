/**
 * Rendering a {@link QaReport} as Markdown, under the same 8 KB ceiling
 * `--digest` uses.
 *
 * The ledger is the head and never drops: which artifacts are evidence, which
 * are days old, and which were never produced is the answer, not the preamble
 * (D14). Each ledger row carries its own headline number, so even if the byte
 * ceiling trims a detail section the score behind it survives.
 *
 * Detail sections follow in the order the skill reasons about them — surviving
 * mutants, then dead code, then duplication, then complexity — and each is
 * internally capped by its extractor, so the ceiling is a backstop rather than
 * the usual path. When it does bind, whole sections drop from the end and are
 * named; nothing is silently truncated mid-thought.
 *
 * No artifact's *contents* appear here beyond located samples and file names.
 * The one place source text surfaces at all is a clipped mutant replacement,
 * which is the only way a line number becomes actionable without opening a
 * 2.3 MB file.
 */

import { formatBytes, formatDuration } from '../artifacts/index.js';
import type { SummaryRead } from '../artifacts/index.js';
import type { DeadExtract } from './dead.js';
import type { DupesExtract } from './dupes.js';
import type { HealthExtract } from './health.js';
import type { MutationExtract } from './mutation.js';
import type { LedgerEntry, QaReport } from './qa.js';

/** Matches `--digest`'s ceiling: a report that reads in one gulp. */
export const QA_MAX_BYTES = 8000;

const NOT_READ_NOTE =
  'Not read: the full contents of any `.check/` artifact. Every list above is capped and every ' +
  'count is from a full pass, so a short list is a *ranked* list, never a complete one — open the ' +
  'named artifact when a specific finding is the one you are working on.';

const NOTHING_RUN_NOTE =
  'This reader ran nothing. Every number above is whatever the last run left in `.check/`, which ' +
  'may be a narrow run — check `covered` above before treating a clean artifact as a clean repo.';

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function table(head: readonly string[], rows: readonly string[]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows].join('\n');
}

/** `70.96%`, or `—` when nothing was measurable. `places` matches the tool's. */
function pct(value: number | null, places = 1): string {
  return value === null ? '—' : `${value.toFixed(places)}%`;
}

function count(value: number | null): string {
  return value === null ? '—' : String(value);
}

/**
 * A code span whose fence outgrows any backtick run inside `text`. Mutant
 * replacements are source, and stryker's `StringLiteral` mutator turns a
 * template literal into one made of backticks — a fixed single-backtick span
 * would break and swallow the rest of the line.
 */
function code(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = '`'.repeat(Math.max(0, ...runs) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/* -------------------------------------------------------------- the ledger */

/** The four-state answer, plus the two ways a file can be unusable. */
function stateOf(entry: LedgerEntry): string {
  if (entry.problem === 'absent') return entry.optedIn === false ? 'not opted in' : 'absent';
  if (entry.problem !== null) return entry.problem;
  return entry.file?.freshness.state === 'stale' ? 'STALE' : 'read';
}

function ageOf(entry: LedgerEntry): string {
  const freshness = entry.file?.freshness;
  if (freshness === undefined) return '—';
  if (freshness.state === 'stale') return formatDuration(freshness.ageMs ?? 0);
  return freshness.state === 'fresh' ? 'fresh' : '?';
}

function mutationHeadline(extract: MutationExtract): string {
  return `score ${pct(extract.score, 2)} · ${extract.survived} survived · ${extract.noCoverage} no-coverage`;
}

function deadHeadline(extract: DeadExtract): string {
  return `${count(extract.totalIssues)} issue(s) · ${extract.buckets.length} non-empty bucket(s)`;
}

function dupesHeadline(extract: DupesExtract): string {
  return `${pct(extract.duplicationPercentage)} duplicated · ${extract.cloneGroups} clone group(s)`;
}

function healthHeadline(extract: HealthExtract): string {
  const over = extract.totalFindings;
  return `${extract.score === null ? '—' : extract.score.toFixed(1)}/${extract.grade} · ${over} function(s) over threshold`;
}

function headlineFor(report: QaReport, slot: string): string {
  if (slot === 'mutation') return report.mutation === null ? '—' : mutationHeadline(report.mutation);
  if (slot === 'dead') return report.dead === null ? '—' : deadHeadline(report.dead);
  if (slot === 'dupes') return report.dupes === null ? '—' : dupesHeadline(report.dupes);
  return report.health === null ? '—' : healthHeadline(report.health);
}

function ledgerRow(report: QaReport, entry: LedgerEntry): string {
  const size = entry.file === null ? '—' : formatBytes(entry.file.bytes);
  return `| \`.check/${entry.artifact}\` | ${stateOf(entry)} | ${size} | ${ageOf(entry)} | ${headlineFor(report, entry.slot)} |`;
}

/** Where this artifact came from, when that is not "the run described above". */
function provenanceReason(entry: LedgerEntry): string | null {
  if (entry.optedIn === false) {
    return `\`${entry.slot}\` is not named in \`checkride.config.json\`, so no \`checkride\` run produces it`;
  }
  if (!entry.ranThisRun) {
    return `\`${entry.slot}\` has no entry in the summary on disk, so nothing here is from that run`;
  }
  return null;
}

function stalenessReason(entry: LedgerEntry): string | null {
  const freshness = entry.file?.freshness;
  if (freshness?.state !== 'stale') return null;
  return `the file is ${formatDuration(freshness.ageMs ?? 0)} older than that run's start`;
}

/** Why the fold produced nothing. Every problem state names itself. */
const PROBLEM_REASON: Readonly<Record<string, (entry: LedgerEntry) => string>> = {
  absent: () => 'nothing is on disk',
  'too-large': () => "the file is past this reader's parse ceiling",
  unreadable: (entry) => `the file is ${entry.detail ?? 'unparseable'}`,
  unrecognized: () => 'the file parsed but is not the report this slot writes',
};

function problemReason(entry: LedgerEntry): string | null {
  return entry.problem === null ? null : (PROBLEM_REASON[entry.problem]?.(entry) ?? null);
}

/**
 * The prose beside a row that is not plain evidence — provenance first, then
 * age, then why nothing was folded, then the remedy. A row with nothing to say
 * produces no note at all, so a clean ledger is a bare table.
 */
function ledgerNote(entry: LedgerEntry): string | null {
  const why = [provenanceReason(entry), stalenessReason(entry), problemReason(entry)].filter(
    (reason): reason is string => reason !== null,
  );
  return why.length === 0 ? null : `**${entry.slot}** — ${why.join('; ')}. ${entry.remedy}`;
}

function renderLedger(report: QaReport): string {
  const rows = report.ledger.map((entry) => ledgerRow(report, entry));
  const notes = report.ledger.map(ledgerNote).filter((note): note is string => note !== null);
  const body = table(['artifact', 'state', 'size', 'age', 'headline'], rows);
  return notes.length === 0 ? body : `${body}\n\n${bullets(notes)}`;
}

/* --------------------------------------------------------------- the head */

/**
 * How long ago the run finished. A summary stamped in the *future* is a real
 * condition — a skewed clock on the machine that wrote it — and saying so beats
 * printing a negative duration, because the same skew is what will have made
 * every artifact beside it look stale.
 */
function ageClause(ageMs: number | null): string {
  if (ageMs === null) return 'age unknown';
  if (ageMs < 0) return `stamped ${formatDuration(-ageMs)} IN THE FUTURE — the writing clock is ahead`;
  return `${formatDuration(ageMs)} ago`;
}

/**
 * Why the summary is unusable, in the words that distinguish the cases. An
 * absent `schema_version` means a stranger wrote this file, which is a
 * different report from a checkride that is simply newer than this reader.
 */
function summaryProblem(summary: SummaryRead): string {
  if (summary.state === 'foreign') return 'no `schema_version` field — NOT written by checkride';
  if (summary.state === 'schema-mismatch') return `\`schema_version\` is ${JSON.stringify(summary.found)}, not 1; STOP`;
  return summary.state;
}

/** Provenance first: what wrote these artifacts, when, and over which slots. */
function renderHead(report: QaReport): string {
  const { summary } = report;
  const at = '`.check/summary.json`';
  const provenance =
    summary.state === 'ok'
      ? `${at} — \`schema_version\` 1, ${ageClause(report.summaryAgeMs)}, ${formatDuration(summary.summary.total_duration_ms)}`
      : `${at} — ${summaryProblem(summary)}`;
  const covered =
    report.covered.length === 0
      ? 'covered: nothing — no readable summary, so the artifacts below belong to no known run'
      : `covered: ${report.covered.length} slot(s) ran — ${report.covered.join(', ')}`;
  const lines = [`summary: ${provenance}`, covered];
  if (report.skipped.length > 0) lines.push(`skipped: ${report.skipped.join(', ')}`);
  return `# checkride qa\n\n${bullets(lines)}\n\n## artifacts\n\n${renderLedger(report)}\n`;
}

/* ----------------------------------------------------------- the sections */

function mutationRow(file: MutationExtract['files'][number]): string {
  const mutators = file.mutators.map((m) => `${m.mutator} ${m.count}`).join(', ');
  return `| \`${file.path}\` | ${pct(file.score, 1)} | ${file.survived} | ${file.noCoverage} | ${file.tested} | ${mutators} |`;
}

function sampleLine(sample: MutationExtract['samples'][number]): string {
  const where = `\`${sample.path}\`${sample.line === null ? '' : `:${sample.line}`}`;
  return `${where} — ${sample.mutator} → ${code(sample.replacement)} (${sample.status})`;
}

function renderMutation(report: QaReport): string {
  const m = report.mutation;
  if (m === null) return '';
  const counts =
    `Score **${pct(m.score, 2)}** (detected ÷ tested — stryker's own headline), ${pct(m.scoreCovered, 2)} ` +
    `counting only mutants a test reaches.\n\n` +
    `${m.killed} killed · ${m.timeout} timeout · **${m.survived} survived** · **${m.noCoverage} no-coverage** · ` +
    `${m.ignored} ignored${m.other > 0 ? ` · ${m.other} errored` : ''} — ${m.total} mutant(s) over ${m.totalFiles} file(s).\n\n` +
    'No-coverage means no test reaches the line at all; survived means a test reaches it and asserts ' +
    'nothing that would notice the change. They want different fixes.';

  const rows = m.files.map(mutationRow);
  const ranking =
    `\nRanked by undetected (survived + no-coverage) count${m.omittedFiles > 0 ? `; ${m.omittedFiles} more file(s) not shown` : ''}.`;
  const mutators = `\nUndetected by mutator: ${m.mutators.map((x) => `${x.mutator} ${x.count}`).join(', ')}.`;
  const samples =
    m.samples.length === 0 ? '' : `\n\nLocated samples (worst files only):\n\n${bullets(m.samples.map(sampleLine))}`;

  return `${counts}\n\n${table(['file', 'score', 'survived', 'no-cov', 'tested', 'top undetected mutators'], rows)}\n${ranking}\n${mutators}${samples}`;
}

function renderDead(report: QaReport): string {
  const d = report.dead;
  if (d === null) return '';
  const head = `${count(d.totalIssues)} issue(s) across ${count(d.entryPoints)} entry point(s).`;
  if (d.buckets.length === 0) return `${head} No finding bucket is non-empty.`;
  const rows = d.buckets.map((b) => `| ${b.name} | ${b.count} | ${b.samples.map((s) => `\`${s}\``).join(', ')} |`);
  const omitted = d.omittedBuckets > 0 ? `\n\n${d.omittedBuckets} more non-empty bucket(s) not shown.` : '';
  return `${head}\n\n${table(['bucket', 'count', 'first few'], rows)}${omitted}`;
}

function renderDupes(report: QaReport): string {
  const d = report.dupes;
  if (d === null) return '';
  const head =
    `${pct(d.duplicationPercentage)} duplicated — ${count(d.duplicatedLines)} of ${count(d.totalLines)} line(s) ` +
    `across ${count(d.totalFiles)} file(s); ${d.cloneGroups} clone group(s) in ${d.totalFamilies} families.`;
  if (d.families.length === 0) return head;
  const rows = d.families.map((f) => {
    const files = [...f.files, ...(f.omittedFiles > 0 ? [`+${f.omittedFiles} more`] : [])];
    return `| ${files.map((x) => `\`${x}\``).join(', ')} | ${f.groups} | ${count(f.lines)} | ${count(f.tokens)} |`;
  });
  const omitted = d.omittedFamilies > 0 ? `\n\n${d.omittedFamilies} more families not shown.` : '';
  return `${head}\n\n${table(['files', 'groups', 'lines', 'tokens'], rows)}${omitted}`;
}

function healthFindingRow(finding: HealthExtract['findings'][number]): string {
  return `| \`${finding.path}\`:${count(finding.line)} | ${finding.name} | ${finding.exceeded} | ${finding.severity} | ${count(finding.cyclomatic)} | ${count(finding.cognitive)} | ${count(finding.lineCount)} |`;
}

function hotspotRow(hotspot: HealthExtract['hotspots'][number]): string {
  return `| \`${hotspot.path}\` | ${count(hotspot.score)} | ${count(hotspot.commits)} | ${count(hotspot.complexityDensity)} | ${hotspot.trend} |`;
}

function healthFindings(h: HealthExtract): string {
  const { cyclomatic, cognitive, crap, unitSize } = h.thresholds;
  const thresholds = `Thresholds — cyclomatic ${count(cyclomatic)}, cognitive ${count(cognitive)}, CRAP ${count(crap)}, unit size ${count(unitSize)}.`;
  if (h.totalFindings === 0) return `${thresholds} No function is over any of them.`;
  const grouped = h.byThreshold.map((g) => `${g.exceeded} ${g.count}`).join(', ');
  const omitted = h.omittedFindings > 0 ? `\n\n${h.omittedFindings} more finding(s) not shown.` : '';
  return (
    `${thresholds} ${h.totalFindings} function(s) over — by threshold: ${grouped}.\n\n` +
    `${table(['function', 'name', 'exceeded', 'severity', 'cyc', 'cog', 'lines'], h.findings.map(healthFindingRow))}${omitted}`
  );
}

function renderHealth(report: QaReport): string {
  const h = report.health;
  if (h === null) return '';
  const penalties =
    h.penalties.length === 0
      ? 'No penalty is non-zero.'
      : `Penalties: ${h.penalties.map((p) => `**${p.name} ${p.points}**`).join(', ')}${h.zeroPenalties > 0 ? ` (${h.zeroPenalties} more at zero)` : ''}.`;
  const head =
    `Score **${h.score === null ? '—' : h.score.toFixed(1)}** (grade ${h.grade}, formula v${count(h.formulaVersion)}) ` +
    `over ${count(h.filesAnalyzed)} file(s) and ${count(h.functionsAnalyzed)} function(s); ` +
    `average maintainability ${count(h.averageMaintainability)}.\n\n${penalties} ` +
    'The score is 100 minus these, so the non-zero ones are the whole explanation of the grade.';
  const hotspots =
    h.hotspots.length === 0
      ? ''
      : `\n\nHotspots — complex *and* frequently changed (${h.hotspots.length} of ${h.totalHotspots}):\n\n${table(['file', 'score', 'commits', 'complexity density', 'trend'], h.hotspots.map(hotspotRow))}`;
  return `${head}\n\n${healthFindings(h)}${hotspots}`;
}

/* ------------------------------------------------------------ the fitting */

type Section = { title: string; body: string };

function assemble(head: string, all: readonly Section[], kept: readonly Section[], maxBytes: number): string {
  const keeping = new Set(kept);
  const dropped = all.filter((section) => !keeping.has(section)).map((section) => section.title);
  const body = kept.map((section) => `\n## ${section.title}\n\n${section.body}\n`).join('');
  const note =
    dropped.length === 0
      ? ''
      : `\n_Trimmed to fit ${maxBytes} bytes; section(s) omitted: ${dropped.join(', ')}. ` +
        'Their headline numbers are in the ledger above; read the named artifact for the rest._\n';
  return `${head}${body}${note}\n## reading this\n\n${bullets([NOTHING_RUN_NOTE, NOT_READ_NOTE])}\n`;
}

/**
 * Fill the budget in priority order: take each section that still fits, skip
 * the ones that do not, and name what was skipped.
 *
 * Greedy rather than dropping from the end, because the sections are wildly
 * uneven — `mutation` is most of the bytes and `dupes` is a line or two — so
 * trimming the tail frees nothing until it reaches the one section worth
 * keeping, and then overshoots the budget by half. Skipping only what does not
 * fit keeps the most important section *and* whatever small ones fit around it.
 *
 * The ledger in `head` is never at risk, so every headline number survives any
 * amount of trimming. The second pass exists because the "omitted" note is
 * itself bytes: a section admitted before the note existed can stop fitting
 * once it does, and dropping from the end there converges (the note stops
 * growing once everything is dropped).
 */
function fit(head: string, sections: readonly Section[], maxBytes: number): string {
  const over = (kept: readonly Section[]): boolean =>
    Buffer.byteLength(assemble(head, sections, kept, maxBytes), 'utf8') > maxBytes;

  const kept: Section[] = [];
  for (const section of sections) {
    kept.push(section);
    if (over(kept)) kept.pop();
  }
  while (kept.length > 0 && over(kept)) kept.pop();
  return assemble(head, sections, kept, maxBytes);
}

/** Render the whole report. Deterministic: same report in, same bytes out. */
export function renderQa(report: QaReport, maxBytes: number = QA_MAX_BYTES): string {
  const sections: Section[] = [
    { title: 'mutation', body: renderMutation(report) },
    { title: 'dead', body: renderDead(report) },
    { title: 'dupes', body: renderDupes(report) },
    { title: 'health', body: renderHealth(report) },
  ].filter((section) => section.body !== '');
  return fit(renderHead(report), sections, maxBytes);
}
