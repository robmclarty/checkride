import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { DoctorEnv } from '../doctor.js';
import { runDoctor } from '../doctor.js';

function sink(): { write: (text: string) => boolean; text: () => string } {
  const lines: string[] = [];
  return { write: (text: string) => { lines.push(text); return true; }, text: () => lines.join('') };
}

function fakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    which: (cmd: string) => Promise.resolve(`/usr/bin/${cmd}`),
    version: () => Promise.resolve('99.9.9'),
    exists: () => true,
    canWrite: () => Promise.resolve(true),
    readEngines: () => ({ node: '>=24.0.0', pnpm: '>=9.0.0' }),
    platform: () => ({ os: 'linux', arch: 'x64' }),
    ...over,
  };
}

function toolAdapter(name: string, slot: string): Adapter {
  return { name, slot, description: name, detect: [], command: 'pnpm', args: ['exec', name], outputFile: null, devDeps: {} };
}

const oneSlot = [{ name: 'lint' }];
const oneAdapter = [toolAdapter('oxlint', 'lint')];

describe('runDoctor (injected env)', () => {
  test('everything present -> ok, exit 0', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null, env: fakeEnv(), stdout: sink(), json: true,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const names = result.report.checks.map((c) => c.name);
    expect(names).toContain('node');
    expect(names).toContain('oxlint (lint)');
  });

  test('a missing tool binary -> missing, exit 1', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ exists: (p: string) => !p.includes('.bin') }), stdout: sink(), json: true,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const tool = result.report.checks.find((c) => c.category === 'tool');
    expect(tool?.status).toBe('missing');
  });

  test('an outdated node is flagged', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ version: (cmd: string) => Promise.resolve(cmd === 'node' ? '20.0.0' : '99.9.9') }),
      stdout: sink(), json: true,
    });
    const node = result.report.checks.find((c) => c.name === 'node');
    expect(node?.status).toBe('outdated');
    expect(result.ok).toBe(false);
  });

  test('a missing required binary on PATH is reported', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ which: (cmd: string) => Promise.resolve(cmd === 'git' ? null : `/usr/bin/${cmd}`) }),
      stdout: sink(), json: true,
    });
    const git = result.report.checks.find((c) => c.name === 'git');
    expect(git?.status).toBe('missing');
    expect(result.ok).toBe(false);
  });

  test('verifies a global-command tool via PATH', async () => {
    const custom: Adapter = {
      name: 'licenses', slot: 'licenses', description: 'licenses', detect: [],
      command: 'node', args: ['check-licenses.mjs'], outputFile: null, devDeps: {},
    };
    const present = await runDoctor({
      cwd: '/repo', slots: [{ name: 'licenses' }], adapters: [custom], config: null, env: fakeEnv(), stdout: sink(), json: true,
    });
    expect(present.report.checks.find((c) => c.category === 'tool')?.status).toBe('ok');

    const absent = await runDoctor({
      cwd: '/repo', slots: [{ name: 'licenses' }], adapters: [custom], config: null,
      env: fakeEnv({ which: () => Promise.resolve(null) }), stdout: sink(), json: true,
    });
    expect(absent.report.checks.find((c) => c.category === 'tool')?.status).toBe('missing');
  });

  test('renders a human table when not --json', async () => {
    const std = sink();
    await runDoctor({ cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null, env: fakeEnv(), stdout: std });
    expect(std.text()).toContain('checkride doctor');
    expect(std.text()).toContain('ENVIRONMENT');
  });
});

describe('runDoctor (real env, gutted project)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('reports missing tools for a project with no node_modules', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, '.oxlintrc.json'), '{}');
    const result = await runDoctor({ cwd: dir, stdout: sink(), json: true });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const missingTool = result.report.checks.find((c) => c.category === 'tool' && c.status === 'missing');
    expect(missingTool).toBeDefined();
  });
});
