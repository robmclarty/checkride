/**
 * Contract: stream discipline (docs/contract.md §CLI).
 *
 * stdout carries machine output only: the summary JSON under `--json`,
 * otherwise nothing at all. Human-readable progress, warnings, and status go
 * to stderr. `checkride --json | jq .` must always be safe — green or red.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';

/** A sink that records what was written, for asserting on the stream. */
function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

describe('stream discipline', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-streams-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** One custom check with the given exit; `links` off so it is the only check. */
  async function configWithExit(code: number): Promise<void> {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        probe: { command: 'node', args: ['-e', `process.exit(${code})`] },
      },
    }));
  }

  test('a default run writes nothing to stdout; the human report goes to stderr', async () => {
    await configWithExit(0);
    const stdout = capture();
    const stderr = capture();
    expect(await runCli([], { cwd: dir, stdout, stderr })).toBe(0);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain('all checks passed');
  });

  test('a default failing run still keeps stdout empty', async () => {
    await configWithExit(1);
    const stdout = capture();
    expect(await runCli([], { cwd: dir, stdout, stderr: capture() })).toBe(1);
    expect(stdout.text()).toBe('');
  });

  test('--json stdout is exactly the summary JSON, green or red', async () => {
    for (const code of [0, 1]) {
      await configWithExit(code);
      const stdout = capture();
      await runCli(['--json'], { cwd: dir, stdout, stderr: capture() });
      // Parsing the whole captured stream proves nothing else leaked onto it.
      const summary = JSON.parse(stdout.text()) as Record<string, unknown>;
      expect(summary['ok']).toBe(code === 0);
    }
  });
});
