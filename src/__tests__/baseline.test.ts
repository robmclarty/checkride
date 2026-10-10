import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { Baseline, GitResult, GitRunner } from '../baseline/index.js';
import {
  applyBaseline,
  BASELINE_SCHEMA_VERSION,
  baselinesEqual,
  fingerprint,
  isFingerprintable,
  loadBaseline,
  parseBaseline,
  ratchet,
  readBaselineStatus,
  writeBaseline,
} from '../baseline/index.js';
import { runBaseline, runBaselineDiff } from '../baseline-command.js';
import { runCli } from '../cli.js';
import type { CheckRunner, Out } from '../orchestrator/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const OXLINT = read('baseline-oxlint.json');
const AST_GREP = read('baseline-ast-grep.json');
const CSPELL = read('baseline-cspell.txt');
const VALE = read('baseline-vale.json');
const VALE_ERROR = read('baseline-vale-error.json');

function sink(): Out {
  return { write: () => true };
}

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

/** The three fingerprintable slots plus `types`, whose adapter (tsc) sits out. */
const slots = [{ name: 'lint' }, { name: 'struct' }, { name: 'spell' }, { name: 'types' }];
const adapters = [
  fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' }),
  fakeAdapter({ name: 'ast-grep', slot: 'struct', outputFile: 'struct.json' }),
  fakeAdapter({ name: 'cspell', slot: 'spell' }),
  fakeAdapter({ name: 'tsc', slot: 'types' }),
];

/** Feed each slot its fixture on stdout; an empty payload passes (green). */
function runnerFor(payloads: Record<string, string>): CheckRunner {
  return (r) => {
    const stdout = payloads[r.slot] ?? '';
    return Promise.resolve({ ok: stdout === '', exit_code: stdout === '' ? 0 : 1, stdout, stderr: '' });
  };
}

const RED = runnerFor({ lint: OXLINT, struct: AST_GREP, spell: CSPELL });

describe('runBaseline', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function readBaseline(): Promise<Baseline> {
    return JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as Baseline;
  }

  test('writes checkride.baseline.json with per-slot fingerprint key sets', async () => {
    const result = await runBaseline({
      cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink(),
    });
    const written = await readBaseline();

    expect(written.schema_version).toBe(1);
    expect(new Set(written.slots['lint'])).toEqual(fingerprint('oxlint', OXLINT));
    expect(new Set(written.slots['struct'])).toEqual(fingerprint('ast-grep', AST_GREP));
    expect(new Set(written.slots['spell'])).toEqual(fingerprint('cspell', CSPELL));
    expect(result.baseline).toEqual(written);
    expect(result.exitCode).toBe(0);
  });

  test('a slot with no extractor never appears in the baseline', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink() });
    const written = await readBaseline();
    // tsc ran (types) but has no fingerprint extractor, so it is omitted entirely.
    expect(Object.keys(written.slots).toSorted()).toEqual(['lint', 'spell', 'struct']);
  });

  test('keys are stored sorted and order-independent', async () => {
    await runBaseline({ cwd: dir, slots, adapters, config: null, runner: RED, stdout: sink(), stderr: sink() });
    const lint = (await readBaseline()).slots['lint'] ?? [];
    expect(lint).toEqual([...lint].toSorted());
    expect(lint.length).toBeGreaterThan(0);
  });

  test('a fingerprintable-but-clean slot records an empty array (opted in, no debt)', async () => {
    await runBaseline({
      cwd: dir, slots, adapters, config: null, runner: runnerFor({}), stdout: sink(), stderr: sink(),
    });
    const written = await readBaseline();
    // Every fingerprintable slot that ran is present; each is empty since nothing failed.
    expect(written.slots).toEqual({ lint: [], struct: [], spell: [] });
  });

  test('a red prose slot is captured, and the capture masks it green', async () => {
    const proseSlots = [{ name: 'lint' }, { name: 'prose' }];
    const proseAdapters = [...adapters, fakeAdapter({ name: 'vale', slot: 'prose', outputFile: 'prose.json' })];
    await runBaseline({
      cwd: dir,
      slots: proseSlots,
      adapters: proseAdapters,
      config: null,
      runner: runnerFor({ lint: OXLINT, prose: VALE }),
      stdout: sink(),
      stderr: sink(),
    });
    const keys = (await readBaseline()).slots['prose'] ?? [];
    const current = fingerprint('vale', VALE) ?? new Set<string>();

    expect(new Set(keys)).toEqual(current);
    expect(applyBaseline(current, keys, false)).toEqual({ ok: true, baselined: keys.length, newKeys: [] });
  });

  test('a prose run vale could not read is omitted, never captured as clean', async () => {
    // An E201 report reads as an alert report with zero alerts unless the
    // extractor is shape-aware; capturing `prose: []` from one would grandfather
    // nothing and prune everything the next ratchet touched.
    const proseSlots = [{ name: 'lint' }, { name: 'prose' }];
    const proseAdapters = [...adapters, fakeAdapter({ name: 'vale', slot: 'prose', outputFile: 'prose.json' })];
    await runBaseline({
      cwd: dir,
      slots: proseSlots,
      adapters: proseAdapters,
      config: null,
      runner: runnerFor({ lint: OXLINT, prose: VALE_ERROR }),
      stdout: sink(),
      stderr: sink(),
    });
    const written = await readBaseline();

    // `lint` proves the run happened; `prose` is absent rather than empty.
    expect(written.slots['lint']?.length).toBeGreaterThan(0);
    expect(written.slots).not.toHaveProperty('prose');
  });

  test('skipped slots contribute nothing (no adapter, no output)', async () => {
    await runBaseline({
      cwd: dir,
      slots,
      adapters,
      // Disable spell in config → resolves to skipped, so it never runs or fingerprints.
      config: { checks: { spell: false } },
      runner: RED,
      stdout: sink(),
      stderr: sink(),
    });
    const written = await readBaseline();
    expect(written.slots).not.toHaveProperty('spell');
    expect(Object.keys(written.slots).toSorted()).toEqual(['lint', 'struct']);
  });
});

