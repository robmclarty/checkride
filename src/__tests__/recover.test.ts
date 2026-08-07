import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Baseline, GitResult, GitRunner } from '../baseline/index.js';
import type { Out } from '../orchestrator.js';
import { runRecover } from '../recover.js';

function sink(): { out: Out; text: () => string } {
  const lines: string[] = [];
  return { out: { write: (t: string) => { lines.push(t); return true; } }, text: () => lines.join('') };
}

const base = (slots: Record<string, string[]>): Baseline => ({ schema_version: 1, slots });
const blob = (slots: Record<string, string[]>): string => JSON.stringify(base(slots));

type FakeRepo = { log?: { sha: string; blob?: string }[]; dirty?: boolean };

function answerShow(opts: FakeRepo, spec: string): GitResult {
  const sha = spec.split(':')[0] ?? '';
  const rev = (opts.log ?? []).find((r) => r.sha === sha);
  if (rev?.blob === undefined) return { ok: false, error: 'failed', detail: 'path does not exist' };
  return { ok: true, stdout: rev.blob };
}

function answer(opts: FakeRepo, args: readonly string[]): GitResult {
  const sub = args[0] ?? '';
  if (sub === 'rev-parse') return { ok: true, stdout: '/repo\n\nfalse\n' };
  if (sub === 'log') {
    const records = (opts.log ?? []).map(
      (r) => `${r.sha}\x1f${r.sha.slice(0, 7)}\x1f2026-07-30T12:00:00-04:00\x1fAda L.\x1fa commit\x1e`,
    );
    return { ok: true, stdout: records.join('\n') };
  }
  if (sub === 'show') return answerShow(opts, args[1] ?? '');
  if (sub === 'status') return { ok: true, stdout: opts.dirty ? ' M checkride.baseline.json\n' : '' };
  return { ok: false, error: 'failed', detail: `unexpected: ${sub}` };
}

/** A scripted git for unit tests: one snapshot history plus a status answer. */
function fakeGit(opts: FakeRepo): GitRunner {
  return (args: readonly string[]): Promise<GitResult> => Promise.resolve(answer(opts, args));
}

const SHA = 'f'.padEnd(40, '0');

