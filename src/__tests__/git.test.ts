import { describe, expect, test } from 'vitest';

import type { GitResult, GitRunner } from '../git.js';
import { DEFAULT_BASE, gitFailureError, resolveChangedBase } from '../git.js';

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