describe('applyBaseline (masking)', () => {
  test('all diagnostics grandfathered → flips a fail to a pass and counts them', () => {
    const adj = applyBaseline(new Set(['a', 'b']), ['a', 'b'], false);
    expect(adj).toEqual({ ok: true, baselined: 2, newKeys: [] });
  });

  test('a new diagnostic keeps the slot failing and lists only the new key', () => {
    const adj = applyBaseline(new Set(['a', 'b', 'c']), ['a', 'b'], false);
    expect(adj).toEqual({ ok: false, baselined: 2, newKeys: ['c'] });
  });

  test('never masks a failure with no parseable diagnostics (a crash stays red)', () => {
    const adj = applyBaseline(new Set(), ['a'], false);
    expect(adj).toEqual({ ok: false, baselined: 0, newKeys: [] });
  });

  test('a clean run stays green whatever the baseline holds', () => {
    expect(applyBaseline(new Set(), ['a'], true).ok).toBe(true);
  });

  test('newKeys are returned sorted, order-independent of the input set', () => {
    expect(applyBaseline(new Set(['z', 'a', 'm']), [], false).newKeys).toEqual(['a', 'm', 'z']);
  });
});

describe('ratchet (the pruning invariant)', () => {
  test('drops fixed keys from observed slots, preserves unobserved ones', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'], spell: ['x'] } };
    const observed = new Map([['lint', new Set(['a'])]]); // spell never ran this pass
    const pruned = ratchet(baseline, observed);
    expect(pruned.slots['lint']).toEqual(['a']); // b was fixed → pruned
    expect(pruned.slots['spell']).toEqual(['x']); // unobserved → preserved intact
  });

  test('never grows: a new current key is not grandfathered', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a'] } };
    const pruned = ratchet(baseline, new Map([['lint', new Set(['a', 'b'])]]));
    expect(pruned.slots['lint']).toEqual(['a']);
  });

  test('an observed slot with everything fixed collapses to an empty set', () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] } };
    const pruned = ratchet(baseline, new Map([['lint', new Set<string>()]]));
    expect(pruned.slots['lint']).toEqual([]);
  });
});

