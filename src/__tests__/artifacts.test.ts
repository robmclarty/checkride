import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION } from '../adapters.js';
import {
  classifyFreshness,
  formatBytes,
  formatDuration,
  parseSummary,
  readSummary,
  resolveRawOutput,
  runWindowStart,
  statArtifact,
  SUPPORTED_SCHEMA_VERSION,
  tail,
} from '../artifacts/index.js';
import type { Summary } from '../orchestrator.js';

const RUN_END_ISO = '2026-07-24T02:15:16.214Z';
const RUN_DURATION_MS = 90_000;
const WINDOW_START = Date.parse(RUN_END_ISO) - RUN_DURATION_MS;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temp repo with a `.check/` holding `files` (name → contents), each stamped `mtimeMs`. */
async function fixture(
  files: Record<string, string>,
  mtimeMs = WINDOW_START + 1000,
): Promise<{ root: string; check: string }> {
  const root = await mkdtemp(join(tmpdir(), 'checkride-artifacts-'));
  dirs.push(root);
  const check = join(root, '.check');
  await mkdir(check, { recursive: true });
  const stamp = new Date(mtimeMs);
  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const path = join(check, name);
      await writeFile(path, contents);
      await utimes(path, stamp, stamp);
    }),
  );
  return { root, check };
}

function summaryJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    timestamp: RUN_END_ISO,
    ok: true,
    checks_run: 1,
    total_duration_ms: RUN_DURATION_MS,
    checks: [
      { name: 'lint', adapter: 'oxlint', description: 'Lint', ok: true, exit_code: 0, duration_ms: 12, output_file: 'lint.json' },
    ],
    ...over,
  });
}

describe('schema pin', () => {
  // D7: the readers pin to schema 1 deliberately. If the engine bumps its
  // SCHEMA_VERSION, this test is the thing that has to be looked at — the
  // readers must be updated on purpose, never follow a bump silently.
  test('the pinned version matches the engine, so an engine bump is a deliberate update', () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });
});

describe('parseSummary', () => {
  test('reads a well-formed summary', () => {
    const read = parseSummary(summaryJson(), '/tmp/summary.json', 5);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.summary.checks).toHaveLength(1);
    expect(read.mtimeMs).toBe(5);
  });

  test('a bumped schema_version stops the reader rather than being guessed at', () => {
    const read = parseSummary(summaryJson({ schema_version: 2 }), '/tmp/summary.json', 5);
    expect(read.state).toBe('schema-mismatch');
    if (read.state !== 'schema-mismatch') return;
    expect(read.found).toBe(2);
  });

  test('a missing schema_version is a mismatch, not a default', () => {
    const read = parseSummary(JSON.stringify({ ok: true }), '/tmp/summary.json', 5);
    expect(read.state).toBe('schema-mismatch');
  });

  test('the version check precedes the shape check', () => {
    // A v2 summary may legitimately have a shape this reader cannot narrow;
    // reporting that as "unreadable" would hide the real reason.
    const read = parseSummary(JSON.stringify({ schema_version: 2, checks: 'not an array' }), '/tmp/summary.json', 5);
    expect(read.state).toBe('schema-mismatch');
  });

  test.each([
    ['not valid JSON', 'not json at all'],
    ['not a JSON object', '[1, 2, 3]'],
  ])('%s is unreadable, never a crash', (_label, raw) => {
    expect(parseSummary(raw, '/tmp/summary.json', 5).state).toBe('unreadable');
  });

  test.each([
    ['a mistyped top-level field', summaryJson({ checks_run: 'three' })],
    ['a checks[] entry missing exit_code', summaryJson({ checks: [{ name: 'lint', adapter: null, description: 'x', ok: false, duration_ms: 1, output_file: null }] })],
    ['a non-object checks[] entry', summaryJson({ checks: ['lint'] })],
  ])('%s is unreadable', (_label, raw) => {
    expect(parseSummary(raw, '/tmp/summary.json', 5).state).toBe('unreadable');
  });
});

describe('readSummary', () => {
  test('an absent summary is reported, not thrown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-artifacts-'));
    dirs.push(dir);
    const read = await readSummary(dir);
    expect(read.state).toBe('missing');
    expect(read.path).toContain(join('.check', 'summary.json'));
  });

  test('reads from disk with the file mtime attached', async () => {
    const { root } = await fixture({ 'summary.json': summaryJson() }, WINDOW_START + 2000);
    const read = await readSummary(root);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.mtimeMs).toBeCloseTo(WINDOW_START + 2000, -1);
  });
});

describe('runWindowStart', () => {
  const base: Summary = {
    schema_version: 1,
    timestamp: RUN_END_ISO,
    ok: true,
    checks_run: 1,
    total_duration_ms: RUN_DURATION_MS,
    checks: [],
  };

  test('is the run START — timestamp is stamped when the summary is BUILT', () => {
    // Comparing artifacts against `timestamp` alone would call a whole healthy
    // run stale, since every artifact it wrote is older than the summary.
    expect(runWindowStart(base)).toBe(Date.parse(RUN_END_ISO) - RUN_DURATION_MS);
  });

  test('an unparseable timestamp yields no window rather than a wrong one', () => {
    expect(runWindowStart({ ...base, timestamp: 'yesterday' })).toBeNull();
  });
});

