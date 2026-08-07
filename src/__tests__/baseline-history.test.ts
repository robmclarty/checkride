import { describe, expect, test } from 'vitest';

import type { Baseline, GitResult, GitRunner } from '../baseline/index.js';
import { collectCandidates, diffBaselines, gitFailureError, historicalHint, unionBaselines } from '../baseline/index.js';

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
    // A A B B A — runs of identical states collapse to the newest sha; a state
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

describe('gitFailureError', () => {
  test('each failure class names its remedy', () => {
    expect(gitFailureError({ error: 'missing', detail: '' }).message).toContain('not found on PATH');
    expect(gitFailureError({ error: 'not-a-repo', detail: '' }).message).toContain('not inside a git repository');
    expect(gitFailureError({ error: 'failed', detail: 'boom' }).message).toContain('boom');
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
    const hint = await historicalHint('/repo', [K1, K2, 'c.ts:r:three'], git);
    expect(hint).toEqual({ matched: 2, total: 3, shortSha: 'm000000' });
  });

  test('null when history never grandfathered them, and for an empty key set', async () => {
    const git = fakeGit({ log: [{ sha: 'n'.padEnd(40, '0'), blob: blob({ lint: ['other'] }) }] });
    expect(await historicalHint('/repo', [K1], git)).toBeNull();
    expect(await historicalHint('/repo', [], git)).toBeNull();
  });

  test('null on any git failure — the probe never throws', async () => {
    const notRepo = fakeGit({ fail: { 'rev-parse': { ok: false, error: 'not-a-repo', detail: 'fatal' } } });
    expect(await historicalHint('/repo', [K1], notRepo)).toBeNull();
    const noLog = fakeGit({ fail: { log: { ok: false, error: 'failed', detail: 'boom' } } });
    expect(await historicalHint('/repo', [K1], noLog)).toBeNull();
  });

  test('null once the budget expires — a hung git never slows a red run', async () => {
    expect(await historicalHint('/repo', [K1], hungGit, 25)).toBeNull();
  });

  test('probes a short log and at most three snapshots', async () => {
    const log = Array.from({ length: 5 }, (_, i) => ({ sha: `${i}`.padEnd(40, 'b'), blob: blob({ lint: ['other'] }) }));
    const git = fakeGit({ log });
    await historicalHint('/repo', [K1], git);
    expect(git.calls.find((c) => c[0] === 'log')?.slice(1, 3)).toEqual(['-n', '5']);
    expect(git.calls.filter((c) => c[0] === 'show')).toHaveLength(3);
  });
});