describe('baselinesEqual', () => {
  test('order-independent across slot and key ordering', () => {
    const a: Baseline = { schema_version: 1, slots: { lint: ['b', 'a'], spell: ['x'] } };
    const b: Baseline = { schema_version: 1, slots: { spell: ['x'], lint: ['a', 'b'] } };
    expect(baselinesEqual(a, b)).toBe(true);
  });

  test('detects a pruned key', () => {
    const a: Baseline = { schema_version: 1, slots: { lint: ['a'] } };
    const b: Baseline = { schema_version: 1, slots: { lint: [] } };
    expect(baselinesEqual(a, b)).toBe(false);
  });
});

describe('loadBaseline / writeBaseline', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-store-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('round-trips a baseline through disk', async () => {
    const baseline: Baseline = { schema_version: 1, slots: { lint: ['a', 'b'] } };
    await writeBaseline(dir, baseline);
    expect(loadBaseline(dir)).toEqual(baseline);
  });

  test('returns null when the file is absent', () => {
    expect(loadBaseline(dir)).toBeNull();
  });

  test('coerces a malformed file rather than throwing (never breaks a run)', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '{ not json');
    expect(loadBaseline(dir)).toBeNull();
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: ['a', 5, 'b'] } }));
    expect(loadBaseline(dir)?.slots['lint']).toEqual(['a', 'b']); // non-strings dropped
  });

  /**
   * `slots` is a map from slot name to keys. An array passed the old guard
   * (`typeof [] === 'object'`), and `Object.entries` then keyed the baseline by
   * array *index* — a file that masked nothing while looking like it loaded.
   */
  test('rejects a slots array instead of keying it by index', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: [['a']] }));
    expect(loadBaseline(dir)).toBeNull();
  });

  /**
   * Fail closed on a baseline from a newer checkride: the fields this version
   * cannot see are the ones that say what is masked and why. Dropping it
   * re-surfaces the real diagnostics (more red), where guessing risks masking
   * findings the author never grandfathered.
   */
  test('drops a baseline from a newer schema version rather than half-reading it', async () => {
    const path = join(dir, 'checkride.baseline.json');
    await writeFile(path, JSON.stringify({ schema_version: BASELINE_SCHEMA_VERSION + 1, slots: { lint: ['a'] } }));
    expect(loadBaseline(dir)).toBeNull();
    // The current version, and an older one, still load.
    await writeFile(path, JSON.stringify({ schema_version: BASELINE_SCHEMA_VERSION, slots: { lint: ['a'] } }));
    expect(loadBaseline(dir)?.slots['lint']).toEqual(['a']);
  });

  /**
   * Canonical on disk: two branches that grandfather the same debt must produce
   * byte-identical files, whatever order their runs discovered the slots in —
   * otherwise insertion order alone manufactures merge conflicts.
   */
  test('writes canonically: sorted slots and unique keys, byte-stable across construction order', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { spell: ['z', 'a', 'a'], lint: ['b'] } });
    const raw = await readFile(join(dir, 'checkride.baseline.json'), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    expect(Object.keys(parsed.slots)).toEqual(['lint', 'spell']);
    // Sorted, and the key a merge doubled is written once — slots are sets.
    expect(parsed.slots['spell']).toEqual(['a', 'z']);
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['b'], spell: ['a', 'z'] } });
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(raw);
  });

  test('parseBaseline applies the same tolerance to raw text (a git-show blob)', () => {
    expect(parseBaseline('{ not json')).toBeNull();
    expect(parseBaseline(JSON.stringify({ schema_version: 1, slots: { lint: ['a', 5] } }))?.slots['lint']).toEqual(['a']);
  });
});

describe('readBaselineStatus', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-status-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /**
   * Absent and unparseable both mask nothing, but they are different diagnoses:
   * absent is a repo without a baseline, unparseable is a file somebody (often
   * a merge) mangled. The run's warning hangs off this distinction.
   */
  test('distinguishes absent, ok, and unparseable', async () => {
    expect(readBaselineStatus(dir)).toEqual({ baseline: null, state: 'absent' });
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{ mangled\n');
    expect(readBaselineStatus(dir)).toEqual({ baseline: null, state: 'unparseable' });
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a'] } });
    expect(readBaselineStatus(dir).state).toBe('ok');
  });
});

