/**
 * The triage reader's process surface.
 *
 * `spawnCapture` is the one place the reader touches the outside world, and its
 * whole job is to survive failure: a red gate, a missing binary, a runaway
 * tool, a hang. Those are precisely the paths a test that injects a fake
 * spawner can never reach, so these tests drive the real thing against real
 * short-lived processes — the same choice `../../__tests__/smoke.test.ts` makes
 * for its own spawner.
 *
 * The gate it runs is `<pm> run check`, so the process doing the work is a
 * *grandchild* of this spawn. That is what the group-kill tests below are
 * about: signalling only the direct child leaves the checks running and can
 * hold the promise open forever, since `close` waits on every inherited pipe.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { spawnCapture } from '../env.js';

/** A generous budget for the cases that are not about the timeout. */
const NO_TIMEOUT = { timeoutMs: 60_000 };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnCapture', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-triage-env-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('captures both streams and the exit code of a clean run', async () => {
    const outcome = await spawnCapture(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
      { cwd: dir, ...NO_TIMEOUT },
    );
    expect(outcome).toEqual({ code: 0, signal: null, stdout: 'out', stderr: 'err', error: null });
  });

  test('preserves a non-zero exit code rather than treating it as a failure to run', async () => {
    const outcome = await spawnCapture(process.execPath, ['-e', 'process.exit(3)'], { cwd: dir, ...NO_TIMEOUT });
    expect(outcome.code).toBe(3);
    expect(outcome.error).toBeNull();
  });

  /**
   * The reader must survive a repo with no package manager on PATH. A rejection
   * here would take down the report at exactly the moment it is needed, so the
   * spawn failure is a value.
   */
  test('a missing binary resolves with `error` set — it never rejects', async () => {
    const outcome = await spawnCapture('checkride-no-such-binary-xyz', [], { cwd: dir, ...NO_TIMEOUT });
    expect(outcome.error).not.toBeNull();
    expect(outcome.code).toBeNull();
  });

  test('runs in the given cwd', async () => {
    const outcome = await spawnCapture(
      process.execPath,
      ['-e', 'process.stdout.write(process.cwd())'],
      { cwd: dir, ...NO_TIMEOUT },
    );
    // macOS reports /private/var for /var; compare on the trailing segment.
    expect(outcome.stdout.endsWith(dir.slice(dir.lastIndexOf('/')))).toBe(true);
  });

  /**
   * A runaway tool must not be able to exhaust memory before the run ends. The
   * capture keeps the *tail*, because that is the end a reader excerpts.
   */
  test('caps each stream at the tail, dropping the head of a runaway writer', async () => {
    const outcome = await spawnCapture(
      process.execPath,
      // 300 chunks of 1 KiB (307_200 chars) against a 256 KiB cap, each chunk
      // ending in its index so the surviving tail is identifiable.
      ['-e', 'for (let i = 0; i < 300; i++) process.stdout.write("x".repeat(1023) + String.fromCharCode(65 + (i % 26)));'],
      { cwd: dir, ...NO_TIMEOUT },
    );
    expect(outcome.stdout.length).toBe(256 * 1024);
    // The last chunk written (i = 299 → 299 % 26 = 13 → 'N') is still there.
    expect(outcome.stdout.endsWith('N')).toBe(true);
  });

  test('a process that ignores SIGTERM is still killed when the budget expires', async () => {
    const started = Date.now();
    const outcome = await spawnCapture(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { cwd: dir, timeoutMs: 200 },
    );
    // Died by signal, so no exit code — the gate reads this as off-contract.
    expect(outcome.code).toBeNull();
    expect(outcome.signal).toBe('SIGKILL');
    // It took the SIGTERM grace to get there, but it did get there.
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 20_000);

  /**
   * The regression this module existed to have: the gate is `<pm> run check`,
   * so a per-child SIGTERM hits the package-manager wrapper and leaves the real
   * checks running as orphans. The detached spawn + process-group kill must
   * take the whole tree down.
   */
  test('the timeout reaps a grandchild, not just the direct child', async () => {
    const pidFile = join(dir, 'gc.pid');
    await writeFile(
      join(dir, 'gc.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      join(dir, 'wrap.js'),
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'gc.js'))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
    );

    const outcome = await spawnCapture(process.execPath, [join(dir, 'wrap.js')], { cwd: dir, timeoutMs: 1000 });
    expect(outcome.code).toBeNull();

    const gcPid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200)); // let the group signal reach the grandchild
    const alive = isAlive(gcPid);
    if (alive) process.kill(gcPid, 'SIGKILL'); // safety net: never leak the orphan if this regresses
    expect(alive).toBe(false);
  }, 20_000);

  test('a run that finishes inside the budget is unaffected by it', async () => {
    const outcome = await spawnCapture(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir, timeoutMs: 30_000 });
    expect(outcome).toMatchObject({ code: 0, signal: null, error: null });
  });
});
