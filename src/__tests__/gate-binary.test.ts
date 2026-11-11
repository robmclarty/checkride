/**
 * The stop gate under the standalone binary (R14.1), `node:sea` faked to say
 * this process is one: where the entry command is the `checkride` on `PATH`
 * the binary runs itself, and the Node it embeds never stands for the repo's.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fakeSea } from '../../test/helpers/sea.js';
import type { GateSpawn } from '../gate.js';
import { runGate } from '../gate.js';
import type { PinEnv } from '../node-pin.js';

const HOME = '/home/dev';
const NVM = join(HOME, '.nvm', 'versions', 'node');

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** A repo whose `.nvmrc` pins 24, with an nvm install of 24.1.0, on a hook whose `PATH` holds `running`. */
function pinned(running: string | null): PinEnv {
  return {
    read: (path) => (path.endsWith('.nvmrc') ? '24\n' : null),
    list: (dir) => (dir === NVM ? ['v24.1.0'] : []),
    exists: (path) => path.startsWith(join(NVM, 'v24.1.0')),
    home: () => HOME,
    running: () => running,
    variable: () => undefined,
  };
}

/** A spawn that goes green, and what it was asked to run. */
function recording(): { spawn: GateSpawn; calls: { command: string; args: readonly string[]; path: string | undefined }[] } {
  const calls: { command: string; args: readonly string[]; path: string | undefined }[] = [];
  return { spawn: (command, args, opts) => { calls.push({ command, args, path: opts.env['PATH'] }); return Promise.resolve(0); }, calls };
}

describe('the gate in the binary', () => {
  let sea: ReturnType<typeof fakeSea>;
  let dir: string;
  beforeEach(async () => {
    sea = fakeSea();
    dir = await mkdtemp(join(tmpdir(), 'checkride-gate-binary-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const gate = (spawn: GateSpawn, pinEnv: PinEnv, stderr = capture()) =>
    runGate({ cwd: dir, spawn, stdout: capture(), stderr, env: { PATH: '/usr/bin' }, pinEnv, profile: null });

  test('runs itself for the checkride on PATH, and npm runs the one PATH holds', async () => {
    const binary = recording();
    await gate(binary.spawn, pinned('24.15.0'));
    expect(binary.calls).toEqual([{ command: process.execPath, args: ['--strict', '--digest'], path: '/usr/bin' }]);

    sea.binary = false;
    const npm = recording();
    await gate(npm.spawn, pinned('24.15.0'));
    expect(npm.calls).toEqual([{ command: 'checkride', args: ['--strict', '--digest'], path: '/usr/bin' }]);
  });

  test('leaves a mise entry and a package-manager entry as they were', async () => {
    await writeFile(join(dir, 'mise.toml'), '[tools]\n"github:robmclarty/checkride" = "latest"\n');
    const mise = recording();
    await gate(mise.spawn, pinned('24.15.0'));
    expect(mise.calls[0]).toMatchObject({ command: 'mise', args: ['exec', '--', 'checkride', '--strict', '--digest'] });

    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    const script = recording();
    await gate(script.spawn, pinned('24.15.0'));
    expect(script.calls[0]?.command).toBe('pnpm');
  });

  test('a PATH node that satisfies the pin is left alone, whatever Node the binary embeds', async () => {
    const stderr = capture();
    const { spawn, calls } = recording();
    await gate(spawn, pinned('24.15.0'), stderr);
    expect(calls[0]?.path).toBe('/usr/bin');
    expect(stderr.text()).not.toContain('running the check on Node');
  });

  test('with no node on PATH and a repo that pins one, it aligns, and claims no Node the hook started on', async () => {
    const stderr = capture();
    const { spawn, calls } = recording();
    await gate(spawn, pinned(null), stderr);
    expect(calls[0]?.path).toBe(`${join(NVM, 'v24.1.0', 'bin')}:/usr/bin`);
    expect(stderr.text()).toContain(`checkride: running the check on Node 24.1.0 from ${join(NVM, 'v24.1.0', 'bin')} (.nvmrc pins 24; this hook’s PATH holds no node).`);
    expect(stderr.text()).not.toContain('started on');
  });

  test('with no node on PATH and no pin, nothing is aligned and nothing is said', async () => {
    const stderr = capture();
    const { spawn, calls } = recording();
    await gate(spawn, { ...pinned(null), read: () => null }, stderr);
    expect(calls[0]?.path).toBe('/usr/bin');
    expect(stderr.text()).not.toContain('Node');
  });
});
