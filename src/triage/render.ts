/**
 * Rendering a {@link TriageReport} as Markdown — what the skill actually reads.
 *
 * The output is an *index with a verdict*, never an excerpt of tool output. It
 * opens with provenance (what ran, how it ended, whether the summary on disk
 * belongs to that run, and what it covered) because every wrong triage answer
 * this reader exists to prevent comes from skipping straight to the findings.
 * Slot rows carry sizes and paths; the bytes stay on disk. The only raw text
 * that ever appears is a capped tail of the gate's own output, and only on the
 * two branches where no slot can explain the failure: the harness broke, or the
 * gate went red before checkride ran at all.
 *
 * Sections that have nothing to say render empty and drop out, so a clean run
 * is short and a pathological one is still bounded.
 */

import { formatBytes, formatDuration, tail } from '../artifacts/index.js';
import type { ArtifactFile, Freshness, RawOutput } from '../artifacts/index.js';
import type { DoctorFinding, DoctorFold } from './doctor-fold.js';
import type { GateOutcome } from './gate.js';
import type { SlotRow, TriageReport } from './triage.js';

/** Cap per captured stream: enough to see the crash, never a log dump. */
const GATE_TAIL_LINES = 25;
/** Half the single-stream budget, so rendering both streams costs no more. */
const GATE_TAIL_BYTES = 2000;

const NOT_READ_NOTE =
  'Not read: the contents of any `.check/` artifact. This reader reports sizes and ' +
  'locations only — open a listed file when its slot is the one you are working on.';

