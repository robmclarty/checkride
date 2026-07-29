/**
 * Contract corners for the quality reader.
 *
 * The cases split in two. The first half is the *ledger*: three of the four
 * artifacts come from opt-in slots and a default consumer repo has none of
 * them, so "never opted in", "opted in but not this run" and "days older than
 * the run" are the normal states, and each has to arrive with the command that
 * would fix it (D14) rather than as a silent gap.
 *
 * The second half is the fold. Each extractor's job is to be *bounded* and
 * *faithful*: the mutation score is pinned to stryker's own arithmetic, every
 * list is capped with the remainder counted rather than dropped, and no
 * artifact's bulk — a 2.3 MB mutant array, a clone family's source fragments —
 * reaches the rendered bytes.
 *
 * Fixtures are real temp `.check/` directories because mtimes are load-bearing
 * (the freshness window). Only the clock is injected.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import type { QaReport } from '../qa/index.js';
import {
  extractDead,
  extractDupes,
  extractHealth,
  extractMutation,
  QA_MAX_BYTES,
  qaExtract,
  readJsonArtifact,
  renderQa,
} from '../qa/index.js';

const RUN_END_ISO = '2026-07-24T02:15:16.214Z';
const RUN_DURATION_MS = 20_000;
/** The freshness window's start: `timestamp` minus the run's own duration. */
const WINDOW_START = Date.parse(RUN_END_ISO) - RUN_DURATION_MS;
const FRESH_MTIME = WINDOW_START + 1000;
const EIGHT_DAYS_MS = 8 * 86_400_000;
const STALE_MTIME = WINDOW_START - EIGHT_DAYS_MS;
/** The reader's clock: a quarter-hour after the run it is reading. */
const NOW = () => Date.parse(RUN_END_ISO) + 900_000;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Json = Record<string, unknown>;

/** A schema-1 summary listing `slots` as having run. */
function summaryOf(slots: readonly string[]): Json {
  return {
    schema_version: 1,
    timestamp: RUN_END_ISO,
    ok: true,
    checks_run: slots.length,
    total_duration_ms: RUN_DURATION_MS,
    checks: slots.map((name) => ({
      name,
      adapter: name,
      description: `${name} check`,
      ok: true,
      exit_code: 0,
      duration_ms: 10,
      output_file: `${name}.json`,
    })),
  };
}

/** One artifact: its bytes (a JSON value, or raw text) and its mtime. */
type Artifact = { json?: unknown; text?: string; mtimeMs?: number };

type RepoSpec = {
  /** `checks` keys for `checkride.config.json`; omit to write no config at all. */
  configured?: readonly string[];
  /** Slots the summary reports as having run; omit to write no summary. */
  ran?: readonly string[];
  artifacts?: Record<string, Artifact>;
};

/** A temp repo that is nothing but a `.check/` directory and maybe a config. */
async function makeRepo(spec: RepoSpec): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-qa-'));
  dirs.push(dir);
  if (spec.configured) {
    const checks = Object.fromEntries(spec.configured.map((slot) => [slot, { use: slot }]));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks }));
  }
  const checkDir = join(dir, '.check');
  await mkdir(checkDir, { recursive: true });
  const files: Record<string, Artifact> = { ...spec.artifacts };
  if (spec.ran) files['summary.json'] = { json: summaryOf(spec.ran) };
  await Promise.all(
    Object.entries(files).map(async ([name, artifact]) => {
      const path = join(checkDir, name);
      await writeFile(path, artifact.text ?? JSON.stringify(artifact.json));
      const when = new Date(artifact.mtimeMs ?? FRESH_MTIME);
      await utimes(path, when, when);
    }),
  );
  return dir;
}

/** Extract and render — the two things the skill actually sees. */
async function run(spec: RepoSpec): Promise<{ report: QaReport; text: string }> {
  const report = await qaExtract(await makeRepo(spec), NOW);
  return { report, text: renderQa(report) };
}

