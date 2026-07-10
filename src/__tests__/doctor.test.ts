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
    readEngines: () => ({ node: '>=22.18.0', pnpm: '>=9.0.0' }),
    platform: () => ({ os: 'linux', arch: 'x64' }),
    packageManager: () => 'pnpm',
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

  test('a version exactly at the minimum is ok, not outdated', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ version: () => Promise.resolve('22.18.0') }), stdout: sink(), json: true,
    });
    expect(result.report.checks.find((c) => c.name === 'node')?.status).toBe('ok');
  });

  test('a pnpm subcommand tool (not exec) resolves via PATH, not node_modules', async () => {
    const audit: Adapter = {
      name: 'pnpm-audit', slot: 'lint', description: 'audit', detect: [],
      command: 'pnpm', args: ['audit', '--json'], outputFile: null, devDeps: {},
    };
    const result = await runDoctor({
      cwd: '/repo', slots: [{ name: 'lint' }], adapters: [audit], config: null,
      // node_modules/.bin is empty; a PATH-resolved tool must still pass.
      env: fakeEnv({ exists: () => false }), stdout: sink(), json: true,
    });
    expect(result.report.checks.find((c) => c.category === 'tool')?.status).toBe('ok');
  });

  test('reports the detected package manager in the report and the table', async () => {
    const std = sink();
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ packageManager: () => 'npm' }), stdout: std, json: false,
    });
    expect(result.report.packageManager).toBe('npm');
    expect(std.text()).toContain('package manager: npm (detected)');
  });

  test('the required PM check follows the detected PM (yarn present -> ok)', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      // Only yarn resolves on PATH; a hard pnpm requirement would wrongly fail here.
      env: fakeEnv({ packageManager: () => 'yarn', which: (cmd) => Promise.resolve(cmd === 'pnpm' ? null : `/usr/bin/${cmd}`) }),
      stdout: sink(), json: true,
    });
    expect(result.report.checks.find((c) => c.name === 'yarn')?.status).toBe('ok');
    expect(result.ok).toBe(true);
  });

  test('security (pnpm audit) is unavailable under a non-pnpm PM', async () => {
    const audit: Adapter = {
      name: 'pnpm-audit', slot: 'security', description: 'audit', detect: [],
      command: 'pnpm', args: ['audit', '--json'], outputFile: 'security.json', devDeps: {},
    };
    const result = await runDoctor({
      cwd: '/repo', slots: [{ name: 'security', optIn: true }], adapters: [audit], config: null,
      env: fakeEnv({ packageManager: () => 'yarn' }), stdout: sink(), json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'security');
    expect(slot?.enablement).toBe('unavailable');
    expect(slot?.hint).toContain('pnpm');
    expect(result.ok).toBe(true);
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

  test('an opt-in slot is shown but never fails the report', async () => {
    const result = await runDoctor({
      cwd: '/repo',
      slots: [{ name: 'mutation', optIn: true }],
      adapters: [toolAdapter('stryker', 'mutation')],
      config: null,
      // tool binary absent: an opt-in slot must stay non-fatal regardless.
      env: fakeEnv({ exists: (p: string) => !p.includes('.bin') }),
      stdout: sink(),
      json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'mutation');
    expect(slot?.enablement).toBe('opt-in');
    expect(slot?.required).toBe(false);
    expect(slot?.hint).toContain('--include mutation');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test('a config-disabled slot is shown as disabled and does not fail', async () => {
    const result = await runDoctor({
      cwd: '/repo',
      slots: oneSlot,
      adapters: oneAdapter,
      config: { checks: { lint: false } },
      env: fakeEnv(),
      stdout: sink(),
      json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'lint');
    expect(slot?.enablement).toBe('disabled');
    expect(slot?.status).toBe('n/a');
    expect(slot?.required).toBe(false);
    expect(result.ok).toBe(true);
  });

  test('an undetected slot is shown as unavailable with a possibilities hint', async () => {
    // detect file is absent on the (non-existent) /repo, so nothing fills the slot.
    const needsConfig: Adapter = { ...toolAdapter('ast-grep', 'struct'), detect: ['sgconfig.yml'] };
    const result = await runDoctor({
      cwd: '/repo', slots: [{ name: 'struct' }], adapters: [needsConfig], config: null,
      env: fakeEnv(), stdout: sink(), json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'struct');
    expect(slot?.enablement).toBe('unavailable');
    expect(slot?.adapter).toBeNull();
    expect(slot?.hint).toContain('ast-grep (sgconfig.yml)');
    expect(result.ok).toBe(true);
  });

  test('a default slot whose tool is missing still fails the report', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ exists: (p: string) => !p.includes('.bin') }), stdout: sink(), json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'lint');
    expect(slot?.enablement).toBe('default');
    expect(slot?.required).toBe(true);
    expect(slot?.status).toBe('missing');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test('renders a human table when not --json', async () => {
    const std = sink();
    await runDoctor({
      cwd: '/repo',
      slots: [{ name: 'lint' }, { name: 'mutation', optIn: true }],
      adapters: [toolAdapter('oxlint', 'lint'), toolAdapter('stryker', 'mutation')],
      config: null, env: fakeEnv(), stdout: std,
    });
    expect(std.text()).toContain('checkride doctor');
    expect(std.text()).toContain('ENVIRONMENT');
    expect(std.text()).toContain('CHECKS');
    expect(std.text()).toContain('opt-in');
    expect(std.text()).toContain('2 slots — 1 default, 1 opt-in, 0 disabled, 0 unavailable');
  });
});

describe('runDoctor (real env, gutted project)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // Probes real tool versions (pnpm, git, …); Node-CLI startup alone can
  // exceed the 5s default on slow-spawn machines.
  test('reports missing tools for a project with no node_modules', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, '.oxlintrc.json'), '{}');
    const result = await runDoctor({ cwd: dir, stdout: sink(), json: true });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const missingTool = result.report.checks.find((c) => c.category === 'tool' && c.status === 'missing');
    expect(missingTool).toBeDefined();
  }, 30_000);
});