describe('isFingerprintable', () => {
  test('true for adapters with an extractor, false for the rest', () => {
    expect(isFingerprintable('oxlint')).toBe(true);
    expect(isFingerprintable('ast-grep')).toBe(true);
    expect(isFingerprintable('cspell')).toBe(true);
    expect(isFingerprintable('fallow')).toBe(true);
    expect(isFingerprintable('vale')).toBe(true);
    expect(isFingerprintable('tsc')).toBe(false);
    expect(isFingerprintable('knip')).toBe(false);
  });
});

function capture(): { out: Out; text: () => string } {
  const chunks: string[] = [];
  return { out: { write: (t: string) => { chunks.push(t); return true; } }, text: () => chunks.join('') };
}

const blob = (keys: Record<string, string[]>): string => JSON.stringify({ schema_version: 1, slots: keys });

type FakeRefs = {
  prefix?: string;
  /** Ref → sha; a ref missing here names no commit. */
  refs?: Record<string, string>;
  /** Sha → the committed file's text; a sha missing here has no file. */
  files?: Record<string, string>;
  /** Per-subcommand failure overrides. */
  fail?: Record<string, GitResult>;
};

const answered = (stdout: string): GitResult => ({ ok: true, stdout });

function answerRevParse(repo: FakeRefs, args: readonly string[]): GitResult {
  if (args[1] === '--show-toplevel') return answered(`/repo\n${repo.prefix ?? ''}\nfalse\n`);
  const sha = repo.refs?.[(args[3] ?? '').replace(/\^\{commit\}$/, '')];
  return sha === undefined ? { ok: false, error: 'failed', detail: 'git rev-parse failed' } : answered(`${sha}\n`);
}

function answerShow(repo: FakeRefs, spec: string): GitResult {
  const text = repo.files?.[spec.split(':')[0] ?? ''];
  return text === undefined ? { ok: false, error: 'failed', detail: 'path does not exist' } : answered(text);
}

function answerLsTree(repo: FakeRefs, args: readonly string[]): GitResult {
  return answered(repo.files?.[args[3] ?? ''] === undefined ? '' : `${args[5] ?? ''}\n`);
}

const ANSWERS: Record<string, (repo: FakeRefs, args: readonly string[]) => GitResult> = {
  'rev-parse': answerRevParse,
  'ls-tree': answerLsTree,
  show: (repo, args) => answerShow(repo, args[1] ?? ''),
};

function answerDiff(repo: FakeRefs, args: readonly string[]): GitResult {
  const sub = args[0] ?? '';
  const answer = ANSWERS[sub];
  return repo.fail?.[sub] ?? answer?.(repo, args) ?? { ok: false, error: 'failed', detail: `unexpected: ${sub}` };
}

/** A scripted git for `baseline diff`: answers from the fixture, records every invocation. */
function diffGit(repo: FakeRefs): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    return Promise.resolve(answerDiff(repo, args));
  };
  return Object.assign(runner, { calls });
}

const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

