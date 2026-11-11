/**
 * The gate reads the config it gates by once. It used to resolve it twice, in
 * `readProfile` and again in `profileProblem`; `extends` chains made each read cost a walk of the chain.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import * as config from '../config.js';
import { runGate } from '../gate.js';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const quiet = { write: () => true };
const pinEnv = { exists: () => false, read: () => null, list: () => [], home: () => '/home/dev', running: () => '24.9.0', variable: () => undefined };

describe('runGate reads its config once', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-gate-load-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    const profiled = JSON.stringify({ checks: { evals: { command: 'node' }, judge: { command: 'node' } }, gate: { only: ['evals'] } });
    await writeFile(join(dir, 'checkride.config.json'), profiled);
    await writeFile(join(dir, 'checkride.evals.config.json'), profiled);
    vi.mocked(config.loadConfig).mockClear();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const gate = (over: Parameters<typeof runGate>[0] = {}) =>
    runGate({ cwd: dir, pm: 'pnpm', spawn: () => Promise.resolve(0), stdout: quiet, stderr: quiet, env: {}, pinEnv, ...over });

  test('the default suite’s, once, for the profile and its tokens both', async () => {
    await gate();
    expect(config.loadConfig).toHaveBeenCalledTimes(1);
    expect(config.loadConfig).toHaveBeenCalledWith(dir, undefined, 'checkride.config.json');
  });

  test('a named suite’s, once, and never the repo’s own', async () => {
    await gate({ suite: 'evals' });
    expect(config.loadConfig).toHaveBeenCalledTimes(1);
    expect(config.loadConfig).toHaveBeenCalledWith(dir, undefined, 'checkride.evals.config.json');
  });

  test('a caller that hands no profile reads no config at all', async () => {
    await gate({ profile: null });
    await gate({ profile: null, suite: 'evals' });
    expect(config.loadConfig).not.toHaveBeenCalled();
  });
});