function heading(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/** `fresh`, `stale 4.1d`, or `?` when the run's timestamp could not be parsed. */
function ageCell(freshness: Freshness): string {
  if (freshness.state === 'stale') return `stale ${formatDuration(freshness.ageMs ?? 0)}`;
  return freshness.state === 'fresh' ? 'fresh' : '?';
}

function exitClause(gate: GateOutcome): string {
  if (gate.spawnError !== null) return `could not start (${gate.spawnError})`;
  if (gate.exitCode !== null) return `exit ${gate.exitCode}`;
  return gate.signal === null ? 'ended with no exit code' : `killed by ${gate.signal}`;
}

/**
 * How the summary on disk relates to the run just made — the provenance clause.
 * Named by its repo-relative path, which is how an agent would open it; the
 * absolute path is in the report model for anyone who needs it.
 */
function provenance(report: TriageReport): string {
  const { summary, fromThisRun } = report;
  const at = '`.check/summary.json`';
  if (summary.state === 'missing') return `${at} — absent; this run wrote no summary`;
  if (summary.state === 'unreadable') return `${at} — unreadable (${summary.detail})`;
  if (summary.state === 'foreign') {
    return `${at} — no \`schema_version\` field, so it was NOT written by checkride; this repo's gate is something else`;
  }
  if (summary.state === 'schema-mismatch') {
    return `${at} — \`schema_version\` is ${JSON.stringify(summary.found)}, not 1; STOP`;
  }
  const written = fromThisRun === false ? 'left by an EARLIER run' : 'written by this run';
  return `${at} — \`schema_version\` 1, ${written}, ${formatDuration(summary.summary.total_duration_ms)}`;
}

/**
 * Whether the slot table below came from a summary this reader actually parsed.
 * Everything downstream that counts slots has to ask: with no parse, `rows` is
 * empty because nothing was *read*, and rendering `0` from it would report a
 * measurement that was never taken.
 */
function summaryParsed(report: TriageReport): boolean {
  return report.summary.state === 'ok';
}

/**
 * What the run verified — or, with no parseable summary, an explicit `unknown`.
 * Zero is a measurement; the difference between "no slot was skipped" and "we
 * cannot say whether any slot was skipped" is the whole point of this line.
 */
function coveredLine(report: TriageReport): string {
  if (!summaryParsed(report)) {
    return 'covered: unknown — no summary this reader could parse, so ran, skipped and baselined counts are all unknown, NOT zero';
  }
  const { coverage } = report;
  return `covered: ${coverage.ran.length} slot(s) ran, ${coverage.skipped.length} skipped`;
}

function renderHeader(report: TriageReport): string {
  const { gate } = report;
  const lines = [
    `gate: \`${gate.command}\` → ${exitClause(gate)}${gate.verdict === 'not-run' ? '' : ` (${formatDuration(gate.durationMs)})`}`,
    gate.script === null ? 'script: none — this repo has no `check` script' : `script: \`${gate.script}\``,
    `summary: ${provenance(report)}`,
    coveredLine(report),
  ];
  return `${bullets(lines)}\n`;
}

/** The verdict sentence, keyed by how the gate ended. */
const VERDICTS: Readonly<Record<GateOutcome['verdict'], (r: TriageReport) => string>> = {
  green: greenVerdict,
  red: redVerdict,
  'harness-broken': () =>
    '**harness broken** — the gate exited 2, which checkride reserves for "the harness broke or was ' +
    'misused". No check result from this run is evidence of anything; fix the harness first.',
  'off-contract': (r) =>
    `**off-contract exit** — the gate ${exitClause(r.gate)}, which is not one of checkride's promised ` +
    '0/1/2. Something in the `check` script failed before or around checkride itself.',
  'not-run': () =>
    '**gate not run** — this repo has no `check` script, so there is nothing that defines done here. ' +
    'Run `checkride init` to add one; everything below is from whatever last wrote `.check/`.',
};

/**
 * A red gate whose summary names no failing check. The usual cause is a
 * compound `check` script — `tsc --build && node dist/cli.js`, the shape
 * `checkride init` writes — short-circuiting before checkride runs: the gate
 * exits 1, no summary is written, and whatever table follows belongs to an
 * earlier run. On this branch the gate's own output is the only evidence there
 * is, which is why it renders (see {@link renderGateOutput}).
 */
function unexplainedRed(report: TriageReport): boolean {
  return report.gate.verdict === 'red' && report.failing.length === 0;
}

/** Where to look when no slot accounts for the failure. Shared by both branches. */
function gateEvidenceClause(report: TriageReport): string {
  return `${report.gate.stdout}${report.gate.stderr}`.trim() === ''
    ? 'The gate printed nothing on either stream — re-run the `check` script by hand and read what it prints.'
    : 'The `gate output` tail below is the only evidence there is; read it first.';
}

/**
 * Why an empty slot table is the *summary's* fault rather than the run's, or
 * `null` when it is not.
 *
 * The distinction this draws is the one a reader gets wrong for free. A summary
 * that is **absent** is the compound-script short-circuit in
 * {@link redVerdict}'s last branch: checkride never ran, so it wrote nothing.
 * But a summary that *exists* and cannot be parsed says nothing whatsoever
 * about what ran — and telling an agent "checkride never ran, a compound script
 * short-circuited" on that evidence is a specific, confident, and usually false
 * diagnosis. The file is right there; what is missing is this reader's ability
 * to read it.
 */
function unparsedSummaryClause(report: TriageReport): string | null {
  const { summary } = report;
  if (summary.state === 'foreign') {
    return (
      'a `.check/summary.json` exists but carries no `schema_version`, so it was not written by checkride — ' +
      "this repo's gate is a different tool, and its artifacts follow no contract this reader can index"
    );
  }
  if (summary.state === 'schema-mismatch') {
    return (
      `\`.check/summary.json\` is \`schema_version\` ${JSON.stringify(summary.found)}, which this reader is not ` +
      'pinned to — the additive-only guarantee holds within a version and promises nothing across one'
    );
  }
  if (summary.state === 'unreadable') return `\`.check/summary.json\` could not be parsed (${summary.detail})`;
  return null;
}

function redVerdict(report: TriageReport): string {
  if (!unexplainedRed(report)) {
    return `**red** — ${report.failing.length} of ${report.coverage.ran.length} executed check(s) failed.`;
  }
  const unparsed = unparsedSummaryClause(report);
  if (unparsed !== null) {
    return (
      `**red, and the summary cannot be read** — the gate exited 1, and ${unparsed}. There is no slot table below ` +
      'because nothing was parsed, NOT because nothing failed: which slots ran, which failed, what was baselined ' +
      `and what was skipped are all unknown. ${gateEvidenceClause(report)}`
    );
  }
  return (
    '**red, but no slot explains it** — the gate exited 1 and no check in the summary failed. Something in the ' +
    '`check` script failed before checkride ran (a compound script like `tsc --build && node dist/cli.js` ' +
    `short-circuits), so nothing in the table below describes this failure. ${gateEvidenceClause(report)}`
  );
}

function greenVerdict(report: TriageReport): string {
  // Same trap as the red branch: with no parse, `coverage` is empty because
  // nothing was read, and the narrow-green sentence would report a subset that
  // was never measured. The pass itself is real — the repo's own gate exited 0
  // — but this reader cannot say what it covered, and should not imply it can.
  if (!summaryParsed(report)) {
    return (
      "**green, with no index** — the gate exited 0, so the repo's own definition of done was met, but no summary " +
      'this reader can parse says what that covered. Report the pass; do not attach a slot count to it. See the ' +
      'header for why the summary could not be read.'
    );
  }
  if (report.vacuous) {
    return (
      '**vacuous green** — the gate exited 0 but `checks_run` is 0: nothing was verified. This is a ' +
      'failure wearing a pass. Find out why no check was selected before believing anything else here.'
    );
  }
  if (report.gate.narrowingFlags.length > 0 || report.coverage.uncovered.length > 0) {
    return (
      `**green, but narrow** — ${report.coverage.ran.length} check(s) passed and that is all this run ` +
      'verified. See coverage below before calling the work done.'
    );
  }
  return `**green** — ${report.coverage.ran.length} check(s) passed.`;
}

function renderVerdict(report: TriageReport): string {
  return heading('verdict', VERDICTS[report.gate.verdict](report));
}

function renderDoctorFold(fold: DoctorFold): string {
  if (fold.state !== 'ran') return `\`checkride doctor\` could not be consulted: ${fold.reason}.`;
  if (fold.findings.length === 0) {
    return `\`checkride doctor\` exited ${fold.exitCode ?? '?'} and found no broken requirement — the ` +
      'break is in the `check` script or in checkride itself, not in the environment.';
  }
  return `\`checkride doctor\` exited ${fold.exitCode ?? '?'} — ${fold.findings.length} required check(s) not ok:\n\n${bullets(fold.findings.map(findingLine))}`;
}

function findingLine(finding: DoctorFinding): string {
  const found = finding.found ?? 'not found';
  const expected = finding.expected === null ? '' : `, expected ${finding.expected}`;
  const hint = finding.hint === null ? '' : ` — ${finding.hint}`;
  return `**${finding.name}** (${finding.status}): ${found}${expected}${hint}`;
}

/** A bounded tail of one captured stream, or `''` when it caught nothing. */
function streamExcerpt(label: string, stream: string): string {
  const { text, omittedLines, totalBytes } = tail(stream, GATE_TAIL_LINES, GATE_TAIL_BYTES);
  if (text === '') return '';
  const kept = text.split('\n').length;
  const omitted = omittedLines > 0 ? ` — last ${kept} of ${omittedLines + kept} lines` : '';
  return `**${label}** — ${formatBytes(totalBytes)} captured${omitted}\n\n\`\`\`\n${text}\n\`\`\``;
}

/**
 * The gate's own output — the only raw text this reader ever prints, and only
 * where no slot can account for the failure: the harness broke (exit 2 or
 * off-contract, where `doctor` is folded in beside it) or the gate went red
 * with nothing failing in the summary. On any other branch the raw file named
 * in the table is the evidence, and printing the gate's output would spend the
 * context this reader exists to save.
 *
 * Both streams render, because which one carries the diagnosis is the tool's
 * choice and not knowable here. checkride's own discipline puts diagnostics on
 * stderr, but the compound script this branch usually catches fails in `tsc`,
 * which reports on *stdout* — measured on this repo, where a type error leaves
 * `error TS2322` on stdout and nothing but pnpm's command echo on stderr. This
 * is the render-side twin of the judgment `../artifacts/raw.ts` declines to
 * make: show both rather than guess which stream a stranger's tool used.
 */
function renderGateOutput(report: TriageReport): string {
  if (report.doctor === null && !unexplainedRed(report)) return '';
  const streams = [
    streamExcerpt('stderr', report.gate.stderr),
    streamExcerpt('stdout', report.gate.stdout),
  ].filter((excerpt) => excerpt !== '');
  return streams.length === 0 ? '' : heading('gate output', streams.join('\n\n'));
}

/** The broken-harness diagnosis, folded in on the branch that has one. */
function renderDoctor(report: TriageReport): string {
  return report.doctor === null ? '' : heading('doctor', renderDoctorFold(report.doctor));
}

function renderCoverage(report: TriageReport): string {
  const { coverage, gate } = report;
  const lines: string[] = [];
  if (gate.narrowingFlags.length > 0) {
    lines.push(`The \`check\` script narrows the run on purpose (${gate.narrowingFlags.join(', ')}). A green here is green *for those slots*.`);
  }
  if (!summaryParsed(report)) {
    lines.push('What this run covered is unknown — there is no parseable summary to read it from.');
  } else if (coverage.configured === null) {
    lines.push('This repo has no `checkride.config.json`, so the slots below are simply what the run selected — this reader will not guess at the default catalogue.');
  } else if (coverage.uncovered.length > 0) {
    lines.push(`\`checkride.config.json\` names ${coverage.configured.length} slot(s); ${coverage.uncovered.length} had no entry in this run: ${coverage.uncovered.join(', ')}.`);
  } else {
    lines.push(`Every slot named in \`checkride.config.json\` (${coverage.configured.length}) has an entry in this run.`);
  }
  return heading('coverage', lines.join('\n\n'));
}

const TABLE_HEAD = '| slot | adapter | result | exit | ms | raw output | size | age |\n| --- | --- | --- | --- | --- | --- | --- | --- |';

function rawCells(row: SlotRow): string {
  if (row.raw === null) return '— | — | —';
  const { chosen } = row.raw;
  const extra = row.raw.candidates.length > 1 ? ` (+${row.raw.candidates.length - 1})` : '';
  return `\`.check/${chosen.file}\`${extra} | ${formatBytes(chosen.bytes)} | ${ageCell(chosen.freshness)}`;
}

function tableRow(row: SlotRow): string {
  const baselined = row.baselined === null ? '' : ` (${row.baselined} baselined)`;
  return `| ${row.slot} | ${row.adapter ?? '—'} | ${row.status}${baselined} | ${row.exitCode ?? '—'} | ${Math.round(row.durationMs)} | ${rawCells(row)} |`;
}

function renderChecks(report: TriageReport): string {
  if (report.rows.length === 0) return '';
  return heading('checks', [TABLE_HEAD, ...report.rows.map(tableRow)].join('\n'));
}

/** Rows past this are counted rather than listed — bounded, but never silently. */
const CHECK_DIR_LIMIT = 40;

const CHECK_DIR_HEAD = '| file | size | age |\n| --- | --- | --- |';

/**
 * Everything in `.check/`, measured — rendered only when the summary could not
 * be parsed, because then it is the only inventory there is. Without it the
 * report's answer to "what is even in there?" is silence, and an agent's next
 * move is an unbounded `ls` plus a guess at which files belong to this run.
 *
 * Ages here are measured against the *gate's own start*, not the summary's
 * window: this reader ran the gate and knows when, which is a firmer anchor
 * than a timestamp inside a file it could not read.
 */
function renderCheckDir(report: TriageReport): string {
  const files = report.checkDir;
  if (files === null || files.length === 0) return '';
  const shown = files.slice(0, CHECK_DIR_LIMIT);
  const rows = shown.map((f) => `| \`.check/${f.file}\` | ${formatBytes(f.bytes)} | ${ageCell(f.freshness)} |`);
  const omitted = files.length - shown.length;
  const note = omitted === 0 ? '' : `\n\n${omitted} further file(s) present and not listed.`;
  const body =
    'No parseable summary, so this listing is the index. `fresh` means the file was written after this run\'s ' +
    'gate started; `stale` means it is a leftover from something earlier and describes no part of this run.\n\n' +
    `${[CHECK_DIR_HEAD, ...rows].join('\n')}${note}`;
  return heading('.check/ contents', body);
}

/** One alternate, named and sized — a stale one carries its age, never dropped. */
function alternate(file: ArtifactFile): string {
  const stale = file.freshness.state === 'stale' ? `, stale ${formatDuration(file.freshness.ageMs ?? 0)}` : '';
  return `\`.check/${file.file}\` (${formatBytes(file.bytes)}${stale})`;
}

/**
 * The candidates the chosen file was picked over, named rather than counted.
 * The table's `(+N)` is a width compromise; here there is room, and a bare
 * count is not actionable — a reader told the chosen file gives a count but not
 * a location has to guess which sibling holds the location.
 */
function alternatesClause(raw: RawOutput): string {
  const others = raw.candidates.filter((file) => file.file !== raw.chosen.file);
  return others.length === 0 ? '' : `; also: ${others.map(alternate).join(', ')}`;
}

function failingLine(row: SlotRow, index: number): string {
  const where = row.raw === null
    ? 'no output file found under `.check/` — the tool wrote nothing this reader can locate'
    : `read \`.check/${row.raw.chosen.file}\` (${formatBytes(row.raw.chosen.bytes)})${alternatesClause(row.raw)}`;
  return `${index + 1}. **${row.slot}** (${row.adapter ?? 'no adapter'}) — exit ${row.exitCode ?? '—'} — ${where}`;
}

function renderFailing(report: TriageReport): string {
  if (report.failing.length === 0) return '';
  const body =
    report.failing.map(failingLine).join('\n') +
    '\n\nListed in pipeline order (the summary\'s deterministic order), not by importance — ' +
    'a failure early in the pipeline is often the cause of the ones after it.';
  return heading('failing slots', body);
}

function renderDigest(report: TriageReport): string {
  const { digest } = report;
  if (digest === null) {
    // Only a run this reader can index supports the `--digest` explanation;
    // a gate it could not parse may have no such flag to pass.
    const why = summaryParsed(report) ? 'this run passed no `--digest`, so there is' : 'there is';
    return heading('digest', `No \`.check/digest.md\`: ${why} no pre-built excerpt. Read the raw files above.`);
  }
  if (digest.freshness.state === 'stale') {
    return heading('digest', `\`.check/digest.md\` (${formatBytes(digest.bytes)}) is from an EARLIER run — ${formatDuration(digest.freshness.ageMs ?? 0)} before this one started. Do not read it as this run's failures.`);
  }
  return heading('digest', `\`.check/digest.md\` (${formatBytes(digest.bytes)}) — checkride's own bounded excerpt of this run's failing slots. Read it before any raw file.`);
}

function baselineCaveats(rows: readonly SlotRow[]): string[] {
  return rows
    .filter((r) => r.baselined !== null)
    .map((r) => `\`${r.slot}\` reports \`baselined: ${r.baselined}\` — that many current findings are grandfathered by \`checkride.baseline.json\`. Passing here does not mean clean.`);
}

function skipCaveats(rows: readonly SlotRow[]): string[] {
  return rows
    .filter((r) => r.status === 'skipped')
    .map((r) => `\`${r.slot}\` skipped: ${r.reason ?? 'no reason given'}. It verified nothing this run.`);
}

function staleCaveats(stale: readonly ArtifactFile[]): string[] {
  return stale.map((f) => `\`.check/${f.file}\` is ${formatDuration(f.freshness.ageMs ?? 0)} older than this run's start — a leftover, not this run's output.`);
}

function spawnFailureCaveats(rows: readonly SlotRow[]): string[] {
  return rows
    .filter((r) => r.exitCode === -1)
    .map((r) => `\`${r.slot}\` has \`exit_code: -1\` — it failed to spawn or timed out. That is a harness problem, not a finding.`);
}

/**
 * What the summary's own state costs everything below it.
 *
 * The unparsed case earns a caveat of its own because the absence of findings
 * reads as their absence in the repo. `baselined` and `skipped` are the sharp
 * edges: both are silent by construction — a baselined slot *passes* and a
 * skipped one reports nothing — so with no summary to name them, "no caveats
 * were raised" and "no caveats could be raised" look identical on the page.
 */
function summaryCaveats(report: TriageReport): string[] {
  if (report.summary.state !== 'ok') {
    return [
      '`.check/summary.json` could not be parsed, so there is no slot table: `baselined` and `skipped` counts are ' +
        '**unknown**, not zero, and no slot in this repo can be reported as passing on this run\'s evidence.',
    ];
  }
  if (report.fromThisRun !== false) return [];
  return ['`.check/summary.json` predates the run just made, so the table above describes an earlier run. Everything in it is suspect.'];
}

function renderCaveats(report: TriageReport): string {
  const items = [
    ...summaryCaveats(report),
    ...baselineCaveats(report.rows),
    ...spawnFailureCaveats(report.rows),
    ...skipCaveats(report.rows),
    ...staleCaveats(report.stale),
    NOT_READ_NOTE,
  ];
  return heading('caveats', bullets(items));
}

const SECTIONS: readonly ((report: TriageReport) => string)[] = [
  renderHeader,
  renderVerdict,
  renderGateOutput,
  renderDoctor,
  renderCoverage,
  renderChecks,
  renderCheckDir,
  renderFailing,
  renderDigest,
  renderCaveats,
];

/** Render the whole report. Deterministic: same report in, same bytes out. */
export function renderTriage(report: TriageReport): string {
  const body = SECTIONS.map((section) => section(report))
    .filter((text) => text !== '')
    .join('\n');
  return `# checkride triage\n\n${body}`;
}
