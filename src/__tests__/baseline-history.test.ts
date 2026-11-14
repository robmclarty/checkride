import { describe, expect, test } from 'vitest';

import type { Baseline } from '../baseline/index.js';
import { collectCandidates, diffBaselines, historicalHint, readShardsAt, shardMap, treeAt, unionBaselines } from '../baseline/index.js';
import { targetsDeclaredAt } from '../config.js';
import type { GitResult, GitRunner } from '../git.js';

const base = (slots: Record<string, string[]>): Baseline => ({ schema_version: 1, slots });

type FakeRepo = {
  prefix?: string;
  shallow?: boolean;
  /** Newest-first, exactly as `git log` would order them. */
  log?: { sha: string; subject?: string; blob?: string }[];
  /** Per-subcommand failure overrides (`rev-parse`, `log`, `show`, `status`). */
  fail?: Record<string, GitResult>;
};

function answerLog(repo: FakeRepo, depth: number): GitResult {
  const records = (repo.log ?? [])
    .slice(0, depth)
    .map((r) => `${r.sha}\x1f${r.sha.slice(0, 7)}\x1f2026-07-30T12:00:00-04:00\x1fAda L.\x1f${r.subject ?? 'a commit'}\x1e`);
  return { ok: true, stdout: records.join('\n') };
}

function answerShow(repo: FakeRepo, spec: string): GitResult {
  const sha = spec.split(':')[0] ?? '';
  const rev = (repo.log ?? []).find((r) => r.sha === sha);
  if (rev?.blob === undefined) return { ok: false, error: 'failed', detail: 'path does not exist' };
  return { ok: true, stdout: rev.blob };
}

function answerRevParse(repo: FakeRepo): GitResult {
  return { ok: true, stdout: `/repo\n${repo.prefix ?? ''}\n${repo.shallow ? 'true' : 'false'}\n` };
}

function answer(repo: FakeRepo, args: readonly string[]): GitResult {
  const sub = args[0] ?? '';
  const forced = repo.fail?.[sub];
  if (forced) return forced;
  if (sub === 'rev-parse') return answerRevParse(repo);
  if (sub === 'log') return answerLog(repo, Number(args[2]));
  if (sub === 'show') return answerShow(repo, args[1] ?? '');
  if (sub === 'status') return { ok: true, stdout: '' };
  return { ok: false, error: 'failed', detail: `unexpected: ${sub}` };
}

/** A scripted git: answers from the fixture, records every invocation. */
function fakeGit(repo: FakeRepo): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    return Promise.resolve(answer(repo, args));
  };
  return Object.assign(runner, { calls });
}

const blob = (slots: Record<string, string[]>): string => JSON.stringify(base(slots));

