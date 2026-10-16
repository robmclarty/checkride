import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { GitResult, GitRunner } from '../git.js';
import { changedPaths, DEFAULT_BASE, gitFailureError, readGitState, realGit, resolveChangedBase } from '../git.js';

const SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

/** A git whose `rev-parse` answers from `refs`, or with `fail` for every call when given. */
function revParseGit(refs: Record<string, string>, fail?: GitResult): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    if (fail) return Promise.resolve(fail);
    const spec = args.at(-1) ?? '';
    const sha = refs[spec.replace(/\^\{commit\}$/, '')];
    return Promise.resolve(sha === undefined ? { ok: false, error: 'failed', detail: 'git rev-parse failed' } : { ok: true, stdout: `${sha}\n` });
  };
  return Object.assign(runner, { calls });
}

/** `stdout` as a successful git answer, or the failed result as given. */
function answered(result: GitResult | string): GitResult {
  return typeof result === 'string' ? { ok: true, stdout: result } : result;
}

/** A git whose `rev-parse` answers `head` and whose `status` answers `status`. */
function stateGit(head: GitResult | string, status: GitResult | string): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    return Promise.resolve(answered(args.includes('status') ? status : head));
  };
  return Object.assign(runner, { calls });
}

describe('gitFailureError', () => {
  test('each failure class names its remedy', () => {
    expect(gitFailureError({ error: 'missing', detail: '' }).message).toContain('not found on PATH');
    expect(gitFailureError({ error: 'not-a-repo', detail: '' }).message).toContain('not inside a git repository');
    expect(gitFailureError({ error: 'failed', detail: 'boom' }).message).toContain('boom');
  });
});

describe('resolveChangedBase', () => {
  test('a named base that resolves is used as given, with its sha', async () => {
    const git = revParseGit({ 'origin/develop': SHA });
    expect(await resolveChangedBase(git, { ref: 'origin/develop', from: '--base' })).toEqual({
      base: { ref: 'origin/develop', sha: SHA },
      warning: null,
    });
    expect(git.calls).toEqual([['rev-parse', '--verify', '--quiet', 'origin/develop^{commit}']]);
  });

  test('a named base that names no commit throws, naming what named it (F26)', async () => {
    const git = revParseGit({ [DEFAULT_BASE]: SHA, HEAD: HEAD_SHA });
    await expect(resolveChangedBase(git, { ref: 'nope', from: 'CHECKRIDE_BASE' })).rejects.toThrow("CHECKRIDE_BASE 'nope' doesn't name a commit");
  });

  test('a named base never falls back, even when origin/main resolves', async () => {
    const git = revParseGit({ [DEFAULT_BASE]: SHA });
    await expect(resolveChangedBase(git, { ref: 'nope', from: '--base' })).rejects.toThrow('--base');
    expect(git.calls).toHaveLength(1);
  });

  test('a named base outside a git repository throws the git failure', async () => {
    const git = revParseGit({}, { ok: false, error: 'not-a-repo', detail: 'fatal: not a git repository' });
    await expect(resolveChangedBase(git, { ref: 'main', from: '--base' })).rejects.toThrow('not inside a git repository');
  });

  test('a named base with a leading dash is refused before git sees it', async () => {
    const git = revParseGit({});
    await expect(resolveChangedBase(git, { ref: '--all', from: '--base' })).rejects.toThrow("--base '--all' is not a ref");
    expect(git.calls).toEqual([]);
  });

  test('with nothing named, origin/main is the base when it resolves, and nothing warns', async () => {
    const git = revParseGit({ [DEFAULT_BASE]: SHA, HEAD: HEAD_SHA });
    expect(await resolveChangedBase(git, null)).toEqual({ base: { ref: DEFAULT_BASE, sha: SHA }, warning: null });
  });

  test('with nothing named and no origin/main, HEAD is the base, with a warning (F26)', async () => {
    const { base, warning } = await resolveChangedBase(revParseGit({ HEAD: HEAD_SHA }), null);
    expect(base).toEqual({ ref: 'HEAD', sha: HEAD_SHA });
    expect(warning).toContain("origin/main doesn't resolve, so changes are measured from HEAD");
    expect(warning).toContain('--base, CHECKRIDE_BASE or changedBase');
  });

  test('when HEAD names no commit either, the base is HEAD with no sha, and the warning says why', async () => {
    const empty = await resolveChangedBase(revParseGit({}), null);
    expect(empty.base).toEqual({ ref: 'HEAD', sha: null });
    expect(empty.warning).toContain('the repository has no commits yet');

    const outside = await resolveChangedBase(revParseGit({}, { ok: false, error: 'not-a-repo', detail: '' }), null);
    expect(outside.base).toEqual({ ref: 'HEAD', sha: null });
    expect(outside.warning).toContain('this is not a git repository');

    const missing = await resolveChangedBase(revParseGit({}, { ok: false, error: 'missing', detail: '' }), null);
    expect(missing.warning).toContain('git is not on PATH');
  });
});

