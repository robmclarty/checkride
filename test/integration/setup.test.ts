/**
 * The e2e setup retry: a second attempt after a pause, never a third, and the
 * second attempt's error when both fail. A fake attempt stands in for the
 * network, which no unit test should need; one case spawns a real step to
 * hold the default to running from `cwd`.
 */

import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { setupStep } from '../helpers/setup.js';

const now = async () => {};

describe('setupStep', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('runs a step that succeeds once, with no pause', async () => {
    const attempt = vi.fn(now);
    const pause = vi.fn(now);
    await setupStep('go', ['mod', 'download'], { cwd: '/repo', attempt, pause });
    expect(attempt.mock.calls).toEqual([['go', ['mod', 'download'], '/repo']]);
    expect(pause).not.toHaveBeenCalled();
  });

  test('tries a failed step once more after the pause, naming it and its cause on stderr', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const attempt = async () => {
      order.push('attempt');
      if (order.length === 1) throw new Error('Command failed: go get -tool x@v1\ngo: downloading x v1\nstream error: INTERNAL_ERROR\n');
    };
    await setupStep('go', ['get', '-tool', 'x@v1'], { cwd: '/repo', attempt, pause: async () => { order.push('pause'); } });
    expect(order).toEqual(['attempt', 'pause', 'attempt']);
    expect(warn.mock.calls).toEqual([['setup step failed, trying once more: go get -tool x@v1 (stream error: INTERNAL_ERROR)']]);
  });

  test('throws the second attempt’s error when both fail, and never tries a third time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const attempt = vi.fn(async () => {
      attempts += 1;
      throw new Error(`attempt ${attempts}`);
    });
    await expect(setupStep('uv', ['sync'], { cwd: '/repo', attempt, pause: now })).rejects.toThrow('attempt 2');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  test('spawns the step from cwd by default', async () => {
    const dir = await realpath(tmpdir());
    const script = 'process.exit(process.cwd() === process.argv[1] ? 0 : 1)';
    await expect(setupStep(process.execPath, ['-e', script, dir], { cwd: dir })).resolves.toBeUndefined();
  });
});