describe('collectCandidates', () => {
  test('presents each distinct state once, newest sha first, plus the union', async () => {
    // A, A, B, B, A — runs of identical states collapse to the newest sha; a state
    // already presented is never presented again (identical baselines carry
    // identical deltas, so a second row would say nothing new).
    const a = blob({ lint: ['x', 'y'] });
    const b = blob({ lint: ['x'], spell: ['s'] });
    const git = fakeGit({
      log: [
        { sha: 'a1'.padEnd(40, '0'), blob: a },
        { sha: 'a2'.padEnd(40, '0'), blob: a },
        { sha: 'b1'.padEnd(40, '0'), blob: b },
        { sha: 'b2'.padEnd(40, '0'), blob: b },
        { sha: 'a3'.padEnd(40, '0'), blob: a },
      ],
    });
    const current = base({ lint: ['x'] });
    const scan = await collectCandidates(git, current, 25);

    const kinds = scan.candidates.map((c) => c.kind);
    expect(kinds).toEqual(['union', 'snapshot', 'snapshot']);
    const shas = scan.candidates.flatMap((c) => (c.kind === 'snapshot' ? [c.rev.sha] : []));
    expect(shas).toEqual(['a1'.padEnd(40, '0'), 'b1'.padEnd(40, '0')]);
    // The union folds every parsed snapshot, not just the presented ones.
    const union = scan.candidates[0];
    expect(union?.kind === 'union' && union.folded).toBe(5);
    expect(union?.baseline.slots).toEqual({ lint: ['x', 'y'], spell: ['s'] });
  });

  test('a snapshot identical to the current file offers nothing and is dropped', async () => {
    const current = base({ lint: ['x'] });
    const git = fakeGit({ log: [{ sha: 'c'.padEnd(40, '0'), blob: blob({ lint: ['x'] }) }] });
    const scan = await collectCandidates(git, current, 25);
    expect(scan.candidates).toEqual([]);
    expect(scan.walked).toBe(1);
  });

  test('a snapshot that differs from the current file only in how its keys were captured restores nothing, so it is dropped', async () => {
    const current: Baseline = { ...base({ lint: ['x'] }), captured_with: { lint: { pin_source: 'nix', tool_version: '2.11.4' } } };
    const older = JSON.stringify({ ...base({ lint: ['x'] }), captured_with: { lint: { pin_source: 'path' } } });
    const scan = await collectCandidates(fakeGit({ log: [{ sha: 'c'.padEnd(40, '0'), blob: older }] }), current, 25);
    expect(scan.candidates).toEqual([]);
  });

  test('stops walking once five distinct snapshots are held', async () => {
    const log = Array.from({ length: 8 }, (_, i) => ({
      sha: `${i}`.padEnd(40, 'a'),
      blob: blob({ lint: [`k${i}`] }),
    }));
    const git = fakeGit({ log });
    const scan = await collectCandidates(git, null, 25);
    expect(scan.candidates.filter((c) => c.kind === 'snapshot')).toHaveLength(5);
    expect(scan.walked).toBe(5);
    expect(git.calls.filter((c) => c[0] === 'show')).toHaveLength(5);
  });

  test('honors depth in the log invocation', async () => {
    const git = fakeGit({ log: [] });
    await collectCandidates(git, null, 7);
    const log = git.calls.find((c) => c[0] === 'log');
    expect(log?.slice(1, 3)).toEqual(['-n', '7']);
  });

  test('an unparseable or unreadable blob is skipped and recorded, never fatal', async () => {
    const git = fakeGit({
      log: [
        { sha: 'bad'.padEnd(40, '0'), blob: '<<<<<<< HEAD\n{ mangled' },
        { sha: 'gone'.padEnd(40, '0') }, // show fails: deleted in this commit
        { sha: 'good'.padEnd(40, '0'), blob: blob({ lint: ['x'] }) },
      ],
    });
    const scan = await collectCandidates(git, null, 25);
    expect(scan.skipped).toEqual(['bad0000', 'gone000']);
    expect(scan.candidates.filter((c) => c.kind === 'snapshot')).toHaveLength(1);
  });

  test('a subject with tabs and quotes survives the separator format', async () => {
    const git = fakeGit({ log: [{ sha: 'q'.padEnd(40, '0'), subject: 'fix:\t"weird | subject"', blob: blob({ lint: ['x'] }) }] });
    const scan = await collectCandidates(git, null, 25);
    const snap = scan.candidates.find((c) => c.kind === 'snapshot');
    expect(snap?.kind === 'snapshot' && snap.rev.subject).toBe('fix:\t"weird | subject"');
  });

  test('resolves the baseline path under the git prefix (monorepo subdirectory)', async () => {
    const git = fakeGit({ prefix: 'packages/web/', log: [{ sha: 'p'.padEnd(40, '0'), blob: blob({ lint: ['x'] }) }] });
    await collectCandidates(git, null, 25);
    const show = git.calls.find((c) => c[0] === 'show');
    expect(show?.[1]).toBe(`${'p'.padEnd(40, '0')}:packages/web/checkride.baseline.json`);
    const log = git.calls.find((c) => c[0] === 'log');
    expect(log?.at(-1)).toBe('packages/web/checkride.baseline.json');
  });

  test('surfaces a shallow clone as a flag, not an error', async () => {
    const scan = await collectCandidates(fakeGit({ shallow: true, log: [] }), null, 25);
    expect(scan.shallow).toBe(true);
    expect(scan.walked).toBe(0);
  });

  test('no union candidate when history adds nothing to current', async () => {
    const current = base({ lint: ['x', 'y'] });
    const git = fakeGit({ log: [{ sha: 's'.padEnd(40, '0'), blob: blob({ lint: ['x'] }) }] });
    const scan = await collectCandidates(git, current, 25);
    // The subset snapshot is presented (its --exact delta is real) but the
    // union of it with current is just current — no union row.
    expect(scan.candidates.map((c) => c.kind)).toEqual(['snapshot']);
  });

  test('git failures become user-facing errors', async () => {
    await expect(collectCandidates(fakeGit({ fail: { 'rev-parse': { ok: false, error: 'not-a-repo', detail: 'fatal: not a git repository' } } }), null, 25))
      .rejects.toThrow('not inside a git repository');
    await expect(collectCandidates(fakeGit({ fail: { 'rev-parse': { ok: false, error: 'missing', detail: 'git not found on PATH' } } }), null, 25))
      .rejects.toThrow('git is required');
    await expect(collectCandidates(fakeGit({ fail: { log: { ok: false, error: 'timeout', detail: 'git log timed out (>10s)' } } }), null, 25))
      .rejects.toThrow('timed out');
  });
});

