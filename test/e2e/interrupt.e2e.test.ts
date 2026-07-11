import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** True while `pid` names a live process (signal 0 probes without delivering). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

/**
 * The forwarding half of interrupt safety (step 19): checks run in their own
 * detached process groups (so the timeout kill can reap grandchildren), which
 * also means a terminal's Ctrl-C never reaches them. The CLI must forward the
 * fatal signal — group-killing every in-flight check tree — and then die by the
 * signal's default disposition (re-raise, not `process.exit`), so the shell
 * sees the conventional signal death and the 0/1/2 exit contract stays
 * signal-free. Without forwarding, the CLI dies instantly and the check's
 * whole tree survives as orphans — the grandchild assertion below.
 */
describe('signal forwarding (SIGINT/SIGTERM)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-sig-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`${signal} mid-run reaps the check's grandchild; the CLI re-raises promptly`, async () => {
      // The check is a wrapper that spawns a long-lived grandchild (the step-9
      // pattern): the grandchild records its pid, both hang until killed.
      const pidFile = join(dir, 'gc.pid');
      await writeFile(
        join(dir, 'gc.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      await writeFile(
        join(dir, 'wrap.js'),
        `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'gc.js'))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
      );
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'victim' }));
      await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
        checks: { links: false, slow: { command: 'node', args: [join(dir, 'wrap.js')] } },
      }));

      const proc = spawn('node', [CLI], { cwd: dir, stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; sig: string | null }>((resolve) => {
        proc.on('close', (code, sig) => { resolve({ code, sig }); });
      });

      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(pidFile)).toBe(true);
      const gcPid = Number(await readFile(pidFile, 'utf8'));

      proc.kill(signal);
      // Prompt: cooperative children die on the forwarded SIGTERM well inside
      // the grace window; a CLI that hung on cleanup would ride the check's
      // 60s hang into this deadline instead.
      const outcome = await Promise.race([
        exited,
        new Promise<'hung'>((resolve) => setTimeout(() => { resolve('hung'); }, 20_000)),
      ]);
      expect(outcome).not.toBe('hung');
      const { code, sig } = outcome as { code: number | null; sig: string | null };
      // Death by the re-raised signal's default disposition, not process.exit:
      // the parent sees the signal, and a shell would report 128+n (130/143).
      expect(sig).toBe(signal);
      expect(code).toBe(null);

      await new Promise((r) => setTimeout(r, 300)); // let the group signal propagate to the grandchild
      const alive = isAlive(gcPid);
      if (alive) process.kill(gcPid, 'SIGKILL'); // safety net: never leak the orphan if this regresses
      expect(alive).toBe(false);
    });
  }
});