describe('runBaselineDiff (unit, injected git)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-diff-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const writeCurrent = (keys: Record<string, string[]>): Promise<void> => writeBaseline(dir, { schema_version: 1, slots: keys });

  test('prints the keys added and removed per check, against HEAD by default', async () => {
    await writeCurrent({ lint: ['a', 'c'], struct: [] });
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({ lint: ['a', 'b'], spell: ['s'] }) } });
    const out = capture();
    const result = await runBaselineDiff({ cwd: dir, git, stdout: out.out });
    expect(result.exitCode).toBe(0);
    expect(result.diff).toEqual({
      ref: 'HEAD',
      sha: HEAD_SHA,
      added: { lint: ['c'] },
      removed: { lint: ['b'], spell: ['s'] },
      added_count: 1,
      removed_count: 2,
    });
    expect(out.text()).toBe(
      [
        '# checkride baseline diff: HEAD (aaaaaaa) to the working tree',
        '',
        '1 key(s) added, 2 removed.',
        '',
        '## lint: 1 added, 1 removed',
        '',
        '+ c',
        '- b',
        '',
        '## spell: 0 added, 1 removed',
        '',
        '- s',
        '',
      ].join('\n'),
    );
  });

  test('--json prints the diff object and nothing else', async () => {
    await writeCurrent({ lint: ['a', 'c'] });
    const git = diffGit({ refs: { 'origin/main': OLD_SHA }, files: { [OLD_SHA]: blob({ lint: ['a'] }) } });
    const out = capture();
    const result = await runBaselineDiff({ cwd: dir, git, ref: 'origin/main', json: true, stdout: out.out });
    expect(JSON.parse(out.text())).toEqual(result.diff);
    expect(result.diff).toMatchObject({ ref: 'origin/main', sha: OLD_SHA, added: { lint: ['c'] }, removed: {} });
  });

  // F30: a ref from before the baseline existed.
  test('a ref with no baseline file reports every current key as added', async () => {
    await writeCurrent({ lint: ['a', 'b'], spell: ['s'] });
    const git = diffGit({ refs: { HEAD: HEAD_SHA } });
    const { diff } = await runBaselineDiff({ cwd: dir, git, stdout: capture().out });
    expect(diff).toMatchObject({ added: { lint: ['a', 'b'], spell: ['s'] }, removed: {}, added_count: 3, removed_count: 0 });
    // Told apart by listing the tree: the file was never `git show`n.
    expect(git.calls.some((c) => c[0] === 'show')).toBe(false);
  });

  test('a working tree with no baseline file reports every committed key as removed', async () => {
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({ lint: ['a'] }) } });
    const { diff } = await runBaselineDiff({ cwd: dir, git, stdout: capture().out });
    expect(diff).toMatchObject({ added: {}, removed: { lint: ['a'] }, added_count: 0, removed_count: 1 });
  });

  test('an unchanged file says so', async () => {
    await writeCurrent({ lint: ['a'] });
    const git = diffGit({ refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({ lint: ['a'] }) } });
    const out = capture();
    await runBaselineDiff({ cwd: dir, git, stdout: out.out });
    expect(out.text()).toContain('No keys added or removed since HEAD.');
  });

  test('reads the committed file at its path from the git root, as a monorepo package', async () => {
    await writeCurrent({});
    const git = diffGit({ prefix: 'packages/app/', refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({}) } });
    await runBaselineDiff({ cwd: dir, git, stdout: capture().out });
    expect(git.calls).toContainEqual(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    expect(git.calls).toContainEqual(['ls-tree', '--full-tree', '--name-only', HEAD_SHA, '--', 'packages/app/checkride.baseline.json']);
    expect(git.calls).toContainEqual(['show', `${HEAD_SHA}:packages/app/checkride.baseline.json`]);
  });

  test.each<{ label: string; repo: FakeRefs; ref?: string; message: RegExp }>([
    { label: 'a ref that names no commit', repo: { refs: {} }, ref: 'nope', message: /'nope' does not name a commit/ },
    { label: 'a ref that reads as an option', repo: { refs: { HEAD: HEAD_SHA } }, ref: '--output=x', message: /'--output=x' is not a ref/ },
    { label: 'a directory outside git', repo: { fail: { 'rev-parse': { ok: false, error: 'not-a-repo', detail: 'fatal' } } }, message: /baseline diff: not inside a git repository/ },
    { label: 'a machine without git', repo: { fail: { 'rev-parse': { ok: false, error: 'missing', detail: 'git not found on PATH' } } }, message: /baseline diff: git is required/ },
    { label: 'a committed file that does not parse', repo: { refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: '<<<<<<< HEAD\n{' } }, message: /checkride\.baseline\.json at HEAD can't be parsed/ },
    { label: 'a committed file from a newer schema', repo: { refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: JSON.stringify({ schema_version: 2, slots: {} }) } }, message: /can't be parsed, or comes from a newer checkride/ },
    { label: 'a failing git show', repo: { refs: { HEAD: HEAD_SHA }, files: { [HEAD_SHA]: blob({}) }, fail: { show: { ok: false, error: 'timeout', detail: 'git show timed out (>10s)' } } }, message: /baseline diff: git show timed out/ },
  ])('$label throws, which the CLI reports as exit 2', async ({ repo, ref, message }) => {
    await writeCurrent({ lint: ['a'] });
    const out = capture();
    await expect(runBaselineDiff({ cwd: dir, git: diffGit(repo), stdout: out.out, ...(ref !== undefined ? { ref } : {}) })).rejects.toThrow(message);
    expect(out.text()).toBe('');
  });

  test('a working-tree file that does not parse throws before git is asked anything', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{');
    const git = diffGit({ refs: { HEAD: HEAD_SHA } });
    await expect(runBaselineDiff({ cwd: dir, git, stdout: capture().out })).rejects.toThrow(/in the working tree can't be parsed/);
    expect(git.calls).toEqual([]);
  });
});