describe('unionBaselines / diffBaselines', () => {
  test('union is per-slot, deduplicated, and canonical', () => {
    const union = unionBaselines([base({ spell: ['b', 'a'] }), base({ lint: ['z'], spell: ['a', 'c'] })]);
    expect(union.slots).toEqual({ lint: ['z'], spell: ['a', 'b', 'c'] });
    expect(Object.keys(union.slots)).toEqual(['lint', 'spell']);
  });

  test('union keeps each check’s capture record from the first part that has one, the current file coming first', () => {
    const current: Baseline = { ...base({ lint: ['a'] }), captured_with: { lint: { pin_source: 'nix', tool_version: '2.11.4' } } };
    const older: Baseline = { ...base({ lint: ['b'], spell: ['s'] }), captured_with: { lint: { pin_source: 'path' }, spell: { pin_source: 'mise' } } };
    expect(unionBaselines([current, older]).captured_with).toEqual({ lint: { pin_source: 'nix', tool_version: '2.11.4' }, spell: { pin_source: 'mise' } });
    expect(unionBaselines([base({ lint: ['a'] })])).not.toHaveProperty('captured_with');
  });

  /** A recovered key never raises a current key's count, and one from a file that didn't count its check grandfathers one (#14). */
  test('union counts a check as its first part holding a key does, each key from the first counted part holding it, else once', () => {
    const current: Baseline = { ...base({ lint: ['a', 'b'], spell: ['s'] }), counts: { lint: { a: 2 } } };
    const older: Baseline = { ...base({ lint: ['a', 'c', 'd'], spell: ['s', 't'] }), counts: { lint: { a: 5, c: 3 }, spell: { t: 4 } } };
    const uncounted: Baseline = base({ lint: ['e'], dead: ['x'] });
    expect(unionBaselines([current, older, uncounted]).counts).toEqual({ lint: { a: 2, c: 3 } });
    // The uncounted file holds a lint key first, so lint stays uncounted: any number, as that file grandfathered.
    expect(unionBaselines([uncounted, current])).not.toHaveProperty('counts');
    expect(unionBaselines([base({ lint: ['a'] })])).not.toHaveProperty('counts');
  });

  test('a snapshot that differs from the current file only in its counts is offered', async () => {
    const counted = JSON.stringify({ schema_version: 1, slots: { lint: ['x'] }, counts: { lint: { x: 3 } } });
    const git = fakeGit({ log: [{ sha: 'c1'.padEnd(40, '0'), blob: counted }] });
    const scan = await collectCandidates(git, { ...base({ lint: ['x'] }), counts: { lint: {} } }, 25);
    expect(scan.candidates.map((c) => c.kind)).toEqual(['snapshot']);
  });

  test('diff splits gained (restored) from lost (absent), per slot and total', () => {
    const from = base({ lint: ['a', 'b'], spell: ['s'] });
    const to = base({ lint: ['a', 'c'], dead: ['d'] });
    const delta = diffBaselines(from, to);
    expect(delta.restored).toEqual({ dead: ['d'], lint: ['c'] });
    expect(delta.absent).toEqual({ lint: ['b'], spell: ['s'] });
    expect(delta.restoredCount).toBe(2);
    expect(delta.absentCount).toBe(2);
  });

  test('diff from null treats everything as restored (the absent-file case)', () => {
    const delta = diffBaselines(null, base({ lint: ['a', 'b'] }));
    expect(delta.restoredCount).toBe(2);
    expect(delta.absentCount).toBe(0);
  });
});

