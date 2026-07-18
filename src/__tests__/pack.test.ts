import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CheckOutcome } from '../links.js';
import { checkPack, deriveRequired, evaluatePack, packInvocation } from '../pack.js';
import type { PackSpawn } from '../pack.js';

/** A fake spawner that returns a canned `pack --dry-run --json` file list. */
function fakePack(files: readonly string[]): PackSpawn {
  return () =>
    Promise.resolve({
      ok: true,
      exit_code: 0,
      stdout: JSON.stringify([{ files: files.map((path) => ({ path })) }]),
      stderr: '',
    });
}

describe('deriveRequired', () => {
  test('collects exports/main/types/bin targets plus README.md', () => {
    const required = deriveRequired({
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { import: './dist/index.js', types: './dist/index.d.ts' },
        './sub': './dist/sub.js',
      },
      bin: { cli: './dist/cli.js' },
    });
    expect([...required].toSorted()).toEqual(
      ['README.md', 'dist/cli.js', 'dist/index.d.ts', 'dist/index.js', 'dist/sub.js'].toSorted(),
    );
  });

  test('skips wildcard and null export entries', () => {
    const required = deriveRequired({
      exports: {
        './features/*': './dist/features/*.js',
        './blocked': null,
        '.': './dist/index.js',
      },
    });
    expect([...required].toSorted()).toEqual(['README.md', 'dist/index.js']);
  });
});

describe('evaluatePack', () => {
  test('required file present, nothing forbidden → clean', () => {
    const required = new Set(['dist/index.js', 'README.md']);
    const { missing, forbidden } = evaluatePack(['dist/index.js', 'README.md', 'package.json'], required);
    expect(missing).toEqual([]);
    expect(forbidden).toEqual([]);
  });

  test('a dist declaration file is exempt from the .ts deny rule (Q8 carve-out)', () => {
    const required = new Set(['README.md']);
    const files = ['README.md', 'dist/internal.d.ts', 'dist/internal.d.ts.map', 'dist/sub.d.mts'];
    expect(evaluatePack(files, required).forbidden).toEqual([]);
  });

  test('a required path is never reported forbidden even if a deny rule would match it', () => {
    // exports pointing at source (misconfigured, but the require must win).
    const required = new Set(['src/index.ts', 'README.md']);
    expect(evaluatePack(['src/index.ts', 'README.md'], required).forbidden).toEqual([]);
  });
});

describe('checkPack', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-pack-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function manifest(pkg: Record<string, unknown>): Promise<void> {
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  }

  test('passes when every required file is present and nothing is forbidden', async () => {
    await manifest({ name: 'lib', exports: './dist/index.js', types: './dist/index.d.ts' });
    const files = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/index.d.ts.map'];
    const outcome = await checkPack({ cwd: dir, pm: 'npm', spawn: fakePack(files) });
    expect(outcome.ok).toBe(true);
    expect(outcome.exit_code).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; files: string[] };
    expect(parsed).toEqual({ ok: true, files });
  });

  test('fails and names a missing required file', async () => {
    await manifest({ name: 'lib', exports: './dist/index.js' });
    const outcome = await checkPack({ cwd: dir, pm: 'pnpm', spawn: fakePack(['package.json', 'README.md']) });
    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(1);
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; missing: string[]; forbidden: unknown[] };
    expect(parsed.missing).toContain('dist/index.js');
    expect(outcome.stderr).toContain('missing required file: dist/index.js');
  });

  test('fails on a forbidden path and names the matched pattern', async () => {
    await manifest({ name: 'lib', exports: './dist/index.js' });
    const files = ['package.json', 'README.md', 'dist/index.js', 'src/index.ts'];
    const outcome = await checkPack({ cwd: dir, pm: 'npm', spawn: fakePack(files) });
    expect(outcome.ok).toBe(false);
    const parsed = JSON.parse(outcome.stdout) as { forbidden: { path: string; pattern: string }[] };
    const hit = parsed.forbidden.find((f) => f.path === 'src/index.ts');
    expect(hit).toBeDefined();
    expect(hit?.pattern).toBeTruthy();
    expect(outcome.stderr).toContain('forbidden path src/index.ts');
    expect(outcome.stderr).toContain(`/${hit?.pattern ?? ''}/`);
  });

  test('honors the dist declaration carve-out end-to-end', async () => {
    await manifest({ name: 'lib', exports: './dist/index.js', types: './dist/index.d.ts' });
    // A dist .d.ts that no field requires must still not be flagged (Q8).
    const files = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/extra.d.ts'];
    const outcome = await checkPack({ cwd: dir, pm: 'pnpm', spawn: fakePack(files) });
    expect(outcome.ok).toBe(true);
  });

  test('fails when the pack subprocess itself exits non-zero', async () => {
    await manifest({ name: 'lib' });
    const brokenSpawn: PackSpawn = () =>
      Promise.resolve({ ok: false, exit_code: 1, stdout: '', stderr: 'ENOENT' } satisfies CheckOutcome);
    const outcome = await checkPack({ cwd: dir, pm: 'npm', spawn: brokenSpawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('pack --dry-run exited 1');
  });
});