/** The ledger row for one slot. */
/** A clone family with `fileCount` files, ranked by a descending line count. */
function cloneFamily(n: number, fileCount: number): Json {
  return {
    files: Array.from({ length: fileCount }, (_, i) => `src/f${n}-${i}.ts`),
    groups: [{}],
    total_duplicated_lines: 100 - n,
    total_duplicated_tokens: 10,
  };
}

/** A clone family with an explicit (possibly absent) line count, for ranking tests. */
function familyAt(lines: number | null, files: string[]): Json {
  return { files, groups: [], ...(lines === null ? {} : { total_duplicated_lines: lines }) };
}

function rowFor(report: QaReport, slot: string): QaReport['ledger'][number] {
  const entry = report.ledger.find((e) => e.slot === slot);
  if (entry === undefined) throw new Error(`no ledger entry for ${slot}`);
  return entry;
}

/* ------------------------------------------------------------- the ledger */

/** A minimal fallow dead-code report with no findings. */
const CLEAN_DEAD: Json = {
  kind: 'dead-code',
  schema_version: 7,
  total_issues: 0,
  entry_points: { total: 12 },
  summary: { total_issues: 0 },
  unused_exports: [],
  next_steps: ['run fallow fix'],
};

describe('the artifact ledger', () => {
  test('a default consumer repo reports three not-opted-in slots, each with its remedy', async () => {
    const { report, text } = await run({
      configured: ['types', 'lint', 'dead', 'test'],
      ran: ['types', 'lint', 'dead', 'test'],
      artifacts: { 'dead.json': { json: CLEAN_DEAD } },
    });

    for (const slot of ['mutation', 'dupes', 'health']) {
      const entry = rowFor(report, slot);
      expect(entry.optedIn, slot).toBe(false);
      expect(entry.problem, slot).toBe('absent');
      expect(entry.file, slot).toBeNull();
    }
    expect(rowFor(report, 'dead').problem).toBeNull();

    // Not-opted-in is a state with an answer, not a shrug.
    expect(text).toContain('not opted in');
    expect(text).toContain('`checkride --include mutation`');
    expect(text).toContain('`checkride --include dupes`');
    expect(text).toContain('`checkride --include health`');
    // `dead` is a default-catalogue slot, so it must NOT be sold as opt-in.
    expect(rowFor(report, 'dead').remedy).not.toContain('--include dead');
  });

  test('a repo with no config cannot know what was opted into, and says absent instead', async () => {
    const { report, text } = await run({ ran: ['types'] });
    expect(rowFor(report, 'health').optedIn).toBeNull();
    expect(text).toContain('| absent |');
    expect(text).not.toContain('not opted in');
  });

  test('an artifact older than the run start is STALE with its age, never silently current', async () => {
    const { report, text } = await run({
      configured: ['dead', 'health'],
      ran: ['dead', 'health'],
      artifacts: {
        'health.json': { json: { health_score: { score: 80.7, grade: 'B' } }, mtimeMs: STALE_MTIME },
        'dead.json': { json: CLEAN_DEAD },
      },
    });
    expect(rowFor(report, 'health').file?.freshness.state).toBe('stale');
    expect(rowFor(report, 'dead').file?.freshness.state).toBe('fresh');
    expect(text).toContain('| STALE |');
    expect(text).toContain('8.0d');
    // The headline still renders — a stale artifact is labelled, not dropped.
    expect(text).toContain('80.7/B');
  });

  test('an artifact from a slot this run never selected is attributed to an earlier run', async () => {
    const { report, text } = await run({
      configured: ['dead', 'dupes'],
      ran: ['dead'],
      artifacts: {
        'dead.json': { json: CLEAN_DEAD },
        'dupes.json': { json: { kind: 'dupes', clone_groups: [], stats: { duplication_percentage: 0 } } },
      },
    });
    expect(rowFor(report, 'dupes').ranThisRun).toBe(false);
    expect(rowFor(report, 'dupes').optedIn).toBe(true);
    expect(text).toContain('no entry in the summary on disk');
  });

  test('malformed JSON is a reported state, never a crash', async () => {
    const { report, text } = await run({
      configured: ['dead'],
      ran: ['dead'],
      artifacts: { 'dead.json': { text: '{ not json' } },
    });
    expect(rowFor(report, 'dead').problem).toBe('unreadable');
    expect(report.dead).toBeNull();
    expect(text).toContain('not a JSON object');
  });

  test('valid JSON of the wrong kind is unrecognized, never summarized as clean', async () => {
    const { report, text } = await run({
      configured: ['dead', 'dupes'],
      ran: ['dead', 'dupes'],
      // Well-formed JSON, but neither carries the field its fold reads.
      artifacts: { 'dead.json': { json: { kind: 'health' } }, 'dupes.json': { json: { stats: {} } } },
    });
    expect(rowFor(report, 'dead').problem).toBe('unrecognized');
    expect(rowFor(report, 'dupes').problem).toBe('unrecognized');
    expect(report.dead).toBeNull();
    expect(text).toContain('is not the report this slot writes');
    expect(text).not.toContain('0 issue(s)');
  });

  test('an artifact past the parse ceiling is measured and refused, not parsed', async () => {
    const dir = await makeRepo({ artifacts: { 'big.json': { json: { padding: 'x'.repeat(500) } } } });
    const read = await readJsonArtifact(join(dir, '.check'), 'big.json', WINDOW_START, 100);
    expect(read.state).toBe('too-large');
    expect(read.file?.bytes).toBeGreaterThan(100);
  });

  test('a summary whose schema_version is not 1 stops rather than guessing', async () => {
    const { text } = await run({
      artifacts: { 'summary.json': { json: { ...summaryOf(['dead']), schema_version: 2 } } },
    });
    expect(text).toContain('`schema_version` is 2, not 1; STOP');
  });

  test('the covered slot list leads, because a narrow run is still a green one', async () => {
    const { text } = await run({ configured: ['types', 'lint'], ran: ['types'] });
    expect(text).toContain('covered: 1 slot(s) ran — types');
  });

  test('a summary stamped in the future names the clock skew instead of a negative age', async () => {
    const report = await qaExtract(await makeRepo({ ran: ['dead'] }), () => Date.parse(RUN_END_ISO) - 60_000);
    const text = renderQa(report);
    expect(report.summaryAgeMs).toBeLessThan(0);
    expect(text).toContain('IN THE FUTURE');
    expect(text).not.toContain('-60000ms');
    expect(text).not.toMatch(/-\d+(ms|s|m|h|d) ago/);
  });
});