/** A git that never answers — what a hung subprocess looks like to the probe. */
const hungGit: GitRunner = () => new Promise(() => { /* never resolves */ });

describe('historicalHint', () => {
  const K1 = 'a.ts:r:one';
  const K2 = 'b.ts:r:two';

  test('counts the new keys a recent snapshot grandfathered — newest match wins', async () => {
    const git = fakeGit({
      log: [
        { sha: 'n'.padEnd(40, '0'), blob: blob({ lint: [] }) }, // newest: no match, keep probing
        { sha: 'm'.padEnd(40, '0'), blob: blob({ lint: [K1], spell: [K2] }) },
      ],
    });
    const hint = await historicalHint('/repo', [K1, K2, 'c.ts:r:three'], { git: git });
    expect(hint).toEqual({ matched: 2, total: 3, shortSha: 'm000000' });
  });

  test('null when history never grandfathered them, and for an empty key set', async () => {
    const git = fakeGit({ log: [{ sha: 'n'.padEnd(40, '0'), blob: blob({ lint: ['other'] }) }] });
    expect(await historicalHint('/repo', [K1], { git: git })).toBeNull();
    expect(await historicalHint('/repo', [], { git: git })).toBeNull();
  });

  test('null on any git failure — the probe never throws', async () => {
    const notRepo = fakeGit({ fail: { 'rev-parse': { ok: false, error: 'not-a-repo', detail: 'fatal' } } });
    expect(await historicalHint('/repo', [K1], { git: notRepo })).toBeNull();
    const noLog = fakeGit({ fail: { log: { ok: false, error: 'failed', detail: 'boom' } } });
    expect(await historicalHint('/repo', [K1], { git: noLog })).toBeNull();
  });

  test('null once the budget expires — a hung git never slows a red run', async () => {
    expect(await historicalHint('/repo', [K1], { git: hungGit, budgetMs: 25 })).toBeNull();
  });

  test('probes a short log and at most three snapshots', async () => {
    const log = Array.from({ length: 5 }, (_, i) => ({ sha: `${i}`.padEnd(40, 'b'), blob: blob({ lint: ['other'] }) }));
    const git = fakeGit({ log });
    await historicalHint('/repo', [K1], { git: git });
    expect(git.calls.find((c) => c[0] === 'log')?.slice(1, 3)).toEqual(['-n', '5']);
    expect(git.calls.filter((c) => c[0] === 'show')).toHaveLength(3);
  });
});

/** A committed tree as a map from each file to its text. */
const treeOf = (files: Record<string, string>): { sha: string; read: (file: string) => Promise<string | null> } => ({
  sha: 'c'.repeat(40),
  read: (file) => Promise.resolve(files[file] ?? null),
});

