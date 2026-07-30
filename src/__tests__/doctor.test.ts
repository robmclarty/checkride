import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import { ADAPTERS, SLOTS } from '../adapters.js';
import type { DoctorEnv } from '../doctor.js';
import { isProbeTimeout, runDoctor, VERSION_TIMED_OUT } from '../doctor.js';

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

  /**
   * The remediation a red tool row points at has to be runnable in the repo
   * reading it. `checkInstall` was already PM-aware; this hint was not, so an
   * npm repo's only actionable line told it to run `pnpm install`.
   */
  test('a missing tool names the detected package manager, not pnpm', async () => {
    for (const pm of ['npm', 'yarn', 'bun'] as const) {
      const result = await runDoctor({
        cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
        env: fakeEnv({ packageManager: () => pm, exists: (p: string) => !p.includes('.bin') }),
        stdout: sink(), json: true,
      });
      const tool = result.report.checks.find((c) => c.category === 'tool');
      expect(tool?.hint, `${pm} got another PM's install command`).toContain(`${pm} install`);
      expect(tool?.hint).not.toContain('pnpm install');
    }
  });

  /**
   * pnpm and npm hoist a shared workspace tool's bin to the repo root. Probing
   * `cwd` alone reported it missing from every package subdirectory — a false
   * red on a correctly installed monorepo, which is what the workspace presets
   * produce.
   */
  test('a tool hoisted to the workspace root resolves from a package subdirectory', async () => {
    const hoisted = join('/repo', 'node_modules', '.bin', 'oxlint');
    const result = await runDoctor({
      cwd: '/repo/packages/web', slots: oneSlot, adapters: oneAdapter, config: null,
      env: fakeEnv({ exists: (p: string) => p === hoisted }), stdout: sink(), json: true,
    });
    const tool = result.report.checks.find((c) => c.category === 'tool');
    expect(tool?.status).toBe('ok');
    expect(tool?.found).toBe(hoisted);
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

  test('a version probe that times out is diagnosed as "timed out", not a parse failure', async () => {
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
      // node's --version probe exceeds its budget: the seam signals a timeout, not the null it returns for a parse failure.
      env: fakeEnv({ version: (cmd: string) => Promise.resolve(cmd === 'node' ? VERSION_TIMED_OUT : '99.9.9') }),
      stdout: sink(), json: true,
    });
    const node = result.report.checks.find((c) => c.name === 'node');
    expect(node?.status).toBe('unknown');
    expect(node?.hint).toContain('timed out');
    expect(node?.hint).not.toContain('parse');
    expect(result.ok).toBe(false);
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

describe('runDoctor (build detection — D18)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-build-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const buildAdapter: Adapter = {
    name: 'build', slot: 'build', description: 'Build the package', detect: [], detectScript: 'build',
    command: 'pnpm', args: ['run', 'build'], outputFile: null, devDeps: {},
  };
  const buildSlot = [{ name: 'build', optIn: true, order: 10 as const }];

  test('build shows as opt-in and names the detection signal (scripts.build)', async () => {
    // resolveChecks reads the real package.json from cwd; env probes stay faked.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc --build' } }));
    const result = await runDoctor({
      cwd: dir, slots: buildSlot, adapters: [buildAdapter], config: null, env: fakeEnv(), stdout: sink(), json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'build');
    expect(slot?.enablement).toBe('opt-in');
    expect(slot?.hint).toContain('scripts.build');
    expect(result.ok).toBe(true);
  });

  test('an opted-in build with no build script stands down as unavailable, never failing', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const result = await runDoctor({
      cwd: dir, slots: buildSlot, adapters: [buildAdapter], config: null, env: fakeEnv(), stdout: sink(), json: true,
    });
    const slot = result.report.checks.find((c) => c.slot === 'build');
    expect(slot?.enablement).toBe('unavailable');
    expect(slot?.found).toContain("no 'build' script");
    expect(slot?.hint).toContain('scripts.build'); // possibilities hint names how to enable it
    expect(result.ok).toBe(true);
  });
});

describe('runDoctor (publish bundle slots — step 9)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-pub-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const PUB = ['build', 'pack', 'smoke', 'snippets'];
  const pubSlots = SLOTS.filter((s) => PUB.includes(s.name));
  const pubAdapters = ADAPTERS.filter((a) => PUB.includes(a.slot));

  test('renders all four as opt-in, each with its detection/inspection note', async () => {
    // A buildable library: scripts.build lights up build's detection signal.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'lib', exports: { '.': './dist/index.js' }, scripts: { build: 'tsc -b' } }));
    const result = await runDoctor({
      cwd: dir, slots: pubSlots, adapters: pubAdapters, config: null, env: fakeEnv(), stdout: sink(), json: true,
    });
    const bySlot = new Map(result.report.checks.filter((c) => c.category === 'tool').map((c) => [c.slot, c]));

    for (const slot of PUB) expect(bySlot.get(slot)?.enablement, slot).toBe('opt-in');
    expect(bySlot.get('build')?.hint).toContain('scripts.build');
    expect(bySlot.get('pack')?.hint).toContain('exports');
    expect(bySlot.get('smoke')?.hint).toContain('exports');
    expect(bySlot.get('snippets')?.hint).toContain('<!-- snippet: check -->');
    // Opt-in built-ins never fail the report.
    expect(result.ok).toBe(true);
  });
});

describe('isProbeTimeout', () => {
  test('recognizes a killed-by-timeout execFile rejection, and only that', () => {
    // Promisified execFile rejects with `killed: true` when its timeout fires.
    expect(isProbeTimeout(Object.assign(new Error('probe timed out'), { killed: true, signal: 'SIGTERM' }))).toBe(true);
    expect(isProbeTimeout(Object.assign(new Error('not found'), { code: 'ENOENT', killed: false }))).toBe(false);
    expect(isProbeTimeout(new Error('bare failure'))).toBe(false);
    expect(isProbeTimeout(null)).toBe(false);
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