/* ----------------------------------------------------------- the mutation fold */

type MutantSpec = { status: string; mutator?: string; line?: number; replacement?: string };

function mutationOf(files: Record<string, readonly MutantSpec[]>): Json {
  return {
    schemaVersion: '1.0',
    files: Object.fromEntries(
      Object.entries(files).map(([path, mutants]) => [
        path,
        {
          language: 'typescript',
          mutants: mutants.map((m, index) => ({
            id: String(index),
            mutatorName: m.mutator ?? 'ConditionalExpression',
            replacement: m.replacement ?? 'true',
            status: m.status,
            location: { start: { line: m.line ?? 10, column: 1 }, end: { line: m.line ?? 10, column: 9 } },
          })),
        },
      ]),
    ),
  };
}

function repeat(status: string, times: number, over: Partial<MutantSpec> = {}): MutantSpec[] {
  return Array.from({ length: times }, () => ({ status, ...over }));
}

describe('the mutation fold', () => {
  test('the score is stryker\'s own: Ignored leaves the denominator, NoCoverage does not', () => {
    const extract = extractMutation(
      mutationOf({
        'a.ts': [...repeat('Killed', 6), ...repeat('Survived', 2), ...repeat('NoCoverage', 2), ...repeat('Ignored', 90)],
      }),
    );
    // 6 detected of 10 tested — the 90 ignored are excluded entirely.
    expect(extract?.score).toBeCloseTo(60, 5);
    // Covered-only drops the 2 no-coverage mutants: 6 of 8.
    expect(extract?.scoreCovered).toBeCloseTo(75, 5);
    expect(extract?.total).toBe(100);
    expect(extract?.ignored).toBe(90);
  });

  test('files rank by undetected count, so the biggest gap leads', () => {
    const extract = extractMutation(
      mutationOf({
        'small.ts': repeat('Survived', 3),
        'big.ts': [...repeat('Survived', 20), ...repeat('Killed', 200)],
        'medium.ts': [...repeat('Survived', 5), ...repeat('NoCoverage', 5)],
      }),
    );
    expect(extract?.files.map((f) => f.path)).toEqual(['big.ts', 'medium.ts', 'small.ts']);
    // The score travels with the row, so a well-tested big file stays legible.
    expect(extract?.files[0]?.score).toBeCloseTo((200 / 220) * 100, 5);
  });

  test('no-coverage is counted apart from survived — they want different fixes', () => {
    const extract = extractMutation(mutationOf({ 'a.ts': [...repeat('Survived', 4), ...repeat('NoCoverage', 7)] }));
    expect(extract?.survived).toBe(4);
    expect(extract?.noCoverage).toBe(7);
    expect(extract?.files[0]?.noCoverage).toBe(7);
  });

  test('undetected mutants tally by mutator kind, so message churn reads apart from logic gaps', () => {
    const extract = extractMutation(
      mutationOf({
        'a.ts': [
          ...repeat('Survived', 5, { mutator: 'StringLiteral' }),
          ...repeat('Survived', 2, { mutator: 'EqualityOperator' }),
          // Killed mutants must not appear in an *undetected* tally.
          ...repeat('Killed', 30, { mutator: 'ArithmeticOperator' }),
        ],
      }),
    );
    expect(extract?.mutators).toEqual([
      { mutator: 'StringLiteral', count: 5 },
      { mutator: 'EqualityOperator', count: 2 },
    ]);
  });

  test('the file list is capped and the remainder counted, never quietly dropped', () => {
    const files = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`f${i}.ts`, repeat('Survived', 20 - i)]),
    );
    const extract = extractMutation(mutationOf(files));
    expect(extract?.totalFiles).toBe(14);
    expect(extract?.files).toHaveLength(8);
    expect(extract?.omittedFiles).toBe(6);
  });

  test('samples carry a line number, and a long replacement is clipped with a marker', () => {
    const extract = extractMutation(
      mutationOf({
        'a.ts': [{ status: 'Survived', line: 412, replacement: `${'x'.repeat(200)}\nmore lines` }],
      }),
    );
    const sample = extract?.samples[0];
    expect(sample?.line).toBe(412);
    expect(sample?.replacement.endsWith('…')).toBe(true);
    expect(sample?.replacement.length).toBeLessThan(60);
  });

  test('a JSON file that is not a stryker report folds to null, not to an empty report', () => {
    expect(extractMutation({ kind: 'health' })).toBeNull();
  });

  /**
   * A file whose every mutant was `Ignored` has an empty denominator. Reporting
   * `0%` there would rank a file nobody mutates as the worst in the repo; `null`
   * says "not measurable", which is the truth.
   */
  test('a file with nothing testable scores null, not zero', () => {
    const extract = extractMutation(mutationOf({ 'ignored.ts': repeat('Ignored', 5) }));
    expect(extract?.score).toBeNull();
    expect(extract?.scoreCovered).toBeNull();
    expect(extract?.files[0]).toMatchObject({ score: null, tested: 0 });
    // A report with no files at all is still a report, not a parse failure.
    expect(extractMutation({ files: {} })).toMatchObject({ total: 0, score: null, totalFiles: 0 });
  });

  /**
   * `scoreCovered` drops NoCoverage from the denominator, so the two columns
   * diverge exactly when a file has mutants no test reaches — which is the case
   * where the headline score understates how good the *reached* tests are.
   */
  test('the covered score ignores unreached mutants where the headline score does not', () => {
    const extract = extractMutation(
      mutationOf({ 'a.ts': [...repeat('Killed', 3), ...repeat('NoCoverage', 3)] }),
    );
    expect(extract?.score).toBe(50); // 3 detected of 6 tested
    expect(extract?.scoreCovered).toBe(100); // 3 detected of 3 reached
  });

  test('an unrecognized status counts as other and stays out of the score', () => {
    // Stryker can add statuses; an unknown one must not silently become a kill.
    const extract = extractMutation(
      mutationOf({ 'a.ts': [...repeat('Killed', 2), ...repeat('CompileError', 3)] }),
    );
    expect(extract?.other).toBe(3);
    expect(extract?.score).toBe(100); // the 3 errors left the denominator
    expect(extract?.total).toBe(5); // ...but they are still in the total
  });

  test('a mutant with no usable position or name degrades instead of being dropped', () => {
    const extract = extractMutation({
      files: { 'a.ts': { mutants: [{ status: 'Survived' }, 'not an object', { status: 'Survived', location: {} }] } },
    });
    expect(extract?.survived).toBe(2); // the non-object entry was dropped
    expect(extract?.samples.map((s) => s.line)).toEqual([null, null]);
    expect(extract?.samples[0]?.mutator).toBe('unknown');
    expect(extract?.samples[0]?.replacement).toBe('');
  });

  test('a files entry that is not an object contributes nothing but still lists', () => {
    const extract = extractMutation({ files: { 'a.ts': 'nonsense', 'b.ts': { mutants: 'nonsense' } } });
    expect(extract?.totalFiles).toBe(2);
    expect(extract?.total).toBe(0);
    expect(extract?.files.every((f) => f.score === null)).toBe(true);
  });

  test('ranking falls back from undetected count to score to path', () => {
    const extract = extractMutation(
      mutationOf({
        // Same undetected count as `b`, but a worse score — ranks first.
        'b.ts': [...repeat('Survived', 2), ...repeat('Killed', 8)],
        'a.ts': [...repeat('Survived', 2), ...repeat('Killed', 2)],
        // Ties `a` on both count and score, so the path decides.
        'a0.ts': [...repeat('Survived', 2), ...repeat('Killed', 2)],
        'z.ts': [...repeat('Survived', 5)], // most undetected — first overall
      }),
    );
    expect(extract?.files.map((f) => f.path)).toEqual(['z.ts', 'a.ts', 'a0.ts', 'b.ts']);
  });
});