describe('targetsDeclaredAt', () => {
  const FILE = 'checkride.config.json';
  const declared = (files: Record<string, unknown>): Promise<Record<string, unknown>> =>
    targetsDeclaredAt(treeOf(Object.fromEntries(Object.entries(files).map(([file, content]) => [file, typeof content === 'string' ? content : JSON.stringify(content)]))).read, FILE);

  test('a tree with no config declares nothing, and neither does a config with no targets', async () => {
    expect(await declared({})).toEqual({});
    expect(await declared({ [FILE]: { checks: {} } })).toEqual({});
  });

  test("the config's own targets come back as written, and an included file's with each root relative to the repo", async () => {
    expect(await declared({
      [FILE]: { targets: { web: { root: 'web', local: true } }, include: ['services', 'tools/'] },
      'services/checkride.config.json': { targets: { api: { root: 'api', local: true }, queue: { lang: 'go', root: './queue/' } }, include: ['deep'] },
      'services/deep/checkride.config.json': { targets: { deepest: { root: '.' } } },
      'tools/checkride.config.json': { targets: { odd: 'not an entry' } },
    })).toEqual({
      web: { root: 'web', local: true },
      api: { root: 'services/api', local: true },
      queue: { lang: 'go', root: 'services/queue' },
      deepest: { root: 'services/deep' },
      odd: 'not an entry',
    });
  });

  test('a cycle of includes stops at the file it comes back to', async () => {
    expect(await declared({
      [FILE]: { targets: { web: { root: 'web' } }, include: ['a'] },
      'a/checkride.config.json': { targets: { b: { root: 'b' } }, include: ['.', '..'] },
    })).toEqual({ web: { root: 'web' }, b: { root: 'a/b' } });
  });

  test.each<{ label: string; files: Record<string, unknown>; message: RegExp }>([
    { label: 'a config that is not JSON', files: { [FILE]: '{ "targets": ' }, message: /JSON/ },
    { label: 'a config that is no object', files: { [FILE]: '[]' }, message: /checkride\.config\.json is not a JSON object/ },
    { label: 'an included file that is missing', files: { [FILE]: { include: ['services'] } }, message: /services\/checkride\.config\.json is missing/ },
  ])('$label throws', async ({ files, message }) => {
    await expect(declared(files)).rejects.toThrow(message);
  });

  test("a named suite's config goes by the suite's file name, in every directory", async () => {
    const read = treeOf({
      'checkride.evals.config.json': JSON.stringify({ include: ['services'] }),
      'services/checkride.evals.config.json': JSON.stringify({ targets: { api: { root: 'api', local: true } } }),
      'services/checkride.config.json': JSON.stringify({ targets: { other: { root: 'other' } } }),
    }).read;
    expect(await targetsDeclaredAt(read, 'checkride.evals.config.json')).toEqual({ api: { root: 'services/api', local: true } });
  });
});