describe('packInvocation', () => {
  test('npm suppresses scripts with --ignore-scripts', () => {
    expect(packInvocation('npm')).toEqual({
      command: 'npm',
      args: ['pack', '--dry-run', '--json', '--ignore-scripts'],
    });
  });

  test('pnpm suppresses scripts with --config.ignore-scripts=true (it rejects the bare flag)', () => {
    expect(packInvocation('pnpm')).toEqual({
      command: 'pnpm',
      args: ['pack', '--dry-run', '--json', '--config.ignore-scripts=true'],
    });
  });

  test('yarn and bun are unavailable-until-adapter (D10)', () => {
    expect(packInvocation('yarn')).toBeNull();
    expect(packInvocation('bun')).toBeNull();
  });
});

describe('checkPack under an unsupported PM', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-pack-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'lib' }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('never spawns and reports unavailable (defensive guard for yarn/bun)', async () => {
    let spawned = false;
    const spy: PackSpawn = () => {
      spawned = true;
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '[]', stderr: '' });
    };
    const outcome = await checkPack({ cwd: dir, pm: 'yarn', spawn: spy });
    expect(spawned).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('unsupported under yarn');
  });
});

describe('checkPack (real subprocess)', () => {
  let dir: string;
  const realSpawn: PackSpawn = (command, args, cwd) =>
    new Promise((resolve) => {
      const proc = nodeSpawn(command, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (err) => resolve({ ok: false, exit_code: -1, stdout, stderr: err.message }));
      proc.on('close', (code) => resolve({ ok: code === 0, exit_code: code ?? -1, stdout, stderr }));
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-pack-real-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('runs a real `npm pack --dry-run`, parses its output, and --ignore-scripts suppresses prepack', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'pack-fixture',
        version: '1.0.0',
        main: './index.js',
        exports: './index.js',
        files: ['index.js'],
        // A prepack that, if it ran, would leave a sentinel behind (Q7/D10).
        scripts: { prepack: `node -e "require('fs').writeFileSync('${join(dir, 'SENTINEL').replace(/\\/g, '\\\\')}','1')"` },
      }),
    );
    await writeFile(join(dir, 'index.js'), 'module.exports = {}\n');
    await writeFile(join(dir, 'README.md'), '# pack fixture\n');

    const outcome = await checkPack({ cwd: dir, pm: 'npm', spawn: realSpawn });

    expect(outcome.ok).toBe(true);
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; files: string[] };
    expect(parsed.files).toContain('index.js');
    expect(parsed.files).toContain('README.md');
    // The prepack script must not have run — else it would rewrite artifacts mid-run.
    expect(existsSync(join(dir, 'SENTINEL'))).toBe(false);
  });
});
