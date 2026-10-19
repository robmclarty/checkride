import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import { ADAPTERS, SLOTS } from '../adapters.js';
import type { CheckrideConfig } from '../config.js';
import type { DoctorCheck, DoctorEnv } from '../doctor.js';
import { isProbeTimeout, runDoctor, PROBE_TIMED_OUT } from '../doctor.js';
import type { PinEnv } from '../node-pin.js';
import type { PackageManager } from '../launch/index.js';
import { launchCheck } from '../launch/index.js';

function sink(): { write: (text: string) => boolean; text: () => string } {
  const lines: string[] = [];
  return { write: (text: string) => { lines.push(text); return true; }, text: () => lines.join('') };
}

function fakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    which: (cmd: string) => Promise.resolve(`/usr/bin/${cmd}`),
    version: () => Promise.resolve('99.9.9'),
    binPath: (_pm: PackageManager, tool: string) => Promise.resolve(`/repo/.yarn/bin/${tool}`),
    exists: () => true,
    readText: () => '{"schema_version":1,"slots":{}}',
    canWrite: () => Promise.resolve(true),
    readEngines: () => ({ node: '>=22.18.0', pnpm: '>=9.0.0' }),
    platform: () => ({ os: 'linux', arch: 'x64' }),
    packageManager: () => 'pnpm',
    miseWhere: (_mise: string, spec: string) => Promise.resolve({ ok: true, stdout: `/home/dev/.local/share/mise/installs/${spec.replace('@', '/')}\n` }),
    launch: (_slot: string, command: string, args: readonly string[]) => ({ command, args: [...args] }),
    ...over,
  };
}

function toolAdapter(name: string, slot: string): Adapter {
  return { name, slot, description: name, detect: [], command: 'pnpm', args: ['exec', name], outputFile: null, devDeps: {} };
}

const oneSlot = [{ name: 'lint' }];
const oneAdapter = [toolAdapter('oxlint', 'lint')];

/** A PnP tree: `package.json`, lockfile and `.pnp.cjs`, and deliberately no node_modules. */
function pnpEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return fakeEnv({
    packageManager: () => 'yarn',
    exists: (p: string) => ['package.json', '.pnp.cjs', 'yarn.lock', '.check'].some((name) => p.includes(name)),
    ...over,
  });
}

/** Run doctor on the one-slot fixture with `pin` as its Node pin and `engines` as package.json's. */
function doctorWith(pin: PinEnv, engines: { node?: string } = { node: '>=22 <23' }) {
  return runDoctor({
    cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
    env: fakeEnv({ readEngines: () => engines }), pinEnv: pin, stdout: sink(), json: true,
  });
}

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
        // A node_modules layout with the bin absent — not PnP, which resolves
        // through the package manager instead and is covered separately below.
        env: fakeEnv({
          packageManager: () => pm,
          exists: (p: string) => !p.includes('.bin') && !p.includes('.pnp.'),
        }),
        stdout: sink(), json: true,
      });
      const tool = result.report.checks.find((c) => c.category === 'tool');
      expect(tool?.hint, `${pm} got another PM's install command`).toContain(`${pm} install`);
      expect(tool?.hint).not.toContain('pnpm install');
    }
  });

  /**
   * A Yarn PnP project has no `node_modules/` and no `node_modules/.bin` — the
   * install artifact is `.pnp.cjs`. Both of doctor's path-based tests therefore
   * reported a healthy PnP repo as broken: `install` as "lockfile only", and
   * every tool as missing. Meanwhile the checks themselves ran green, so the two
   * commands contradicted each other.
   */
  describe('Yarn PnP (no node_modules)', () => {
    test('install is ok on .pnp.cjs + lockfile, with no node_modules', async () => {
      const result = await runDoctor({
        cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
        env: pnpEnv(), stdout: sink(), json: true,
      });
      const install = result.report.checks.find((c) => c.name === 'install');
      expect(install?.status).toBe('ok');
      expect(install?.found).toContain('PnP');
    });

    test('a tool is resolved through the package manager, not a path', async () => {
      const result = await runDoctor({
        cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
        env: pnpEnv({ binPath: () => Promise.resolve('/cache/oxlint.zip/bin/oxlint') }),
        stdout: sink(), json: true,
      });
      const tool = result.report.checks.find((c) => c.category === 'tool');
      expect(tool?.status).toBe('ok');
      expect(tool?.found).toBe('/cache/oxlint.zip/bin/oxlint');
      expect(result.ok).toBe(true);
    });

    /**
     * The fix must not make doctor optimistic: a tool that genuinely does not
     * resolve still has to report missing, or this trades a false red for a
     * false green — the worse of the two.
     */
    test('a tool that does not resolve is still reported missing', async () => {
      const result = await runDoctor({
        cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
        env: pnpEnv({ binPath: () => Promise.resolve(null) }), stdout: sink(), json: true,
      });
      const tool = result.report.checks.find((c) => c.category === 'tool');
      expect(tool?.status).toBe('missing');
      expect(tool?.hint).toContain('yarn add -D oxlint');
      expect(result.ok).toBe(false);
    });

    /**
     * "The probe never answered" is not "the tool is absent". Folding a timeout
     * into missing told the reader to install a tool that may be sitting right
     * there — the same distinction `checkVersioned` draws for `--version`.
     */
    test('a timed-out bin probe is unknown, not missing', async () => {
      const result = await runDoctor({
        cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
        env: pnpEnv({ binPath: () => Promise.resolve(PROBE_TIMED_OUT) }), stdout: sink(), json: true,
      });
      const tool = result.report.checks.find((c) => c.category === 'tool');
      expect(tool?.status).toBe('unknown');
      expect(tool?.hint).toContain('timed out');
      expect(tool?.hint).not.toContain('yarn add -D');
    });

    /**
     * PnP is Yarn-only, so a `.pnp.cjs` left behind by a migration off Yarn must
     * not reroute an npm or pnpm repo into asking `npm bin` for its tools.
     */
    test('a stale .pnp.cjs does not reroute a non-yarn repo', async () => {
      const result = await runDoctor({
        cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null,
        env: pnpEnv({
          packageManager: () => 'npm',
          // .pnp.cjs is present, but there is no node_modules/.bin either.
          binPath: () => Promise.resolve('/should/not/be/consulted'),
        }),
        stdout: sink(), json: true,
      });
      const tool = result.report.checks.find((c) => c.category === 'tool');
      expect(tool?.status).toBe('missing');
      expect(tool?.expected).toContain('node_modules/.bin');
    });
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
      env: fakeEnv({ version: (cmd: string) => Promise.resolve(cmd === 'node' ? PROBE_TIMED_OUT : '99.9.9') }),
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
    expect(slot).toMatchObject({ origin: 'detected', detectedBy: 'package.json: scripts.build' });
    expect(result.ok).toBe(true);
  });

  test('a slot row ends with the tag a run prints for the same check (S21)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc --build' } }));
    const links: Adapter = {
      name: 'links', slot: 'links', description: 'Relative markdown links', detect: [], command: 'node', args: [],
      outputFile: null, builtin: 'links', devDeps: {},
    };
    const std = sink();
    const result = await runDoctor({
      cwd: dir,
      slots: [...buildSlot, { name: 'links' }, { name: 'docs' }],
      adapters: [buildAdapter, links],
      config: { checks: { docs: false, licenses: { command: 'node' } } },
      env: fakeEnv(),
      stdout: std,
      json: false,
    });
    const rows = std.text().split('\n');
    expect(rows.find((l) => l.includes(' build '))).toMatch(/ {2}\[detected: package\.json: scripts\.build\]$/);
    expect(rows.find((l) => l.includes(' links '))).toMatch(/ {2}\[built-in\]$/);
    expect(rows.find((l) => l.includes(' licenses '))).toMatch(/ {2}\[custom\]$/);
    // A slot that won't run says why in its note instead, and carries no origin.
    expect(rows.find((l) => l.includes(' docs '))).not.toContain('[');
    expect(result.report.checks.find((c) => c.slot === 'docs')).not.toHaveProperty('origin');
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
    expect(bySlot.get('build')?.detectedBy).toBe('package.json: scripts.build');
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

