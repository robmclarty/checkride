/**
 * Triage's doctor fold-in under the standalone binary (R14.1): `node:sea` is
 * faked to say this process is the binary, which is its own CLI and so asks
 * itself, where the npm channel looks for the repo's installed copy.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fakeSea } from '../../../test/helpers/sea.js';
import { foldDoctor } from '../doctor-fold.js';
import type { TriageEnv } from '../env.js';

/** A directory that holds no checkride: nothing is read from it but a `node_modules` that isn't there. */
const DIR = join(tmpdir(), 'checkride-no-such-repo');

let sea: ReturnType<typeof fakeSea>;

beforeEach(() => {
  sea = fakeSea();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A triage environment whose spawn answers as a green doctor does, and records what it was asked to run. */
function recording(): { env: TriageEnv; calls: { command: string; args: readonly string[] }[] } {
  const calls: { command: string; args: readonly string[] }[] = [];
  const env: TriageEnv = {
    spawn: (command, args) => {
      calls.push({ command, args });
      return Promise.resolve({ code: 0, signal: null, stdout: '{"ok":true,"checks":[]}', stderr: '', error: null });
    },
    now: () => 0,
    timeoutMs: 1000,
  };
  return { env, calls };
}

describe('triage’s doctor in the binary', () => {
  test('asks the binary itself, with nothing installed in the repo', async () => {
    const { env, calls } = recording();
    expect(await foldDoctor(DIR, env, {}, ['--suite', 'evals'])).toEqual({ state: 'ran', ok: true, exitCode: 0, findings: [] });
    expect(calls).toEqual([{ command: process.execPath, args: ['doctor', '--json', '--suite', 'evals'] }]);
  });

  test('npm finds no CLI in the same repo, and says so', async () => {
    sea.binary = false;
    const { env, calls } = recording();
    expect(await foldDoctor(DIR, env)).toEqual({ state: 'unavailable', reason: 'checkride is not installed in this repo (no node_modules/checkride)' });
    expect(calls).toEqual([]);
  });
});

describe('the fold uses the checkride the gate ran', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'checkride-fold-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function installCheckride(): string {
    const dist = join(repo, 'node_modules', 'checkride', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'cli.js'), '');
    return join(dist, 'cli.js');
  }

  test('a gate that went through the check script folds the repo’s installed checkride, on PATH’s node', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    const cli = installCheckride();
    const { env, calls } = recording();
    await foldDoctor(repo, env);
    expect(calls).toEqual([{ command: 'node', args: [cli, 'doctor', '--json'] }]);
  });

  test('a check-script repo with no checkride installed has none to ask, as from npm, and never the binary’s', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    const { env, calls } = recording();
    expect(await foldDoctor(repo, env)).toEqual({ state: 'unavailable', reason: 'checkride is not installed in this repo (no node_modules/checkride)' });
    expect(calls).toEqual([]);
  });

  test('a mise entry folds mise’s pinned copy, the one the gate ran', async () => {
    writeFileSync(join(repo, 'mise.toml'), '[tools]\n"github:robmclarty/checkride" = "latest"\n');
    const { env, calls } = recording();
    await foldDoctor(repo, env);
    expect(calls).toEqual([{ command: 'mise', args: ['exec', '--', 'checkride', 'doctor', '--json'] }]);
  });

  test('npm folds the installed copy on its own Node, as it always has', async () => {
    sea.binary = false;
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    const cli = installCheckride();
    const { env, calls } = recording();
    await foldDoctor(repo, env);
    expect(calls).toEqual([{ command: process.execPath, args: [cli, 'doctor', '--json'] }]);
  });
});
