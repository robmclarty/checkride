/**
 * The orchestrator in multi-target mode, through an injected runner: each
 * target's check runs from its root with `{out}` its own directory, masks
 * against its `<target>:<slot>` baseline entry with its paths joined onto the
 * root (D50), and feeds the ratchet under that name; `fix` runs a target's
 * fixer from its root; and under `--changed` a target nothing changed under
 * sits out (R10.3).
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Baseline } from '../../baseline/index.js';
import { runBaseline } from '../../baseline-command.js';
import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import { PACKS } from '../../packs/index.js';
import type { CheckRunner, Out, RunResult } from '../index.js';
import { runChecks, runFix } from '../index.js';
import { skipUnchanged } from '../select.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

/** An oxlint `--format=json` payload with one error per `[file, code, message]`. */
function oxlint(findings: [string, string, string][]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message, severity: 'error' })) });
}

/** Two ts targets whose `lint` names oxlint, so no detection is needed; nothing else runs. */
const config: CheckrideConfig = {
  targets: {
    web: { lang: 'ts', root: 'apps/web', checks: { lint: 'oxlint' } },
    api: { lang: 'ts', root: 'apps/api', checks: { lint: 'oxlint' } },
  },
};

/** A runner that reports `findings` for each target's lint, as oxlint prints them from that target's root. */
function lintRunner(findings: Record<string, [string, string, string][]>): CheckRunner {
  return (r) => {
    const found = findings[r.target ?? ''] ?? [];
    return Promise.resolve({ ok: found.length === 0, exit_code: found.length === 0 ? 0 : 1, stdout: oxlint(found), stderr: '' });
  };
}

describe('runChecks with targets', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-orch-targets-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (runner: CheckRunner, baseline: Baseline | null = null, extra: CheckrideConfig = {}) =>
    runChecks({ cwd: dir, config: { ...config, ...extra }, runner, baseline, only: ['lint'], stderr: sink().out });

  test("each target's check runs from its root, with {out} its own absolute directory", async () => {
    const seen: Record<string, { cwd: string; out?: string }> = {};
    const runner: CheckRunner = (r, ctx) => {
      seen[r.target ?? r.slot] = { cwd: ctx.cwd, ...(ctx.out !== undefined ? { out: ctx.out } : {}) };
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    await runChecks({ cwd: dir, config: { ...config, checks: { tally: { command: 'node' } } }, runner, baseline: null, stderr: sink().out });
    expect(seen['web']).toEqual({ cwd: join(dir, 'apps/web'), out: join(dir, '.check', 'web') });
    expect(seen['api']).toEqual({ cwd: join(dir, 'apps/api'), out: join(dir, '.check', 'api') });
    expect(seen['tally']).toEqual({ cwd: dir, out: join(dir, '.check') });
  });

  test("each target runs under the package manager declared nearest its root, and with its pack's pin chain", async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    await mkdir(join(dir, 'apps', 'api'), { recursive: true });
    await mkdir(join(dir, 'apps', 'web'), { recursive: true });
    await writeFile(join(dir, 'apps', 'api', 'package-lock.json'), '{}');
    const seen: Record<string, { pm: string; repo?: string; pins?: readonly string[] }> = {};
    const runner: CheckRunner = (r, ctx) => {
      seen[r.target ?? r.slot] = { pm: ctx.pm, ...(ctx.repo !== undefined ? { repo: ctx.repo } : {}), ...(ctx.pins !== undefined ? { pins: ctx.pins } : {}) };
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    await runChecks({ cwd: dir, config: { ...config, checks: { tally: { command: 'node' } } }, runner, baseline: null, stderr: sink().out });
    expect(seen['web']).toEqual({ pm: 'pnpm', repo: dir, pins: ['js-lockfile'] });
    expect(seen['api']).toEqual({ pm: 'npm', repo: dir, pins: ['js-lockfile'] });
    expect(seen['tally']).toEqual({ pm: 'pnpm', repo: dir, pins: ['js-lockfile', 'mise', 'path'] });
    // Each chain is its pack's own row, not the implicit chain that happens to match it today.
    expect(seen['web']?.pins).toBe(PACKS.ts.pins);
    expect(seen['tally']?.pins).toBe(PACKS.repo.pins);
  });

  test("a target's findings mask against its <target>:<slot> entry, keyed from the repo root", async () => {
    const baseline: Baseline = { schema_version: 1, slots: { 'web:lint': ['apps/web/src/a.ts:no-x:bad'] } };
    const result = await run(lintRunner({ web: [['src/a.ts', 'no-x', 'bad']], api: [['src/a.ts', 'no-x', 'bad']] }), baseline);
    const byName = new Map(result.summary.checks.map((c) => [c.name, c]));
    expect(byName.get('web:lint')).toMatchObject({ ok: true, baselined: 1 });
    // The same file name under another target is another file, and its own entry is empty.
    expect(byName.get('api:lint')).toMatchObject({ ok: false });
    expect(result.exitCode).toBe(1);
  });

  test('a full run ratchets each target entry by its own findings, and leaves the repo-root keys alone', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({
      schema_version: 1,
      slots: { 'web:lint': ['apps/web/src/a.ts:no-x:bad', 'apps/web/src/b.ts:no-y:worse'], 'api:lint': ['apps/api/src/c.ts:no-z:gone'] },
    }));
    const result = await runChecks({ cwd: dir, config, runner: lintRunner({ web: [['src/a.ts', 'no-x', 'bad']] }), stderr: sink().out });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as Baseline;
    expect(written.slots).toEqual({ 'api:lint': [], 'web:lint': ['apps/web/src/a.ts:no-x:bad'] });
  });

  test('checkride baseline writes each target entry under its name, with repo-root-relative paths', async () => {
    const result = await runBaseline({
      cwd: dir,
      config,
      runner: lintRunner({ web: [['src/a.ts', 'no-x', 'bad']], api: [['./lib/d.ts', 'no-w', 'odd']] }),
      stderr: sink().out,
    });
    expect(result.baseline.slots['web:lint']).toEqual(['apps/web/src/a.ts:no-x:bad']);
    expect(result.baseline.slots['api:lint']).toEqual(['apps/api/lib/d.ts:no-w:odd']);
    expect(result.baseline.slots).not.toHaveProperty('lint');
  });

  test('status lines name each check <target>:<slot>, and its JSON lands under <target>/', async () => {
    const err = sink();
    const result = await runChecks({ cwd: dir, config, runner: lintRunner({}), baseline: null, stderr: err.out });
    expect(err.text()).toMatch(/✔ web:lint\s/);
    expect(err.text()).toMatch(/✔ api:lint\s/);
    expect(result.summary.checks.find((c) => c.name === 'web:lint')).toMatchObject({ output_file: 'web/lint.json' });
    expect(JSON.parse(await readFile(join(dir, '.check', 'web', 'lint.json'), 'utf8'))).toEqual({ diagnostics: [] });
  });
});