/**
 * The hook-context row.
 *
 * `doctor` runs in the shell someone typed it into; the gate runs in a hook,
 * which an agent harness launches from a non-login shell — one that never
 * sources the rc file a version manager puts its shims in. That is how `doctor`
 * reported `environment ok` for a repo whose gate could not start at all. This
 * row is the part of the answer that does not depend on which shell asks: given
 * the repo's pin, could checkride put the right Node back if a hook arrived with
 * the wrong one?
 */
/** The hook-context row, if `doctor` emitted one. */
function pinRow(r: Awaited<ReturnType<typeof runDoctor>>) {
  return r.report.checks.find((c) => c.name === 'node pin');
}

describe('runDoctor — the Node pin a hook would need', () => {
  const HOME = '/home/dev';

  function pinEnv(over: Partial<PinEnv> = {}): PinEnv {
    return {
      exists: () => false,
      read: () => null,
      list: () => [],
      home: () => HOME,
      running: () => '24.9.0',
      variable: () => undefined,
      ...over,
    };
  }

  /** A repo pinning 22.22.3, with an nvm install of it when `installed`. */
  function pinned(installed: boolean): PinEnv {
    const root = join(HOME, '.nvm', 'versions', 'node');
    return pinEnv({
      read: (p) => (p.endsWith('.nvmrc') ? '22.22.3\n' : null),
      list: (d) => (installed && d === root ? ['v22.22.3'] : []),
      exists: (p) => installed && p.startsWith(join(root, 'v22.22.3')),
    });
  }

  test('names the install a hook on the wrong Node would be aligned to', async () => {
    const row = pinRow(await doctorWith(pinned(true)));
    expect(row?.status).toBe('ok');
    expect(row?.expected).toBe('.nvmrc 22.22.3');
    expect(row?.found).toBe(join(HOME, '.nvm', 'versions', 'node', 'v22.22.3', 'bin'));
  });

  test('flags a pin nothing on this machine satisfies — the gate could not align', async () => {
    const row = pinRow(await doctorWith(pinned(false)));
    expect(row?.status).toBe('outdated');
    expect(row?.hint).toContain('non-login shell');
    expect(row?.hint).toContain('CHECKRIDE_NODE_BIN');
  });

  /** `engines.node` is a range. It can refuse a hook and names nothing to align to. */
  test('flags engines.node with no exact pin to align to', async () => {
    const row = pinRow(await doctorWith(pinEnv()));
    expect(row?.status).toBe('outdated');
    expect(row?.found).toBe('no .nvmrc or .node-version');
    expect(row?.hint).toContain('.nvmrc');
  });

  test('says nothing at all about a repo that pins no Node', async () => {
    expect(pinRow(await doctorWith(pinEnv(), {}))).toBeUndefined();
  });

  /**
   * Never required. A repo whose contributors always work in the right shell is
   * not broken, and failing `doctor` for it would be the false alarm this whole
   * change exists to remove.
   */
  test('never fails the report — it describes a risk, not a fault', async () => {
    const result = await doctorWith(pinned(false));
    expect(pinRow(result)?.required).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

const baselineRow = (checks: readonly { name: string }[]): { name: string } | undefined =>
  checks.find((c) => c.name === 'baseline');

describe('baseline workspace row', () => {
  const baseOpts = { cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null, json: true };

  test('a valid committed baseline reports its key count', async () => {
    const env = fakeEnv({ readText: () => '{"schema_version":1,"slots":{"lint":["a","b"],"spell":["x"]}}' });
    const result = await runDoctor({ ...baseOpts, env, stdout: sink() });
    expect(baselineRow(result.report.checks)).toMatchObject({
      category: 'workspace', required: false, status: 'ok', found: '3 grandfathered diagnostic(s)',
    });
    expect(result.ok).toBe(true);
  });

  /**
   * Advisory, never required: a broken baseline degrades a run (grandfathered
   * findings report red), it does not break checkride — doctor points at the
   * remedy instead of turning red itself.
   */
  test('an unparseable baseline warns and points at recover without failing doctor', async () => {
    const env = fakeEnv({ readText: () => '<<<<<<< HEAD\n{ mangled' });
    const result = await runDoctor({ ...baseOpts, env, stdout: sink() });
    const row = result.report.checks.find((c) => c.name === 'baseline');
    expect(row?.status).toBe('outdated');
    expect(row?.hint).toContain('checkride recover');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test('no baseline file, no row', async () => {
    const env = fakeEnv({ exists: (p: string) => !p.endsWith('checkride.baseline.json') });
    const result = await runDoctor({ ...baseOpts, env, stdout: sink() });
    expect(baselineRow(result.report.checks)).toBeUndefined();
  });
});

/** The directories doctor asked to write, and an env that answers `writable` for `ok`. */
function probing(ok: boolean): { env: DoctorEnv; probed: string[] } {
  const probed: string[] = [];
  return { probed, env: fakeEnv({ canWrite: (dir) => { probed.push(dir); return Promise.resolve(ok); } }) };
}

describe('output directory workspace row', () => {
  const baseOpts = { cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null, json: true };

  test('probes <cwd>/.check by default, and names the row .check', async () => {
    const { env, probed } = probing(true);
    const result = await runDoctor({ ...baseOpts, env, stdout: sink() });
    expect(probed).toEqual(['/repo/.check']);
    expect(result.report.checks.find((c) => c.category === 'workspace' && c.name === '.check')?.status).toBe('ok');
  });

  test('probes the directory --out named, named the way a run names it', async () => {
    const { env, probed } = probing(false);
    const result = await runDoctor({ ...baseOpts, out: '/agent/out', env, stdout: sink() });
    expect(probed).toEqual(['/agent/out']);
    expect(result.report.checks.find((c) => c.name === '/agent/out')).toMatchObject({
      category: 'workspace', required: true, status: 'missing', hint: 'Ensure /agent/out is writable.',
    });
    expect(result.exitCode).toBe(1);
  });

  test('a relative --out resolves against cwd and keeps its relative name', async () => {
    const { env, probed } = probing(true);
    const result = await runDoctor({ ...baseOpts, out: 'build/check', env, stdout: sink() });
    expect(probed).toEqual(['/repo/build/check']);
    expect(result.report.checks.some((c) => c.name === 'build/check')).toBe(true);
  });
});

/** The hint on the row of the check named `name`. */
function hintOf(report: { checks: readonly { slot?: string; hint?: string | null }[] }, name: string): string {
  return report.checks.find((c) => c.slot === name)?.hint ?? '';
}

describe('runDoctor names the mode, the targets, each tool’s pin source and the code no target checks', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-targets-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (path: string, content = '{}'): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };
  const doctor = (config: CheckrideConfig | null, over: Partial<DoctorEnv> = {}, json = true) => {
    const std = sink();
    return runDoctor({ cwd: dir, config, env: fakeEnv(over), stdout: std, json }).then((result) => ({ ...result, text: std.text() }));
  };
  const bashTarget: CheckrideConfig = {
    targets: { web: { lang: 'ts', root: 'apps/web' }, scripts: { lang: 'bash', root: 'scripts', checks: { format: 'shfmt' } } },
    checks: { links: false },
  };

  test('without targets: implicit mode, every npm tool through js-lockfile, and no row for other languages when there are none', async () => {
    await put('.oxlintrc.json');
    const { report, text } = await doctor(null, {}, false);
    expect(report.mode).toBe('implicit');
    expect(report.pack).toBe('ts');
    expect(report).not.toHaveProperty('targets');
    expect(report.unclaimed).toEqual([]);
    expect(report.checks.find((c) => c.slot === 'lint')).toMatchObject({ adapter: 'oxlint', pinSource: 'js-lockfile' });
    expect(report.checks.find((c) => c.name === 'other languages')).toBeUndefined();
    expect(text).toContain('mode: implicit (the repo is one ts project at its root)');
    expect(text.split('\n').find((l) => l.includes(' lint '))).toMatch(/installed +js-lockfile {2}\[detected: \.oxlintrc\.json\]$/);
  });

  test("an unfilled slot's hint names its own pack's tools, each with what turns it on", async () => {
    await put('svc/go.mod', 'module example.com/svc\n\ngo 1.24\n');
    await put('rs/Cargo.toml', '[package]\nname = "rs"\n');
    await put('scripts/a.sh', '#!/bin/sh\n');
    const { report } = await doctor({
      targets: { svc: { lang: 'go', root: 'svc' }, rs: { lang: 'rust', root: 'rs' }, scripts: { lang: 'bash', root: 'scripts' } },
    });
    const goLint = hintOf(report, 'svc:lint');
    expect(goLint).toContain('golangci-lint (.golangci.yml or .golangci.yaml)');
    expect(goLint).toContain('staticcheck (declare it in go.mod with `go get -tool honnef.co/go/tools/cmd/staticcheck`');
    expect(goLint).not.toContain('oxlint');
    expect(hintOf(report, 'svc:dead')).toBe('Enable by adding one of: deadcode (declare it in go.mod with `go get -tool golang.org/x/tools/cmd/deadcode`).');
    expect(hintOf(report, 'rs:dead')).toContain('cargo-machete (pin it with `mise use ubi:bnjbvr/cargo-machete@<version>`');
    expect(hintOf(report, 'rs:dead')).not.toContain('fallow');
    expect(hintOf(report, 'scripts:lint')).toBe(
      'Enable by adding one of: shellcheck (.shellcheckrc, or pin it with `mise use shellcheck@<version>`, or install shellcheck (https://www.shellcheck.net)).',
    );
  });

  test('a ts repo without targets is never told to add a tool its package manager can’t install', async () => {
    const { report } = await doctor(null);
    expect(hintOf(report, 'docs')).toBe('Enable by adding one of: markdownlint-cli2 (.markdownlint-cli2.jsonc or .markdownlint-cli2.json).');
    expect(hintOf(report, 'spell')).toBe('Enable by adding one of: cspell (cspell.json or .cspell.json, or cspell in package.json).');
  });

  test('a snippets check that isn’t the built-in carries no note about doc fences', async () => {
    await put('rs/Cargo.toml', '[package]\nname = "rs"\n');
    const { report } = await doctor({ targets: { rs: { lang: 'rust', root: 'rs', checks: { snippets: 'cargo-doctest' } } } });
    expect(hintOf(report, 'rs:snippets')).not.toContain('Inspects');
  });

  test('without targets, it hints at other languages’ markers it sees, as a warning that never fails it', async () => {
    await put('svc/go.mod', 'module x\n');
    await put('infra/main.tf', '');
    const { report, text, exitCode } = await doctor(null, {}, false);
    expect(report.unclaimed?.map((u) => u.path)).toEqual(['infra/main.tf', 'svc/go.mod']);
    expect(report.checks.find((c) => c.name === 'other languages')).toMatchObject({
      category: 'workspace', required: false, status: 'outdated', found: 'infra/main.tf (terraform), svc/go.mod (go)',
    });
    expect(text).toContain('Declare targets in checkride.config.json to check each part from its own root.');
    expect(exitCode).toBe(0);
  });

  test('without targets at a go.mod root: the implicit go pack, its checks by slot, and a ts marker below as another language (R2.1)', async () => {
    await put('go.mod', 'module example.com/m\n');
    await put('tools/package.json');
    const { report, text } = await doctor(null, {}, false);
    expect(report).toMatchObject({ mode: 'implicit', pack: 'go' });
    expect(report.checks.find((c) => c.slot === 'types')).toMatchObject({ adapter: 'go-build' });
    expect(report.checks.find((c) => c.name === 'other languages')).toMatchObject({ found: 'tools/package.json (ts)' });
    expect(text).toContain('mode: implicit (the repo is one go project at its root)');
    expect(text).toContain('checkride checks this repo as one go project, so no check reads that code.');
  });

  test('with targets: the mode, a targets table, and each check named and probed from its own target', async () => {
    await put('apps/web/.oxlintrc.json');
    await put('scripts/a.sh', '#!/bin/sh\n');
    await put('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
    const { report, text } = await doctor(bashTarget, {}, false);
    expect(report.mode).toBe('multi-target');
    expect(report).not.toHaveProperty('pack');
    expect(report.targets).toEqual([{ name: 'web', pack: 'ts', root: 'apps/web' }, { name: 'scripts', pack: 'bash', root: 'scripts' }]);
    expect(report.checks.find((c) => c.slot === 'web:lint')).toMatchObject({ target: 'web', adapter: 'oxlint', pinSource: 'js-lockfile', name: 'oxlint (web:lint)' });
    expect(report.checks.find((c) => c.slot === 'scripts:lint')).toMatchObject({
      target: 'scripts', adapter: 'shellcheck', pinSource: 'mise', status: 'ok', found: 'mise (mise.toml: shellcheck)', detectedBy: 'mise.toml: shellcheck',
    });
    expect(text).toContain('mode: multi-target (2 targets)');
    expect(text).toMatch(/TARGETS\n {4}web {6}ts {4}apps\/web\n {4}scripts {2}bash {2}scripts\n/);
  });

  test('a tool nothing pins is a warning, and a failure under requirePins for a check that runs by default', async () => {
    await put('scripts/a.sh', '#!/bin/sh\n');
    const warned = await doctor(bashTarget);
    expect(warned.report.checks.find((c) => c.slot === 'scripts:format')).toMatchObject({ pinSource: 'path', status: 'ok', found: '/usr/bin/shfmt' });
    expect(warned.report.checks.find((c) => c.category === 'pin')).toMatchObject({
      name: 'shfmt', required: false, status: 'outdated', found: 'unpinned (from PATH)',
      hint: 'scripts:format runs whatever `shfmt` PATH holds; pin it with: mise use shfmt@<version>.',
    });
    expect(warned.exitCode).toBe(0);

    const strict = await doctor({ ...bashTarget, requirePins: true });
    expect(strict.report.checks.find((c) => c.category === 'pin')).toMatchObject({ name: 'shfmt', required: true, status: 'missing' });
    expect(strict.report.checks.find((c) => c.category === 'pin')?.hint).toContain('requirePins is on');
    expect(strict.exitCode).toBe(1);
  });

  test('a tool mise pins reports missing when mise is not on PATH', async () => {
    await put('scripts/.shellcheckrc', '');
    await put('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
    const { report } = await doctor(bashTarget, { which: (cmd: string) => Promise.resolve(cmd === 'mise' ? null : `/usr/bin/${cmd}`) });
    expect(report.checks.find((c) => c.slot === 'scripts:lint')).toMatchObject({ pinSource: 'mise', status: 'missing', expected: 'pinned in mise.toml: shellcheck' });
    expect(report.checks.find((c) => c.slot === 'scripts:lint')?.hint).toContain('Install mise');
  });

  test('with targets, a row for the markers unclaimed reports, honoring unclaimed.ignore', async () => {
    await put('apps/web/package.json');
    await put('tools/x/package.json');
    const { report } = await doctor(bashTarget);
    expect(report.unclaimed?.map((u) => u.path)).toEqual(['tools/x/package.json']);
    expect(report.checks.find((c) => c.name === 'unclaimed')).toMatchObject({ required: false, status: 'outdated', found: 'tools/x/package.json (ts)' });
    const quiet = await doctor({ ...bashTarget, unclaimed: { ignore: ['tools'] } });
    expect(quiet.report.checks.find((c) => c.name === 'unclaimed')).toMatchObject({ status: 'ok', found: 'every marker sits in a target' });
  });
});

/** An env that reads real files, so the entry command resolves from what's on disk. */
const onDisk = (): DoctorEnv => fakeEnv({ readText: (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null) });

describe('runDoctor reports how hooks run checkride where it is not the check script (R6.6)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-entry-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const harnessRow = async (): Promise<DoctorCheck | undefined> =>
    (await runDoctor({ cwd: dir, slots: oneSlot, adapters: oneAdapter, config: null, env: onDisk(), stdout: sink(), json: true })).report.checks.find(
      (c) => c.name === 'harness',
    );

  test('a package.json repo runs its check script, as always, and gets no row', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    expect(await harnessRow()).toBeUndefined();
  });

  test('a repo whose mise.toml pins checkride runs mise’s copy', async () => {
    await writeFile(join(dir, 'mise.toml'), '[tools]\n"npm:checkride" = "0.14.0"\n');
    expect(await harnessRow()).toMatchObject({ category: 'env', required: false, status: 'ok', found: 'mise exec -- checkride' });
  });

  test('a repo with neither runs the checkride on PATH, and doctor reports the harness unpinned', async () => {
    const row = await harnessRow();
    expect(row).toMatchObject({ status: 'outdated', required: false, found: 'unpinned (`checkride` from PATH)' });
    expect(row?.hint).toContain('harness unpinned');
    // Opted in, since mise's npm backend refuses checkride's download count without it (D80).
    expect(row?.hint).toContain("mise use 'npm:checkride[allow_low_downloads=true]@<version>'");
  });
});

/**
 * A Go or Rust root, or a scaffold that runs checkride through mise, has no
 * Node install to check, so the install row that demanded a lockfile there
 * made `doctor` exit 1 on a repo with nothing wrong.
 */
const doctorWhere = (exists: (p: string) => boolean) =>
  runDoctor({ cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null, env: fakeEnv({ exists }), stdout: sink(), json: true });

describe('runDoctor in a root with no package.json', () => {
  test('reports the install row n/a and not required, so it fails nothing', async () => {
    const result = await doctorWhere((p) => !p.endsWith('package.json'));
    expect(result.report.checks.find((c) => c.name === 'install')).toMatchObject({ status: 'n/a', required: false, found: 'no package.json', hint: null });
    expect(result.ok).toBe(true);
  });

  test('reports the package-manager row n/a and not required, so a root with no package manager on PATH passes (D84)', async () => {
    const std = sink();
    const result = await runDoctor({
      cwd: '/repo', slots: oneSlot, adapters: oneAdapter, config: null, stdout: std, json: false,
      env: fakeEnv({ exists: (p) => !p.endsWith('package.json'), which: (cmd) => Promise.resolve(cmd === 'pnpm' ? null : `/usr/bin/${cmd}`) }),
    });
    expect(result.report.checks.find((c) => c.name === 'pnpm')).toMatchObject({ category: 'env', status: 'n/a', required: false, found: 'no package.json', hint: null });
    expect(std.text()).toMatch(/· pnpm +no package\.json\n/);
    expect(result.ok).toBe(true);
  });

  test('still requires the package manager in a package.json root', async () => {
    const result = await doctorWhere(() => true);
    expect(result.report.checks.find((c) => c.name === 'pnpm')).toMatchObject({ status: 'ok', required: true });
  });

  test('still fails a package.json root that has no lockfile', async () => {
    const result = await doctorWhere((p) => !p.endsWith('pnpm-lock.yaml'));
    expect(result.report.checks.find((c) => c.name === 'install')).toMatchObject({ status: 'missing', required: true, expected: 'pnpm-lock.yaml present' });
    expect(result.ok).toBe(false);
  });
});

/** A `mise where` that fails the test if doctor asks it at all. */
const neverAsked: DoctorEnv['miseWhere'] = () => { throw new Error('asked mise where without --pins'); };

/** A `mise where` that finds no copy at the version it's asked for. */
const notInstalled: DoctorEnv['miseWhere'] = (_mise, spec) => Promise.resolve({ ok: false, detail: `${spec} not installed`, untrusted: false });

/** A `mise where` that refuses because mise hasn't trusted the config file at `config`. */
const untrustedAt = (config: string): Partial<DoctorEnv> => ({
  miseWhere: () => Promise.resolve({ ok: false, detail: `Config files in ${config} are not trusted.`, untrusted: true, config }),
});

/**
 * `doctor --pins` probes the copies a `--pins` run would launch (R13.3): each
 * check whose tool or toolchain the file pins resolves through the `override`
 * source, reports the version `mise where` finds, and names a version mise
 * hasn't installed, and the unpinned list reads the file as a run does.
 */
describe('runDoctor under --pins', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-pins-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (path: string, content = ''): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };
  const scripts: CheckrideConfig = { targets: { scripts: { lang: 'bash', root: 'scripts', checks: { format: 'shfmt' } } }, checks: { links: false } };
  const pinned = (tools: Record<string, string>) => ({ path: join(dir, 'agent.toml'), tools: new Map(Object.entries(tools)) });
  const doctor = (config: CheckrideConfig | null, tools: Record<string, string> | null, over: Partial<DoctorEnv> = {}, json = true) => {
    const std = sink();
    return runDoctor({ cwd: dir, config, env: fakeEnv(over), stdout: std, json, ...(tools !== null ? { pins: pinned(tools) } : {}) })
      .then((result) => ({ ...result, text: std.text(), row: (slot: string) => result.report.checks.find((c) => c.slot === slot) }));
  };

  test('a tool the file pins resolves through override, with the version mise where finds, and leaves the unpinned list', async () => {
    await put('scripts/a.sh', '#!/bin/sh\n');
    await put('scripts/.shellcheckrc');
    const asked: { spec: string; cwd: string; repo: string }[] = [];
    const miseWhere: DoctorEnv['miseWhere'] = (_mise, spec, at) => {
      asked.push({ spec, ...at });
      return Promise.resolve({ ok: true, stdout: `/home/dev/.local/share/mise/installs/shfmt/3.14.1\n` });
    };
    const { row, report, text, exitCode } = await doctor(scripts, { shfmt: '3.14' }, { miseWhere }, false);
    expect(row('scripts:format')).toMatchObject({
      pinSource: 'override', status: 'ok', toolVersion: '3.14.1', found: '/home/dev/.local/share/mise/installs/shfmt/3.14.1', expected: 'shfmt@3.14 installed',
    });
    expect(asked).toEqual([{ spec: 'shfmt@3.14', cwd: join(dir, 'scripts'), repo: dir }]);
    // shellcheck, which the file doesn't pin, keeps the repo's own chain.
    expect(row('scripts:lint')).toMatchObject({ pinSource: 'path' });
    expect(report.checks.filter((c) => c.category === 'pin').map((c) => c.name)).toEqual(['shellcheck']);
    expect(text.split('\n').find((l) => l.includes(' scripts:format '))).toMatch(/installed +override 3\.14\.1 {2}\[config\]$/);
    expect(exitCode).toBe(0);
  });

  test('without --pins the same tool stays unpinned, and mise is never asked', async () => {
    await put('scripts/a.sh', '#!/bin/sh\n');
    await put('scripts/.shellcheckrc');
    const { row, report } = await doctor(scripts, null, { miseWhere: neverAsked });
    expect(row('scripts:format')).toMatchObject({ pinSource: 'path' });
    expect(row('scripts:format')).not.toHaveProperty('toolVersion');
    expect(report.checks.filter((c) => c.category === 'pin').map((c) => c.name)).toEqual(['shfmt', 'shellcheck']);
  });

  test('a version mise hasn’t installed is named, and fails a check that runs by default, as the run fails it', async () => {
    await put('scripts/a.sh', '#!/bin/sh\n');
    const { row, exitCode } = await doctor(scripts, { shfmt: '9.9.9' }, { miseWhere: notInstalled });
    expect(row('scripts:format')).toMatchObject({ pinSource: 'override', status: 'missing', required: true, found: null, expected: 'shfmt@9.9.9 installed' });
    expect(row('scripts:format')?.hint).toBe('mise where shfmt@9.9.9: shfmt@9.9.9 not installed. Checks never install a tool: run `mise install shfmt@9.9.9`.');
    expect(exitCode).toBe(1);
  });

  test('an untrusted config names mise trust only when it sits outside the repo, and mise off PATH names mise', async () => {
    await put('scripts/a.sh', '#!/bin/sh\n');
    const outside = await doctor(scripts, { shfmt: '3.14.1' }, untrustedAt('/home/dev/mise.toml'));
    expect(outside.row('scripts:format')?.hint).toContain("mise won't read /home/dev/mise.toml until it's trusted");
    expect(outside.row('scripts:format')?.hint).toContain('`mise trust`');
    const inside = await doctor(scripts, { shfmt: '3.14.1' }, untrustedAt(join(dir, 'mise.toml')));
    expect(inside.row('scripts:format')?.hint).toContain('Upgrade mise');
    expect(inside.row('scripts:format')?.hint).not.toContain('mise trust');
    const noMise = await doctor(scripts, { shfmt: '3.14.1' }, { which: (cmd: string) => Promise.resolve(cmd === 'mise' ? null : `/usr/bin/${cmd}`) });
    expect(noMise.row('scripts:format')).toMatchObject({ pinSource: 'override', status: 'missing' });
    expect(noMise.row('scripts:format')?.hint).toContain('Install mise');
  });

  test('a toolchain the file pins runs that copy in any chain, gofmt under go’s key included', async () => {
    await put('go.mod', 'module example.com/m\n');
    const specs: string[] = [];
    const miseWhere: DoctorEnv['miseWhere'] = (_mise, spec) => {
      specs.push(spec);
      return Promise.resolve({ ok: true, stdout: '/home/dev/.local/share/mise/installs/go/1.27.2\n' });
    };
    const { row } = await doctor(null, { go: '1.27' }, { miseWhere });
    expect(row('types')).toMatchObject({ adapter: 'go-build', pinSource: 'override', toolVersion: '1.27.2', status: 'ok' });
    expect(row('format')).toMatchObject({ adapter: 'gofmt', pinSource: 'override', toolVersion: '1.27.2' });
    expect(new Set(specs)).toEqual(new Set(['go@1.27']));
  });
});

/** A checkout nobody has installed: whatever sits on disk, and no node_modules. */
const uninstalled = (path: string): boolean => existsSync(path) && !path.includes('node_modules');

/**
 * `doctor --static-only` reports what a static run would do (R13.4): each
 * check its sniffs skip, and each whose tool the launcher says needs an
 * install, with the reason the run's summary records, and an uninstalled
 * checkout fails nothing for it.
 */
describe('runDoctor under --static-only', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-static-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'x', devDependencies: { oxlint: '1.87.0', cspell: '9.0.0', prettier: '3.6.0', typescript: '5.9.3' } }),
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{}',
      '.oxlintrc.json': '{}',
      'cspell.json': '{}',
      'prettier.config.js': 'export default {};\n',
      'README.md': '# x\n',
    };
    for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const doctor = (staticOnly: boolean, over: Partial<DoctorEnv> = {}, json = true) => {
    const std = sink();
    // The run's own launcher, unless a test swaps it, so a probe and a launch read the same checkout.
    return runDoctor({ cwd: dir, config: { checks: { format: 'prettier' } }, env: fakeEnv({ exists: uninstalled, launch: launchCheck, ...over }), stdout: std, json, staticOnly })
      .then((result) => ({ ...result, text: std.text(), row: (slot: string) => result.report.checks.find((c) => c.slot === slot) }));
  };

  test('each check the sniffs skip reports its static-only reason, and fails nothing', async () => {
    const { row, exitCode } = await doctor(true);
    expect(row('types')).toMatchObject({ skip: "static-only: tsc isn't a static check", status: 'n/a', required: false, enablement: 'default' });
    expect(row('lint')).toMatchObject({ skip: 'static-only: oxlint runs with --type-aware, which needs the install', required: false });
    expect(row('format')?.skip).toMatch(/^static-only: .*prettier\.config\.js/);
    // An opt-in slot the config names runs by default, and still fails nothing when skipped.
    expect(row('format')).toMatchObject({ enablement: 'default', origin: 'config', required: false });
    expect(row('links')).not.toHaveProperty('skip');
    expect(exitCode).toBe(0);
  });

  test('a kept check whose tool the launcher refuses is skipped as needing an install, as the run skips it', async () => {
    const asked: { slot: string; staticOnly?: boolean; pins?: readonly string[] }[] = [];
    const launch: DoctorEnv['launch'] = (slot, command, args, ctx) => {
      asked.push({ slot, ...(ctx.staticOnly !== undefined ? { staticOnly: ctx.staticOnly } : {}), ...(ctx.pins !== undefined ? { pins: ctx.pins } : {}) });
      return slot === 'spell'
        ? { refusal: 'checkride: the `spell` slot needs `cspell`, which is not installed in this project.\n\n  looked for: …\n' }
        : { command, args: [...args] };
    };
    const { row, exitCode } = await doctor(true, { launch });
    expect(row('spell')).toMatchObject({
      skip: 'static-only: needs an install (the `spell` slot needs `cspell`, which is not installed in this project)', status: 'n/a', required: false,
    });
    // Only the checks the sniffs kept, and never a built-in, reach the launcher.
    expect(asked).toEqual([{ slot: 'spell', staticOnly: true, pins: ['js-lockfile'] }]);
    expect(exitCode).toBe(0);
  });

  test('the launcher pre-flights node_modules/.bin under every package manager but a PnP install (R13.4)', async () => {
    for (const pm of ['npm', 'yarn', 'bun'] as const) {
      const { row } = await doctor(true, { packageManager: () => pm });
      expect(row('spell')?.skip, pm).toMatch(/^static-only: needs an install \(the `spell` slot needs `cspell`, which is not installed in this project\)$/);
    }
  });

  test('the install row warns rather than fails, and the table marks each skip with its reason', async () => {
    const { report, text, exitCode } = await doctor(true, {}, false);
    expect(report.checks.find((c) => c.name === 'install')).toMatchObject({ required: false, status: 'outdated', found: 'lockfile only' });
    expect(report.checks.find((c) => c.name === 'install')?.hint).toContain('A --static-only run needs no install');
    expect(text).toMatch(/· types +tsc +default +skipped/);
    expect(text).toContain("-> static-only: tsc isn't a static check");
    expect(text).toMatch(/skipped by --static-only\n/);
    expect(exitCode).toBe(0);
  });

  test('without the flag the same checkout fails on its install, and no row carries a skip', async () => {
    const { report, exitCode } = await doctor(false);
    expect(report.checks.find((c) => c.name === 'install')).toMatchObject({ required: true, status: 'missing' });
    expect(report.checks.some((c) => c.skip !== undefined)).toBe(false);
    expect(exitCode).toBe(1);
  });
});