describe('classifyFreshness', () => {
  test('a file written during the run is fresh', () => {
    expect(classifyFreshness(WINDOW_START + 500, WINDOW_START)).toEqual({ state: 'fresh', ageMs: null });
  });

  test('a file at exactly the window start is fresh', () => {
    expect(classifyFreshness(WINDOW_START, WINDOW_START).state).toBe('fresh');
  });

  test('an older file is stale and carries its age', () => {
    const fourDays = 4 * 86_400_000;
    expect(classifyFreshness(WINDOW_START - fourDays, WINDOW_START)).toEqual({ state: 'stale', ageMs: fourDays });
  });

  test('no window means unknown, never a guess in either direction', () => {
    expect(classifyFreshness(WINDOW_START, null)).toEqual({ state: 'unknown', ageMs: null });
  });
});

describe('resolveRawOutput', () => {
  test('uses output_file when the summary names one', async () => {
    const { check } = await fixture({ 'lint.json': '{}' });
    const raw = await resolveRawOutput(check, 'lint', 'lint.json', WINDOW_START);
    expect(raw?.chosen.file).toBe('lint.json');
    expect(raw?.chosen.bytes).toBe(2);
  });

  test('falls back to <slot>.stdout.txt when the summary names nothing', async () => {
    // The common case, not the edge: on a full run of this repo, 8 of 17
    // checks carry `output_file: null` while their .stdout.txt sits in .check/.
    const { check } = await fixture({ 'test.stdout.txt': 'FAIL src/x.test.ts' });
    const raw = await resolveRawOutput(check, 'test', null, WINDOW_START);
    expect(raw?.chosen.file).toBe('test.stdout.txt');
  });

  test('falls back to <slot>.json before the streams', async () => {
    const { check } = await fixture({ 'dead.json': '{"a":1}', 'dead.stdout.txt': 'much longer text than the json' });
    const raw = await resolveRawOutput(check, 'dead', null, WINDOW_START);
    expect(raw?.chosen.file).toBe('dead.json');
    expect(raw?.candidates.map((c) => c.file)).toEqual(['dead.json', 'dead.stdout.txt']);
  });

  test('prefers a smaller text sibling over a large JSON file', async () => {
    const { check } = await fixture({ 'test.json': JSON.stringify({ pad: 'y'.repeat(5000) }), 'test.stdout.txt': 'FAILED 1 test' });
    const raw = await resolveRawOutput(check, 'test', 'test.json', WINDOW_START);
    expect(raw?.chosen.file).toBe('test.stdout.txt');
    expect(raw?.candidates).toHaveLength(2);
  });

  test('keeps stderr behind stdout when stdout is already the choice', async () => {
    const { check } = await fixture({ 'build.stdout.txt': 'a long build log here', 'build.stderr.txt': 'oops' });
    const raw = await resolveRawOutput(check, 'build', null, WINDOW_START);
    expect(raw?.chosen.file).toBe('build.stdout.txt');
  });

  test('labels a stale candidate rather than dropping it', async () => {
    const { check } = await fixture({ 'mutation.json': '{}' }, WINDOW_START - 86_400_000);
    const raw = await resolveRawOutput(check, 'mutation', null, WINDOW_START);
    expect(raw?.chosen.freshness.state).toBe('stale');
  });

  test('returns null only when the slot genuinely wrote nothing', async () => {
    const { check } = await fixture({});
    expect(await resolveRawOutput(check, 'spell', null, WINDOW_START)).toBeNull();
  });
});

describe('statArtifact', () => {
  test('measures a file without opening it', async () => {
    const { check } = await fixture({ 'digest.md': '# failures\n' });
    const file = await statArtifact(check, 'digest.md', WINDOW_START);
    expect(file?.bytes).toBe(11);
    expect(file?.freshness.state).toBe('fresh');
  });

  test('an absent file is null, not a throw', async () => {
    const { check } = await fixture({});
    expect(await statArtifact(check, 'digest.md', WINDOW_START)).toBeNull();
  });

  test('a directory is not an artifact', async () => {
    const { check } = await fixture({});
    await mkdir(join(check, 'coverage'), { recursive: true });
    expect(await statArtifact(check, 'coverage', WINDOW_START)).toBeNull();
  });
});

describe('formatting', () => {
  test.each([
    [0, '0 B'],
    [483, '483 B'],
    [5120, '5.0 KB'],
    [2_411_724, '2.3 MB'],
    [2 * 1024 ** 3, '2.0 GB'],
  ])('formatBytes(%i) is %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  test.each([
    [340, '340ms'],
    [1370, '1.4s'],
    [90_000, '1.5m'],
    [4 * 86_400_000, '4.0d'],
  ])('formatDuration(%i) is %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  test('tail keeps the end and says what it dropped', () => {
    const excerpt = tail('a\n\nb\nc\nd\n', 2, 1000);
    expect(excerpt.text).toBe('c\nd');
    expect(excerpt.omittedLines).toBe(2);
    expect(excerpt.totalBytes).toBe(9);
  });

  test('tail trims further to fit the byte budget', () => {
    const excerpt = tail(['1111', '2222', '3333', ''].join('\n'), 10, 6);
    expect(excerpt.text).toBe('3333');
    expect(excerpt.omittedLines).toBe(2);
  });

  test('tail of nothing is nothing', () => {
    expect(tail('   \n\n', 10, 100).text).toBe('');
  });
});