describe('runFix with targets', () => {
  test("a target's fixer runs under the package manager declared nearest its root", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-fix-targets-'));
    try {
      await mkdir(join(dir, 'apps', 'web'), { recursive: true });
      await mkdir(join(dir, 'apps', 'api'), { recursive: true });
      await writeFile(join(dir, 'apps', 'api', 'yarn.lock'), '');
      const seen: string[] = [];
      await runFix({
        cwd: dir,
        config,
        stderr: sink().out,
        fixRunner: (_adapter, ctx) => {
          seen.push(`${ctx.cwd.slice(dir.length)}:${ctx.pm}`);
          return Promise.resolve({ ok: true, exit_code: 0 });
        },
      });
      expect(seen).toEqual(['/apps/web:pnpm', '/apps/api:yarn']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a target's fixer runs from its root, named <target>:<slot>", async () => {
    const ran: string[] = [];
    const err = sink();
    const result = await runFix({
      cwd: '/repo',
      config,
      stderr: err.out,
      pm: 'pnpm',
      fixRunner: (adapter, ctx) => {
        ran.push(`${adapter.name}@${ctx.cwd}`);
        return Promise.resolve({ ok: true, exit_code: 0 });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(['oxlint@/repo/apps/web', 'oxlint@/repo/apps/api']);
    expect(err.text()).toContain('✔ web:lint');
    expect(err.text()).toContain('✔ api:lint');
  });
});

/** A selected check of `slot`, in `target` when given, skipped with `skip` when given. */
function check(slot: string, target?: { name: string; root: string }, skip: string | null = null): ResolvedCheck {
  return { slot, optIn: false, adapter: null, skip, ...(target ? { target: target.name, root: target.root } : {}) };
}

describe('skipUnchanged', () => {
  const web = { name: 'web', root: 'apps/web' };
  const api = { name: 'api', root: 'apps/api' };

  test("a target with nothing changed under its root sits out, naming the root, and keeps its place", () => {
    const selected = [check('lint', web), check('lint', api), check('links')];
    expect(skipUnchanged(selected, ['apps/web/src/a.ts']).map((r) => r.skip)).toEqual([null, 'no changes under apps/api', null]);
  });

  test('a repo-scope or top-level check runs with nothing changed at all', () => {
    expect(skipUnchanged([check('links'), check('licenses')], []).map((r) => r.skip)).toEqual([null, null]);
  });

  test('a check resolution already skipped keeps its own reason', () => {
    expect(skipUnchanged([check('test', api, 'no adapter detected')], [])[0]?.skip).toBe('no adapter detected');
  });

  test('null skips nothing', () => {
    const selected = [check('lint', web), check('lint', api)];
    expect(skipUnchanged(selected, null)).toEqual(selected);
  });
});

/** Is a real git usable here? The `--changed` suites skip without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });
};

/** Write `files` under `dir`, making their directories. */
async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture files; sequential keeps each directory made before its file.
    await mkdir(join(dir, path, '..'), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- as above.
    await writeFile(join(dir, path), text);
  }
}

/** A runner whose every check passes with nothing to say. */
const passing: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

/** The checks a run ran, sorted by name, since a pool finishes them in any order. */
function ranNames(result: RunResult): string[] {
  return result.summary.checks.filter((c) => c.skipped !== true).map((c) => c.name).toSorted();
}

/** A frontend and an api target, each with a lint, plus a top-level custom check of the whole repo. */
const changedConfig: CheckrideConfig = {
  targets: {
    web: { lang: 'ts', root: 'frontend', checks: { lint: 'oxlint' } },
    api: { lang: 'ts', root: 'api', checks: { lint: 'oxlint' } },
  },
  checks: { tally: { command: 'node' } },
};

describe.skipIf(!gitAvailable)('runChecks --changed with targets (S10)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-changed-'));
    gitIn(dir, 'init', '-q', '-b', 'main');
    await writeFiles(dir, { '.gitignore': '.check/\n', 'frontend/a.ts': 'a\n', 'api/main.go': 'm\n', 'README.md': 'r\n' });
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'one');
    gitIn(dir, 'checkout', '-q', '-b', 'feature');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const runChanged = (stderr: Out = sink().out): Promise<RunResult> =>
    runChecks({ cwd: dir, config: changedConfig, runner: passing, baseline: null, changed: true, base: { ref: 'main', from: '--base' }, stderr });

  test("a change only under frontend/ skips api's checks with their reason, and runs web's and the repo's", async () => {
    await writeFile(join(dir, 'frontend/a.ts'), 'a2\n');
    gitIn(dir, 'commit', '-q', '-am', 'web change');
    const err = sink();
    const result = await runChanged(err.out);
    expect(ranNames(result)).toEqual(['links', 'tally', 'web:lint']);
    expect(result.summary.checks.find((c) => c.name === 'api:lint')).toMatchObject({
      skipped: true, ok: true, exit_code: null, reason: 'no changes under api', target: 'api',
    });
    expect(result.summary.checks_run).toBe(3);
    expect(err.text()).toMatch(/○ api:lint\s+skip {2}no changes under api/);
    expect(result.exitCode).toBe(0);
  });

  test('changes are measured from the merge base, so what main changed since is not this change (R10.2)', async () => {
    gitIn(dir, 'checkout', '-q', 'main');
    await writeFile(join(dir, 'api/main.go'), 'm2\n');
    gitIn(dir, 'commit', '-q', '-am', 'api change on main');
    gitIn(dir, 'checkout', '-q', 'feature');
    await writeFile(join(dir, 'frontend/a.ts'), 'a2\n');
    expect(ranNames(await runChanged())).toEqual(['links', 'tally', 'web:lint']);
  });

  test('an untracked file affects its target, and an unstaged edit does too', async () => {
    await writeFile(join(dir, 'api/new.go'), 'n\n');
    expect(ranNames(await runChanged())).toEqual(['api:lint', 'links', 'tally']);
    await rm(join(dir, 'api/new.go'));
    await writeFile(join(dir, 'frontend/a.ts'), 'a2\n');
    expect(ranNames(await runChanged())).toEqual(['links', 'tally', 'web:lint']);
  });

  test('a file moved between targets affects both', async () => {
    gitIn(dir, 'mv', 'api/main.go', 'frontend/main.go');
    expect(ranNames(await runChanged())).toEqual(['api:lint', 'links', 'tally', 'web:lint']);
  });

  test('with nothing changed, every target sits out and the repo-scope checks still run', async () => {
    const result = await runChanged();
    expect(ranNames(result)).toEqual(['links', 'tally']);
    expect(result.summary.checks.filter((c) => c.reason?.startsWith('no changes') === true).map((c) => `${c.name}: ${c.reason}`)).toEqual([
      'web:lint: no changes under frontend',
      'api:lint: no changes under api',
    ]);
  });
});

describe('runChecks --changed outside a git repository (F19)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-nogit-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('no target is skipped, and stderr says so', async () => {
    const err = sink();
    const result = await runChecks({ cwd: dir, config: changedConfig, runner: passing, baseline: null, changed: true, json: true, stdout: sink().out, stderr: err.out });
    expect(ranNames(result)).toEqual(['api:lint', 'links', 'tally', 'web:lint']);
    expect(result.summary.checks.filter((c) => c.reason?.startsWith('no changes') === true)).toEqual([]);
    expect(err.text()).toContain("--changed: can't list the changed paths (HEAD names no commit), so no target is skipped");
  });

  test('a repo without targets has nothing to skip, and says nothing more', async () => {
    const err = sink();
    await runChecks({ cwd: dir, config: { checks: { tally: { command: 'node' } } }, runner: passing, baseline: null, changed: true, json: true, stdout: sink().out, stderr: err.out });
    expect(err.text()).not.toContain('no target is skipped');
  });
});