/**
 * A tool a language's own pin file declares, through `go-mod-tool`,
 * `rust-toolchain` or `uv-lock`, is probed by asking the run's launcher
 * (D84): `ok` where it would spawn, naming what it spawns, and `missing`
 * where it would refuse, with the refusal as the hint. Never `unknown`,
 * which stays for a source this checkride can't read.
 */
describe('runDoctor probes go-mod-tool, rust-toolchain and uv-lock tools through the launcher (D84)', () => {
  let dir: string;
  let bin: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-doctor-launcher-'));
    bin = await mkdtemp(join(tmpdir(), 'checkride-doctor-path-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  const put = async (path: string, content = ''): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };
  /** Fake executables on the probe's PATH, so the launcher finds a toolchain without this machine's. */
  const onPath = async (...names: string[]): Promise<void> => {
    for (const name of names) await writeFile(join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  };
  /** The run's own launcher, searching the fake PATH alone, so a probe reads the fixture and nothing this machine has. */
  const launchOnPath: DoctorEnv['launch'] = (slot, command, args, ctx) => launchCheck(slot, command, args, { ...ctx, env: { PATH: bin } });
  const doctor = (over: Partial<DoctorEnv> = {}) => {
    const std = sink();
    return runDoctor({ cwd: dir, config: null, env: fakeEnv({ exists: existsSync, launch: launchOnPath, ...over }), stdout: std, json: false })
      .then((result) => ({ ...result, text: std.text(), row: (slot: string) => result.report.checks.find((c) => c.slot === slot) }));
  };

  const goMod = 'module example.com/m\n\ngo 1.26.0\n\ntool golang.org/x/tools/cmd/deadcode\n\nrequire golang.org/x/tools v0.52.0 // indirect\n';

  test('a go.mod tool is ok where the launcher would run it through go, and names the spawn', async () => {
    await put('go.mod', goMod);
    await onPath('go', 'gofmt');
    const { row, text, exitCode } = await doctor();
    expect(row('dead')).toMatchObject({
      adapter: 'deadcode', pinSource: 'go-mod-tool', status: 'ok', required: true,
      found: 'go tool deadcode', expected: 'declared in go.mod: golang.org/x/tools/cmd/deadcode', hint: null, detectedBy: 'go.mod: golang.org/x/tools/cmd/deadcode',
    });
    expect(text.split('\n').find((l) => l.includes(' dead '))).toMatch(/installed +go-mod-tool {2}\[detected: go\.mod: golang\.org\/x\/tools\/cmd\/deadcode\]$/);
    expect(exitCode).toBe(0);
  });

  test('a go.mod tool is missing, with the refusal as its hint, where the launcher would refuse for want of go', async () => {
    await put('go.mod', goMod);
    const { row } = await doctor();
    expect(row('dead')).toMatchObject({ pinSource: 'go-mod-tool', status: 'missing', required: true, found: null, expected: 'declared in go.mod: golang.org/x/tools/cmd/deadcode' });
    expect(row('dead')?.hint).toBe(
      'the `dead` slot needs `go` to run `deadcode`, which isn\'t on PATH. install Go 1.24 or later (https://go.dev/dl), or pin it with `mise use go@<version>`',
    );
  });

  test('the launcher is asked as the run asks it, and a spawn through mise is named as one', async () => {
    await put('go.mod', goMod);
    const asked: { slot: string; cwd: string; repo: string | undefined; pins: readonly string[] | undefined; staticOnly: boolean | undefined; requirePins: boolean | undefined }[] = [];
    const launch: DoctorEnv['launch'] = (slot, _command, _args, ctx) => {
      asked.push({ slot, cwd: ctx.cwd, repo: ctx.repo, pins: ctx.pins, staticOnly: ctx.staticOnly, requirePins: ctx.requirePins });
      return { command: 'mise', args: ['exec', '--', 'go', 'tool', 'deadcode', '-test', '{go-packages}'], pin: { source: 'go-mod-tool', version: 'v0.52.0' } };
    };
    const { row } = await doctor({ launch });
    expect(row('dead')).toMatchObject({ pinSource: 'go-mod-tool', status: 'ok', found: 'mise exec -- go tool deadcode' });
    expect(asked).toEqual([{ slot: 'dead', cwd: dir, repo: dir, pins: ['go-mod-tool', 'mise', 'path'], staticOnly: false, requirePins: false }]);
  });

  test('a rustup component a toolchain file pins is ok with rustup and cargo on PATH, and missing with the refusal without rustup', async () => {
    await put('Cargo.toml', '[package]\nname = "m"\nversion = "0.1.0"\n');
    await put('rust-toolchain.toml', '[toolchain]\nchannel = "1.99.0"\n');
    await onPath('rustup', 'cargo');
    const ok = await doctor();
    expect(ok.row('lint')).toMatchObject({
      adapter: 'clippy', pinSource: 'rust-toolchain', status: 'ok', found: 'cargo clippy', expected: 'declared in rust-toolchain.toml: clippy', hint: null,
    });
    await rm(join(bin, 'rustup'));
    const missing = await doctor();
    expect(missing.row('lint')).toMatchObject({ pinSource: 'rust-toolchain', status: 'missing', required: true, found: null });
    expect(missing.row('lint')?.hint).toContain("`cargo-clippy` is pinned by a toolchain file, but `rustup` isn't on PATH.");
    expect(missing.row('lint')?.hint).toContain('declared in: rust-toolchain.toml (channel 1.99.0)');
    expect(missing.row('lint')?.hint).toContain('Install rustup (https://rustup.rs), or remove the file.');
  });

  test('a tool uv.lock locks is ok from the project environment, and missing naming uv sync before one exists', async () => {
    await put('pyproject.toml', '[project]\nname = "m"\nversion = "0.1.0"\n');
    await put('uv.lock', '[[package]]\nname = "ruff"\nversion = "0.14.0"\n');
    const missing = await doctor();
    expect(missing.row('lint')).toMatchObject({ adapter: 'ruff', pinSource: 'uv-lock', status: 'missing', required: true, found: null, expected: 'declared in uv.lock: ruff' });
    expect(missing.row('lint')?.hint).toContain("the `lint` slot's `ruff` is locked in uv.lock, but the project environment it runs from doesn't exist yet.");
    expect(missing.row('lint')?.hint).toContain('declared in: uv.lock (ruff 0.14.0)');
    expect(missing.row('lint')?.hint).toContain('Sync the environment from the lock, then re-run: uv sync');
    await put('.venv/bin/ruff', '#!/bin/sh\n');
    const ok = await doctor();
    expect(ok.row('lint')).toMatchObject({ pinSource: 'uv-lock', status: 'ok', found: '.venv/bin/ruff', expected: 'declared in uv.lock: ruff', hint: null });
  });

  test('no row of the three sources is ever unknown', async () => {
    await put('go.mod', goMod);
    await put('svc/Cargo.toml', '[package]\nname = "m"\nversion = "0.1.0"\n');
    await put('svc/rust-toolchain.toml', '[toolchain]\nchannel = "stable"\n');
    await put('py/pyproject.toml', '[project]\nname = "m"\nversion = "0.1.0"\n');
    await put('py/uv.lock', '[[package]]\nname = "ruff"\nversion = "0.14.0"\n');
    const std = sink();
    const config: CheckrideConfig = {
      targets: { greeter: { lang: 'go', root: '.' }, svc: { lang: 'rust', root: 'svc' }, py: { lang: 'python', root: 'py' } },
      unclaimed: { ignore: ['svc', 'py'] },
    };
    const { report } = await runDoctor({ cwd: dir, config, env: fakeEnv({ exists: existsSync, launch: launchOnPath }), stdout: std, json: true });
    const probed = report.checks.filter((c) => ['go-mod-tool', 'rust-toolchain', 'uv-lock'].includes(c.pinSource ?? ''));
    expect(probed.map((c) => `${c.slot} ${c.pinSource} ${c.status}`).toSorted()).toEqual([
      'greeter:dead go-mod-tool missing',
      'py:format uv-lock missing',
      'py:lint uv-lock missing',
      'svc:format rust-toolchain missing',
      'svc:lint rust-toolchain missing',
    ]);
    expect(report.checks.some((c) => c.status === 'unknown')).toBe(false);
  });
});