describe('readShardsAt', () => {
  const FILE = 'checkride.baseline.json';
  const working = shardMap(FILE, { web: { root: 'web', local: true } });

  test('a commit with the root file alone gives its baseline as parsed, and one with none gives null', async () => {
    expect(await readShardsAt(treeOf({ [FILE]: blob({ lint: ['b', 'a'] }) }), 'HEAD', working, null)).toEqual({ sha: 'c'.repeat(40), baseline: base({ lint: ['b', 'a'] }), unread: null });
    expect((await readShardsAt(treeOf({}), 'HEAD', working, null)).baseline).toBeNull();
  });

  test("the files the working tree's map names are read as one baseline, each for the checks it may hold", async () => {
    const tree = treeOf({ [FILE]: blob({ spell: ['s'], 'web:lint': ['stray'] }), 'web/checkride.baseline.json': blob({ 'web:lint': ['w'], spell: ['not-webs'] }) });
    expect((await readShardsAt(tree, 'HEAD', working, null)).baseline?.slots).toEqual({ spell: ['s'], 'web:lint': ['stray', 'w'] });
  });

  test("a file only the ref's own config declares is read, and the working tree's files still are", async () => {
    const tree = treeOf({
      'web/checkride.baseline.json': blob({ 'web:lint': ['w'] }),
      'api/checkride.baseline.json': blob({ 'api:lint': ['a'] }),
    });
    const at = await readShardsAt(tree, 'HEAD', working, () => Promise.resolve({ api: { root: 'api', local: true } }));
    expect(at.baseline?.slots).toEqual({ 'api:lint': ['a'], 'web:lint': ['w'] });
    expect(at.unread).toBeNull();
    // Without the ref's config, the file it alone declares is not read.
    expect((await readShardsAt(tree, 'HEAD', working, null)).baseline?.slots).toEqual({ 'web:lint': ['w'] });
  });

  test("a ref's config that can't be read declares nothing, and says why on its first line", async () => {
    const tree = treeOf({ 'web/checkride.baseline.json': blob({ 'web:lint': ['w'] }) });
    const at = await readShardsAt(tree, 'HEAD', working, () => Promise.reject(new Error('services/checkride.config.json is missing\nand more')));
    expect(at.unread).toBe('services/checkride.config.json is missing');
    expect(at.baseline?.slots).toEqual({ 'web:lint': ['w'] });
  });

  test("a file that can't be parsed is an error naming it and the ref", async () => {
    await expect(readShardsAt(treeOf({ [FILE]: '{ mangled' }), 'main', working, null)).rejects.toThrow("baseline diff: checkride.baseline.json at main can't be parsed, or comes from a newer checkride");
    await expect(readShardsAt(treeOf({ 'web/checkride.baseline.json': '{ mangled' }), 'main', working, null)).rejects.toThrow("baseline diff: web/checkride.baseline.json at main can't be parsed");
  });
});

/** The path a `git ls-tree` or `git show` asks after, from the git root. */
function askedPath(args: readonly string[]): string {
  return args[0] === 'ls-tree' ? (args[5] ?? '') : ((args[1] ?? '').split(':')[1] ?? '');
}

/** What a git whose one commit, `HEAD`, holds `files` answers to a `rev-parse`. */
function revParsed(args: readonly string[], prefix: string): GitResult {
  if (args[1] === '--show-toplevel') return { ok: true, stdout: `/repo\n${prefix}\nfalse\n` };
  return args.at(-1) === 'HEAD^{commit}' ? { ok: true, stdout: `${'d'.repeat(40)}\n` } : { ok: false, error: 'failed', detail: '' };
}

/** A git whose one commit holds `files`, each path given from the git root. */
function gitOf(files: Record<string, string>, prefix = ''): GitRunner {
  return (args) => {
    if (args[0] === 'rev-parse') return Promise.resolve(revParsed(args, prefix));
    const text = files[askedPath(args)];
    if (args[0] === 'ls-tree') return Promise.resolve({ ok: true, stdout: text === undefined ? '' : `${askedPath(args)}\n` });
    return Promise.resolve(text === undefined ? { ok: false, error: 'failed', detail: 'no such path' } : { ok: true, stdout: text });
  };
}

describe('treeAt', () => {
  test("reads a file by its path from the checkride root, under the git root's prefix, and a file the commit lacks as null", async () => {
    const tree = await treeAt(gitOf({ 'pkg/web/checkride.baseline.json': 'text' }, 'pkg/'), 'HEAD');
    expect(tree.sha).toBe('d'.repeat(40));
    expect(await tree.read('web/checkride.baseline.json')).toBe('text');
    expect(await tree.read('checkride.baseline.json')).toBeNull();
  });

  test('a ref that names no commit, or reads as an option, is an error', async () => {
    await expect(treeAt(gitOf({}), 'nope')).rejects.toThrow("baseline diff: 'nope' does not name a commit");
    await expect(treeAt(gitOf({}), '--upload-pack=x')).rejects.toThrow("baseline diff: '--upload-pack=x' is not a ref");
  });
});
