import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/**
 * The physical half of interrupt safety (the logical half — never ratchet the
 * baseline on a partial run — is covered in the orchestrator unit tests): a run
 * killed mid-flight must leave `.check/` either previous-run-consistent or
 * absent, never torn, and the committed baseline byte-identical. Gate consumers
 * (plumbbob's checkpoint, CI) parse `summary.json` on the next run; a
 * half-written file would turn our crash into their correctness bug.
 */
/** Config with one custom check; `links` disabled so it is the only check. */
function config(slowArgs: string): string {
  return JSON.stringify({
    checks: {
      links: false,
      slow: { command: 'node', args: ['-e', slowArgs] },
    },
  });
}

describe('interrupted run', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-kill-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Start the CLI, wait for the marker the slow check writes, SIGKILL it. */
  async function runAndKill(): Promise<void> {
    const marker = join(dir, '.started');
    const proc = spawn('node', [CLI], { cwd: dir, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => { proc.on('close', () => { resolve(); }); });
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(marker)).toBe(true);
    proc.kill('SIGKILL');
    await exited;
  }

  const SLOW = 'require("fs").writeFileSync(".started","1");setTimeout(()=>{},60000)';

  test('kill mid-run: summary.json stays previous-run-consistent, baseline untouched', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'victim' }));
    const baseline = `${JSON.stringify({ schema_version: 1, slots: { lint: ['a.ts:no-x:bad'] } }, null, 2)}\n`;
    await writeFile(join(dir, 'checkride.baseline.json'), baseline);

    // Run 1: the custom check exits 0 — a complete green run.
    await writeFile(join(dir, 'checkride.config.json'), config('process.exit(0)'));
    const first = spawn('node', [CLI], { cwd: dir, stdio: 'ignore' });
    await new Promise<void>((resolve) => { first.on('close', () => { resolve(); }); });
    const summaryPath = join(dir, '.check', 'summary.json');
    const before = await readFile(summaryPath, 'utf8');
    expect((JSON.parse(before) as { ok: boolean }).ok).toBe(true);

    // Run 2: the check hangs; kill the CLI while it is mid-run.
    await writeFile(join(dir, 'checkride.config.json'), config(SLOW));
    await runAndKill();

    // Previous-run-consistent: the summary is byte-identical to run 1, the
    // baseline byte-identical to what was committed. Nothing half-written.
    expect(await readFile(summaryPath, 'utf8')).toBe(before);
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(baseline);
  });

  test('kill on a first run: summary.json is absent, not torn', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'victim' }));
    await writeFile(join(dir, 'checkride.config.json'), config(SLOW));
    await runAndKill();
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(false);
  });
});