/* ------------------------------------------------------------- the fallow folds */

describe('the health fold', () => {
  const HEALTH: Json = {
    kind: 'health',
    health_score: {
      formula_version: 2,
      score: 80.7,
      grade: 'B',
      penalties: { hotspots: 10, unit_size: 8.5, coupling: 0.8, dead_files: 0, duplication: 0 },
    },
    summary: {
      files_analyzed: 76,
      functions_analyzed: 1661,
      average_maintainability: 91.1,
      max_cyclomatic_threshold: 15,
      max_cognitive_threshold: 15,
      max_crap_threshold: 30,
      max_unit_size_threshold: 60,
    },
    findings: [
      { path: 'src/a.ts', name: 'wide', line: 46, exceeded: 'cyclomatic', severity: 'moderate', cyclomatic: 20, cognitive: 12, line_count: 39 },
      { path: 'src/b.ts', name: 'long', line: 10, exceeded: 'unit_size', severity: 'high', cyclomatic: 4, cognitive: 3, line_count: 120 },
      { path: 'src/c.ts', name: 'knotty', line: 80, exceeded: 'cyclomatic', severity: 'high', cyclomatic: 22, cognitive: 30, line_count: 50 },
    ],
    hotspots: [{ path: 'src/a.ts', score: 48, commits: 24, complexity_density: 0.24, trend: 'accelerating' }],
  };

  test('the penalty breakdown explains the grade: non-zero ranked, zeroes counted', () => {
    const extract = extractHealth(HEALTH);
    expect(extract?.score).toBe(80.7);
    expect(extract?.grade).toBe('B');
    expect(extract?.penalties).toEqual([
      { name: 'hotspots', points: 10 },
      { name: 'unit_size', points: 8.5 },
      { name: 'coupling', points: 0.8 },
    ]);
    expect(extract?.zeroPenalties).toBe(2);
  });

  test('findings group by the threshold they breached, since each wants a different fix', () => {
    const extract = extractHealth(HEALTH);
    expect(extract?.byThreshold).toEqual([
      { exceeded: 'cyclomatic', count: 2 },
      { exceeded: 'unit_size', count: 1 },
    ]);
    expect(extract?.thresholds).toEqual({ cyclomatic: 15, cognitive: 15, crap: 30, unitSize: 60 });
  });

  /**
   * `byThreshold` is derived from *every* finding, not just the listed ones —
   * that is what makes the truncated list safe to read. A count that only
   * covered the visible eight would understate the work by exactly the amount
   * the cap hid.
   */
  test('findings and hotspots cap, but the threshold counts still span all of them', () => {
    const extract = extractHealth({
      kind: 'health',
      health_score: { score: 50, grade: 'D', penalties: {} },
      findings: [
        ...Array.from({ length: 9 }, (_, i) => ({ path: `src/c${i}.ts`, exceeded: 'cyclomatic' })),
        ...Array.from({ length: 3 }, (_, i) => ({ path: `src/u${i}.ts`, exceeded: 'unit_size' })),
      ],
      hotspots: Array.from({ length: 8 }, (_, i) => ({ path: `src/h${i}.ts` })),
    });
    expect(extract?.totalFindings).toBe(12);
    expect(extract?.findings).toHaveLength(8);
    expect(extract?.omittedFindings).toBe(4);
    // All twelve are counted, including the four the list dropped.
    expect(extract?.byThreshold).toEqual([
      { exceeded: 'cyclomatic', count: 9 },
      { exceeded: 'unit_size', count: 3 },
    ]);
    expect(extract?.totalHotspots).toBe(8);
    expect(extract?.hotspots).toHaveLength(6);
    expect(extract?.omittedHotspots).toBe(2);
  });

  test('missing fields read as explicit unknowns, never as plausible values', () => {
    const extract = extractHealth({
      kind: 'health',
      health_score: {},
      findings: [{}],
      hotspots: [{}],
    });
    expect(extract?.grade).toBe('?');
    expect(extract?.score).toBeNull();
    expect(extract?.findings[0]).toMatchObject({ path: '?', name: '?', exceeded: 'unknown', severity: 'unknown' });
    expect(extract?.hotspots[0]).toMatchObject({ path: '?', trend: 'unknown' });
    expect(extract?.thresholds).toEqual({ cyclomatic: null, cognitive: null, crap: null, unitSize: null });
  });

  test('equal penalties break the tie by name, so the ranking is stable run to run', () => {
    const extract = extractHealth({
      kind: 'health',
      health_score: { score: 90, grade: 'A', penalties: { unit_size: 5, coupling: 5, hotspots: 0, dead_files: -1 } },
    });
    expect(extract?.penalties).toEqual([
      { name: 'coupling', points: 5 },
      { name: 'unit_size', points: 5 },
    ]);
    // A zero and a negative both count as "no penalty" rather than being listed.
    expect(extract?.zeroPenalties).toBe(2);
  });

  test('a report with no health_score folds to null rather than scoring zero', () => {
    expect(extractHealth({ kind: 'dead-code', findings: [] })).toBeNull();
  });
});

