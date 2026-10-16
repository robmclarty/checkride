/**
 * The orchestrator in multi-target mode, through an injected runner: each
 * target's check runs from its root with `{out}` its own directory, masks
 * against its `<target>:<slot>` baseline entry with its paths joined onto the
 * root (D50), and feeds the ratchet under that name; `fix` runs a target's
 * fixer from its root.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Baseline } from '../../baseline/index.js';
import { runBaseline } from '../../baseline-command.js';
import type { CheckrideConfig } from '../../config.js';
import type { CheckRunner, Out } from '../index.js';
import { runChecks, runFix } from '../index.js';

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
