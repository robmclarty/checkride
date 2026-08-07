/**
 * Contract: stream discipline (docs/contract.md §CLI).
 *
 * stdout carries machine output only: the summary JSON under `--json`,
 * otherwise nothing at all. Human-readable progress, warnings, and status go
 * to stderr. `checkride --json | jq .` must always be safe — green or red.
 */

import { execFileSync } from 'node:child_process';
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
    // Sequential by necessity: each iteration rewrites the shared config and runs
    // the CLI against the same cwd, so the runs must not race on config/.check.
    for (const code of [0, 1]) {
      // oxlint-disable-next-line no-await-in-loop -- see above: shared cwd/config, runs must stay ordered.
      await configWithExit(code);
      const stdout = capture();
      // oxlint-disable-next-line no-await-in-loop -- see above: shared cwd/config, runs must stay ordered.
      await runCli(['--json'], { cwd: dir, stdout, stderr: capture() });
      // Parsing the whole captured stream proves nothing else leaked onto it.
      const summary = JSON.parse(stdout.text()) as Record<string, unknown>;
      expect(summary['ok']).toBe(code === 0);
    }
  });
});

/** Is a real git usable here? The recover stream test skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Contract: `recover`'s list mode is a reader (docs/contract.md §CLI) — the
 * Markdown report is the machine output on stdout, exit 0, and nothing rides
 * along on it; human prose belongs to apply confirmations on stderr.
 */
describe.skipIf(!gitAvailable)('stream discipline: recover list mode', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-streams-recover-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('the listing is the only stdout content, exit 0', async () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir, stdio: 'pipe' });
    };
    git('init', '-q');
    await writeFile(join(dir, 'checkride.baseline.json'), '{"schema_version":1,"slots":{"lint":["a","b"]}}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'baseline');
    await writeFile(join(dir, 'checkride.baseline.json'), '{"schema_version":1,"slots":{"lint":["a"]}}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'entries dropped');

    const stdout = capture();
    const stderr = capture();
    expect(await runCli(['recover'], { cwd: dir, stdout, stderr })).toBe(0);
    expect(stdout.text()).toMatch(/^# checkride recover/);
    expect(stdout.text()).toContain('| 1 |');
    expect(stderr.text()).toBe('');
  });
});