describe('runRecover (unit, injected git)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-recover-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baselinePath = (): string => join(dir, 'checkride.baseline.json');
  const readWritten = async (): Promise<Baseline> => JSON.parse(await readFile(baselinePath(), 'utf8')) as Baseline;

  test('list mode renders the candidate table on stdout only, exit 0', async () => {
    await writeFile(baselinePath(), blob({ lint: ['a'] }));
    const out = sink();
    const err = sink();
    const result = await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['a', 'b', 'c'] }) }] }),
      stdout: out.out, stderr: err.out,
    });
    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain('present, 1 key(s) across 1 slot(s)');
    expect(text).toContain('| 1 | union (1 snapshot(s) + current) |');
    expect(text).toContain(`| 2 | snapshot | ${SHA.slice(0, 7)} | 2026-07-30 | Ada L. | 3 | +2 / −0 |`);
    expect(err.text()).toBe('');
  });

  test('a dirty working-tree baseline is said in the listing header', async () => {
    await writeFile(baselinePath(), blob({ lint: ['a'] }));
    const out = sink();
    await runRecover({ cwd: dir, git: fakeGit({ log: [], dirty: true }), stdout: out.out, stderr: sink().out });
    expect(out.text()).toContain('with uncommitted changes');
  });

  test('an unparseable current file is named in the listing, and recovery still works', async () => {
    await writeFile(baselinePath(), '<<<<<<< HEAD\n{ mangled\n');
    const out = sink();
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['a'] }) }] }),
      stdout: out.out, stderr: sink().out,
    });
    expect(out.text()).toContain('present but unparseable');
    expect(out.text()).toContain('snapshot');
  });

  test('never-committed file: list says so at exit 0; --pick is exit-2 material', async () => {
    const out = sink();
    const result = await runRecover({ cwd: dir, git: fakeGit({ log: [] }), stdout: out.out, stderr: sink().out });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toContain('No committed history');
    await expect(
      runRecover({ cwd: dir, git: fakeGit({ log: [] }), pick: '1', stdout: sink().out, stderr: sink().out }),
    ).rejects.toThrow('nothing to pick');
  });

  test('the default apply is a union: uncommitted current keys survive', async () => {
    await writeFile(baselinePath(), blob({ lint: ['mine'] }));
    const err = sink();
    const out = sink();
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['old-a', 'old-b'] }) }], dirty: true }),
      pick: SHA.slice(0, 8), stdout: out.out, stderr: err.out,
    });
    expect((await readWritten()).slots['lint']).toEqual(['mine', 'old-a', 'old-b']);
    expect(err.text()).toContain('+2 key(s) restored');
    expect(err.text()).toContain('review with `git diff` and commit');
    expect(out.text()).toBe(''); // apply is stderr prose; stdout stays machine-clean
  });

  test('--exact writes the snapshot verbatim on a clean tree', async () => {
    await writeFile(baselinePath(), blob({ lint: ['mine'] }));
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['old'] }) }] }),
      pick: SHA.slice(0, 8), exact: true, stdout: sink().out, stderr: sink().out,
    });
    expect((await readWritten()).slots).toEqual({ lint: ['old'] });
  });

  test('--exact refuses a dirty baseline and leaves the file untouched', async () => {
    await writeFile(baselinePath(), blob({ lint: ['mine'] }));
    await expect(
      runRecover({
        cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['old'] }) }], dirty: true }),
        pick: '1', exact: true, stdout: sink().out, stderr: sink().out,
      }),
    ).rejects.toThrow('uncommitted changes');
    expect((await readWritten()).slots).toEqual({ lint: ['mine'] });
  });

  test('--exact without --pick is a usage error', async () => {
    await expect(
      runRecover({ cwd: dir, git: fakeGit({ log: [] }), exact: true, stdout: sink().out, stderr: sink().out }),
    ).rejects.toThrow('--exact requires --pick');
  });

  test('--dry-run previews the per-slot delta with the elision cap and writes nothing', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `k${String(i).padStart(2, '0')}`);
    const out = sink();
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: keys }) }] }),
      pick: '1', dryRun: true, stdout: out.out, stderr: sink().out,
    });
    expect(existsSync(baselinePath())).toBe(false);
    const text = out.text();
    expect(text).toContain('lint — 25 restored');
    expect(text).toContain('… and 5 more');
    expect(text).not.toContain('k24'); // beyond the cap
  });

  test('a pick that changes nothing writes nothing and says so', async () => {
    await writeFile(baselinePath(), blob({ lint: ['a', 'b'] }));
    const err = sink();
    const written = await readFile(baselinePath(), 'utf8');
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['a'] }) }] }),
      pick: '1', stdout: sink().out, stderr: err.out,
    });
    expect(err.text()).toContain('nothing to write');
    expect(await readFile(baselinePath(), 'utf8')).toBe(written); // untouched
  });

  test('--pick resolves by index, sha prefix, and the union keyword; rejects the rest', async () => {
    await writeFile(baselinePath(), blob({ lint: ['mine'] }));
    const git = (): GitRunner => fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['old'] }) }] });
    await expect(
      runRecover({ cwd: dir, git: git(), pick: '9', stdout: sink().out, stderr: sink().out }),
    ).rejects.toThrow('out of range');
    await expect(
      runRecover({ cwd: dir, git: git(), pick: 'not-hex', stdout: sink().out, stderr: sink().out }),
    ).rejects.toThrow('sha prefix');
    await expect(
      runRecover({ cwd: dir, git: git(), pick: 'abcd', stdout: sink().out, stderr: sink().out }),
    ).rejects.toThrow('matches none');
    await runRecover({ cwd: dir, git: git(), pick: 'union', stdout: sink().out, stderr: sink().out });
    expect((await readWritten()).slots['lint']).toEqual(['mine', 'old']);
  });

  test('recovers when the baseline file itself was deleted', async () => {
    const err = sink();
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['a', 'b'] }) }] }),
      pick: '1', stdout: sink().out, stderr: err.out,
    });
    expect((await readWritten()).slots['lint']).toEqual(['a', 'b']);
    expect(err.text()).toContain('+2 key(s) restored');
  });

  test('--json emits the machine listing on stdout', async () => {
    await writeFile(baselinePath(), blob({ lint: ['a'] }));
    const out = sink();
    await runRecover({
      cwd: dir, git: fakeGit({ log: [{ sha: SHA, blob: blob({ lint: ['a', 'b'] }) }] }),
      json: true, stdout: out.out, stderr: sink().out,
    });
    const listing = JSON.parse(out.text()) as {
      schema_version: number;
      file: { state: string; keys: number; dirty: boolean };
      candidates: { kind: string; index: number; restored: number; sha?: string }[];
    };
    expect(listing.schema_version).toBe(1);
    expect(listing.file).toEqual({ state: 'ok', keys: 1, dirty: false });
    expect(listing.candidates.map((c) => c.kind)).toEqual(['union', 'snapshot']);
    expect(listing.candidates[1]?.sha).toBe(SHA);
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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

describe.skipIf(!gitAvailable)('runRecover (integration, real git)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-recover-git-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** The incident, in miniature: a rich committed baseline, then a mutilating commit. */
  async function seedIncident(cwd: string): Promise<string> {
    git(cwd, 'init', '-q');
    const keys = Array.from({ length: 12 }, (_, i) => `src/a.ts:rule-${i}:message ${i}`);
    await writeFile(join(cwd, 'checkride.baseline.json'), `${JSON.stringify(base({ lint: keys, spell: ['s1'] }), null, 2)}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', 'adopt checkride with a baseline');
    const richSha = git(cwd, 'rev-parse', 'HEAD').trim();
    await writeFile(join(cwd, 'checkride.baseline.json'), `${JSON.stringify(base({ lint: ['src/a.ts:rule-0:message 0'] }), null, 2)}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', 'merge develop (entries silently dropped)');
    return richSha;
  }

  test('lists the pre-damage state and restores it additively', async () => {
    const richSha = await seedIncident(dir);
    const out = sink();
    const list = await runRecover({ cwd: dir, stdout: out.out, stderr: sink().out });
    expect(list.exitCode).toBe(0);
    expect(out.text()).toContain(richSha.slice(0, 7));
    expect(out.text()).toContain('+12 / −0'); // union row: 11 lint keys + spell back

    const err = sink();
    await runRecover({ cwd: dir, pick: richSha, stdout: sink().out, stderr: err.out });
    expect(err.text()).toContain('+12 key(s) restored');
    const restored = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as Baseline;
    expect(restored.slots['lint']).toHaveLength(12);
    expect(restored.slots['spell']).toEqual(['s1']);
    // Additions-only in substance: the surviving key was never removed. At the
    // line level JSON allows one casualty — the last array entry gains a
    // trailing comma — so the removed-line count is at most that.
    expect(restored.slots['lint']).toContain('src/a.ts:rule-0:message 0');
    const [added = '0', removed = '0'] = git(dir, 'diff', '--numstat').trim().split('\t');
    expect(Number(added)).toBeGreaterThanOrEqual(12);
    expect(Number(removed)).toBeLessThanOrEqual(1);
  });

  test('--dry-run leaves the working tree byte-identical', async () => {
    const richSha = await seedIncident(dir);
    const before = await readFile(join(dir, 'checkride.baseline.json'), 'utf8');
    await runRecover({ cwd: dir, pick: richSha, dryRun: true, stdout: sink().out, stderr: sink().out });
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(before);
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  });

  test('a non-repo directory is an environment error, not a crash', async () => {
    await expect(runRecover({ cwd: dir, stdout: sink().out, stderr: sink().out })).rejects.toThrow('not inside a git repository');
  });

  test('a shallow clone lists with the truncation note', async () => {
    await seedIncident(dir);
    const clone = await mkdtemp(join(tmpdir(), 'checkride-recover-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, 'work'], { cwd: clone, stdio: 'pipe' });
      const out = sink();
      await runRecover({ cwd: join(clone, 'work'), stdout: out.out, stderr: sink().out });
      expect(out.text()).toContain('history is shallow');
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });
});