describe('readGitState', () => {
  test('a clean tree records its head and dirty false', async () => {
    expect(await readGitState(stateGit(`${HEAD_SHA}\n`, ''))).toEqual({ head: HEAD_SHA, dirty: false });
  });

  test('anything git status lists, an untracked file included, makes the tree dirty', async () => {
    expect(await readGitState(stateGit(`${HEAD_SHA}\n`, ' M src/a.ts\n'))).toEqual({ head: HEAD_SHA, dirty: true });
    expect(await readGitState(stateGit(`${HEAD_SHA}\n`, '?? new.ts\n'))).toEqual({ head: HEAD_SHA, dirty: true });
  });

  test('asks status without the index lock and with untracked files listed, and HEAD as a commit', async () => {
    const git = stateGit(`${HEAD_SHA}\n`, '');
    await readGitState(git);
    expect(git.calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'],
    ]);
  });

  test('git can’t say when HEAD names no commit, or status fails, or either times out', async () => {
    const noCommit: GitResult = { ok: false, error: 'failed', detail: '' };
    const outside: GitResult = { ok: false, error: 'not-a-repo', detail: 'fatal: not a git repository' };
    const slow: GitResult = { ok: false, error: 'timeout', detail: 'git status timed out' };
    expect(await readGitState(stateGit(noCommit, ''))).toBeNull();
    expect(await readGitState(stateGit(outside, outside))).toBeNull();
    expect(await readGitState(stateGit(`${HEAD_SHA}\n`, slow))).toBeNull();
    expect(await readGitState(stateGit(slow, ''))).toBeNull();
  });

  test('a runner that rejects reads as no answer, never as a rejection', async () => {
    expect(await readGitState(() => Promise.reject(new Error('spawn EBADF')))).toBeNull();
  });
});

/** A git that answers each subcommand (`merge-base`, `diff`, `ls-files`) from `answers`, recording every call. */
function listingGit(answers: Record<string, GitResult | string>): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    return Promise.resolve(answered(answers[args[0] ?? ''] ?? ''));
  };
  return Object.assign(runner, { calls });
}

const MERGE_BASE = 'c'.repeat(40);

describe('changedPaths', () => {
  test('lists the diff from the merge base and the untracked files, NUL-separated, each once and sorted', async () => {
    const git = listingGit({
      'merge-base': `${MERGE_BASE}\n`,
      diff: 'web/a.ts\0api/odd name\nwith newline.go\0',
      'ls-files': 'web/new.ts\0web/a.ts\0',
    });
    expect(await changedPaths(git, { ref: 'main', sha: SHA })).toEqual({
      ok: true,
      paths: ['api/odd name\nwith newline.go', 'web/a.ts', 'web/new.ts'],
    });
    expect(git.calls).toEqual([
      ['merge-base', SHA, 'HEAD'],
      ['diff', '--name-only', '-z', '--no-renames', '--relative', MERGE_BASE, '--'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
  });

  test('with no merge base, the diff runs from the base itself', async () => {
    const git = listingGit({ 'merge-base': { ok: false, error: 'failed', detail: 'git merge-base failed' } });
    expect(await changedPaths(git, { ref: 'main', sha: SHA })).toEqual({ ok: true, paths: [] });
    expect(git.calls[1]).toContain(SHA);
  });

  test('a base with no commit lists nothing, and asks git nothing', async () => {
    const git = listingGit({});
    expect(await changedPaths(git, { ref: 'HEAD', sha: null })).toEqual({ ok: false, why: 'HEAD names no commit' });
    expect(git.calls).toEqual([]);
  });

  test('a git that can’t answer lists nothing, and says why', async () => {
    const outside: GitResult = { ok: false, error: 'not-a-repo', detail: 'fatal: not a git repository' };
    const slow: GitResult = { ok: false, error: 'timeout', detail: 'git diff timed out (>10s)' };
    const broken: GitResult = { ok: false, error: 'failed', detail: 'fatal: bad object' };
    expect(await changedPaths(listingGit({ 'merge-base': outside }), { ref: 'main', sha: SHA })).toEqual({ ok: false, why: 'fatal: not a git repository' });
    expect(await changedPaths(listingGit({ diff: slow }), { ref: 'main', sha: SHA })).toEqual({ ok: false, why: 'git diff timed out (>10s)' });
    expect(await changedPaths(listingGit({ 'ls-files': broken }), { ref: 'main', sha: SHA })).toEqual({ ok: false, why: 'fatal: bad object' });
  });
});

/** Is a real git usable here? The real-repository case skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('changedPaths in a real repository', () => {
  let dir: string;
  const gitIn = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-paths-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('from a subdirectory, paths are relative to it, and nothing outside it is listed', async () => {
    gitIn('init', '-q', '-b', 'main');
    await mkdir(join(dir, 'proj/web'), { recursive: true });
    await writeFile(join(dir, 'proj/web/a.ts'), 'a\n');
    await writeFile(join(dir, 'outside.md'), 'o\n');
    await writeFile(join(dir, '.gitignore'), '*.log\n');
    gitIn('add', '.');
    gitIn('commit', '-q', '-m', 'one');
    const sha = gitIn('rev-parse', 'HEAD').trim();
    await writeFile(join(dir, 'proj/web/a.ts'), 'a2\n');
    await writeFile(join(dir, 'proj/web/new.ts'), 'n\n');
    await writeFile(join(dir, 'proj/web/debug.log'), 'ignored\n');
    await writeFile(join(dir, 'outside.md'), 'o2\n');
    expect(await changedPaths(realGit(join(dir, 'proj')), { ref: 'main', sha })).toEqual({ ok: true, paths: ['web/a.ts', 'web/new.ts'] });
  });
});