/** Is a real git usable here? Collected once; the integration suite skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const realGitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

describe.skipIf(!gitAvailable)('checkride baseline diff (CLI, real git)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-diff-git-'));
    realGitIn(dir, 'init', '-q');
    await writeFile(join(dir, 'README.md'), '# a repo from before the baseline\n');
    realGitIn(dir, 'add', '.');
    realGitIn(dir, 'commit', '-q', '-m', 'before the baseline');
    realGitIn(dir, 'tag', 'before');
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a', 'b'] } });
    realGitIn(dir, 'add', '.');
    realGitIn(dir, 'commit', '-q', '-m', 'adopt a baseline');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const deps = (stdout: Out, stderr: Out): { cwd: string; stdout: Out; stderr: Out } => ({ cwd: dir, stdout, stderr });

  test('diffs the working tree against HEAD and exits 0, keys added or not', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['a', 'c'] } });
    const out = capture();
    expect(await runCli(['baseline', 'diff', '--json'], deps(out.out, capture().out))).toBe(0);
    const diff = JSON.parse(out.text()) as Record<string, unknown>;
    expect(diff).toMatchObject({ ref: 'HEAD', added: { lint: ['c'] }, removed: { lint: ['b'] } });
    expect(diff['sha']).toBe(realGitIn(dir, 'rev-parse', 'HEAD').trim());
  });

  test('a ref from before the baseline existed reports every key as added (F30)', async () => {
    const out = capture();
    expect(await runCli(['baseline', 'diff', 'before'], deps(out.out, capture().out))).toBe(0);
    expect(out.text()).toContain('2 key(s) added, 0 removed.');
    expect(out.text()).toContain('+ a\n+ b');
  });

  test.each<{ label: string; argv: string[]; message: RegExp }>([
    { label: 'a ref that does not resolve', argv: ['baseline', 'diff', 'no-such-ref'], message: /'no-such-ref' does not name a commit/ },
    { label: 'two refs', argv: ['baseline', 'diff', 'HEAD', 'before'], message: /takes one ref, got 2/ },
    { label: 'a flag only the capture takes', argv: ['baseline', 'diff', '--config', 'x.json'], message: /Unknown option '--config'/ },
  ])('$label exits 2', async ({ argv, message }) => {
    const out = capture();
    const err = capture();
    expect(await runCli(argv, deps(out.out, err.out))).toBe(2);
    expect(err.text()).toMatch(message);
    expect(out.text()).toBe('');
  });

  test('a stray argument to the capture exits 2 rather than rewriting the file', async () => {
    const before = await readFile(join(dir, 'checkride.baseline.json'), 'utf8');
    const err = capture();
    expect(await runCli(['baseline', '--config', 'x.json', 'diff'], deps(capture().out, err.out))).toBe(2);
    expect(err.text()).toMatch(/Unexpected argument 'diff'/);
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(before);
  });

  test('baseline --help prints its own text, naming diff', async () => {
    const out = capture();
    expect(await runCli(['baseline', 'diff', '--help'], deps(out.out, capture().out))).toBe(0);
    expect(out.text()).toContain('checkride baseline diff [<ref>] [--json]');
  });
});