describe('the dead fold', () => {
  test('only non-empty buckets survive, and report metadata is not a finding', () => {
    const extract = extractDead({
      total_issues: 3,
      summary: { total_issues: 3 },
      entry_points: { total: 44 },
      unused_exports: [
        { path: 'src/a.ts', export_name: 'gone', line: 4 },
        { path: 'src/b.ts', export_name: 'also', line: 9 },
      ],
      unused_files: [{ path: 'src/orphan.ts' }],
      unused_types: [],
      next_steps: ['run fallow fix', 'commit'],
    });
    expect(extract?.totalIssues).toBe(3);
    expect(extract?.buckets.map((b) => b.name)).toEqual(['unused_exports', 'unused_files']);
    expect(extract?.buckets[0]?.samples).toEqual(['src/a.ts:gone', 'src/b.ts:also']);
  });

  test('a report with no readable issue count folds to null, never to clean', () => {
    expect(extractDead({ kind: 'dead-code', unused_exports: [] })).toBeNull();
  });
});

describe('the dupes fold', () => {
  test('families reduce to files and totals; the duplicated source never comes along', () => {
    const extract = extractDupes({
      kind: 'dupes',
      clone_groups: [{ fingerprint: 'dup:1' }, { fingerprint: 'dup:2' }],
      clone_families: [
        {
          files: ['src/a.ts', 'src/b.ts'],
          groups: [{ instances: [{ fragment: 'SECRET SOURCE TEXT' }] }],
          total_duplicated_lines: 40,
          total_duplicated_tokens: 300,
        },
        { files: ['src/c.ts'], groups: [], total_duplicated_lines: 9, total_duplicated_tokens: 16 },
      ],
      stats: { duplication_percentage: 2.5, duplicated_lines: 49, total_lines: 1960, total_files: 31 },
    });
    expect(extract?.cloneGroups).toBe(2);
    // Ranked by duplicated lines, worst first.
    expect(extract?.families.map((f) => f.lines)).toEqual([40, 9]);
    expect(JSON.stringify(extract)).not.toContain('SECRET SOURCE TEXT');
  });

  test('a report with no clone_groups folds to null rather than reporting zero duplication', () => {
    expect(extractDupes({ kind: 'dupes', stats: {} })).toBeNull();
  });

  /**
   * The caps are the point of this module: a real duplication report is mostly
   * duplicated source text, so every list has a ceiling. What must never happen
   * is a truncated list that reads as complete — each cap reports what it
   * dropped.
   */
  test('both lists cap, and each says how much it left out', () => {
    const extract = extractDupes({
      kind: 'dupes',
      clone_groups: Array.from({ length: 9 }, () => ({})),
      clone_families: Array.from({ length: 9 }, (_, i) => cloneFamily(i, 7)),
    });
    expect(extract?.totalFamilies).toBe(9);
    expect(extract?.families).toHaveLength(6);
    expect(extract?.omittedFamilies).toBe(3);
    // ...and within a family, the file list caps the same way.
    expect(extract?.families[0]?.files).toHaveLength(4);
    expect(extract?.families[0]?.omittedFiles).toBe(3);
  });

  test('ranking falls back from lines to file count to name, so the order is total', () => {
    const extract = extractDupes({
      kind: 'dupes',
      clone_groups: [],
      clone_families: [
        familyAt(null, ['src/z.ts']), // no line count at all — sorts as 0, last
        familyAt(10, ['src/b.ts']), // same lines as the next, fewer files
        familyAt(10, ['src/a.ts', 'src/a2.ts']), // same lines, more files — wins
        familyAt(10, ['src/a.ts']), // ties b on lines and file count — name breaks it
      ],
    });
    expect(extract?.families.map((f) => f.files[0])).toEqual(['src/a.ts', 'src/a.ts', 'src/b.ts', 'src/z.ts']);
    expect(extract?.families.at(-1)?.lines).toBeNull();
  });

  test('a family whose files field is not a list of strings degrades to an empty list', () => {
    const extract = extractDupes({
      kind: 'dupes',
      clone_groups: [{}],
      clone_families: [{ files: 'src/a.ts' }, { files: [1, null, 'src/b.ts'] }],
    });
    // Both lost their line counts, so the file-count tie-break orders them:
    // the one string that survived filtering outranks the family left empty.
    expect(extract?.families.map((f) => f.files)).toEqual([['src/b.ts'], []]);
    expect(extract?.families.every((f) => f.omittedFiles === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------- the render */

describe('rendering stays bounded', () => {
  /** A repo whose every artifact is as big as its extractor will allow. */
  async function worstCase(): Promise<string> {
    const mutants = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `src/very/deeply/nested/module-number-${i}.ts`,
        repeat('Survived', 40 - i, { replacement: 'x'.repeat(200) }),
      ]),
    );
    const findings = Array.from({ length: 60 }, (_, i) => ({
      path: `src/some/long/path/file-${i}.ts`,
      name: `functionNumber${i}`,
      line: i,
      exceeded: 'cyclomatic',
      severity: 'high',
      cyclomatic: 30,
      cognitive: 30,
      line_count: 90,
    }));
    return makeRepo({
      configured: ['dead', 'dupes', 'health', 'mutation'],
      ran: ['dead', 'dupes', 'health', 'mutation'],
      artifacts: {
        'mutation.json': { json: mutationOf(mutants) },
        'health.json': {
          json: {
            health_score: { score: 12.1, grade: 'F', formula_version: 2, penalties: { hotspots: 40, unit_size: 30 } },
            summary: { files_analyzed: 400, max_cyclomatic_threshold: 15 },
            findings,
            hotspots: Array.from({ length: 30 }, (_, i) => ({ path: `src/hot-${i}.ts`, score: 90 - i, commits: 40, trend: 'accelerating' })),
          },
        },
        'dead.json': {
          json: {
            total_issues: 400,
            summary: { total_issues: 400 },
            unused_exports: Array.from({ length: 200 }, (_, i) => ({ path: `src/file-${i}.ts`, export_name: `symbol${i}` })),
            circular_dependencies: [{ cycle: ['a.ts', 'b.ts'] }],
          },
        },
        'dupes.json': {
          json: {
            clone_groups: Array.from({ length: 50 }, (_, i) => ({ fingerprint: `dup:${i}` })),
            clone_families: Array.from({ length: 20 }, (_, i) => ({
              files: Array.from({ length: 9 }, (unused, f) => `src/family-${i}/member-${f}.ts`),
              groups: [],
              total_duplicated_lines: 100 - i,
            })),
            stats: { duplication_percentage: 31.2, duplicated_lines: 900, total_lines: 2900, total_files: 60 },
          },
        },
      },
    });
  }

  test('a fully-pathological repo still renders under the 8 KB ceiling', async () => {
    const report = await qaExtract(await worstCase(), NOW);
    const text = renderQa(report);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(QA_MAX_BYTES);
    // The ledger is the head, so every headline number survives any trimming.
    expect(text).toContain('12.1/F');
    expect(text).toContain('400 issue(s)');
  });

  test('when the ceiling binds, whole sections are skipped and named', async () => {
    const report = await qaExtract(await worstCase(), NOW);
    for (const ceiling of [4000, 3000, 2500, 1500]) {
      const text = renderQa(report, ceiling);
      expect(Buffer.byteLength(text, 'utf8'), `ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);
      expect(text, `ceiling ${ceiling}`).toContain('section(s) omitted');
      // The ledger is the head, so trimming never costs a headline number.
      expect(text, `ceiling ${ceiling}`).toContain('12.1/F');
    }
  });

  test('a binding ceiling is filled, not overshot', async () => {
    const report = await qaExtract(await worstCase(), NOW);
    // The sections are wildly uneven — `mutation` is most of the bytes and
    // `dupes` is a line or two. Dropping from the end would free nothing until
    // it reached `mutation` and then land at half the budget; filling greedily
    // in priority order keeps whatever still fits around what was skipped.
    // Ceilings well clear of the fixed head, where what is skipped is the
    // whole story; below that the ledger itself dominates the budget.
    for (const ceiling of [4000, 3500, 3000]) {
      const used = Buffer.byteLength(renderQa(report, ceiling), 'utf8');
      expect(used, `ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);
      expect(used / ceiling, `ceiling ${ceiling}`).toBeGreaterThan(0.65);
    }
  });

  test('a replacement full of backticks cannot break out of its code span', async () => {
    const dir = await makeRepo({
      configured: ['mutation'],
      ran: ['mutation'],
      artifacts: {
        'mutation.json': {
          json: mutationOf({ 'a.ts': [{ status: 'Survived', line: 3, replacement: '``' }] }),
        },
      },
    });
    const text = renderQa(await qaExtract(dir, NOW));
    const line = text.split('\n').find((l) => l.includes('`a.ts`:3')) ?? '';
    // A three-backtick fence around a two-backtick payload, padded so it parses.
    expect(line).toContain('``` `` ```');
  });

  test('the report says plainly that it ran nothing and read nothing whole', async () => {
    const { text } = await run({ ran: ['dead'] });
    expect(text).toContain('This reader ran nothing');
    expect(text).toContain('Not read: the full contents of any `.check/` artifact');
  });
});
