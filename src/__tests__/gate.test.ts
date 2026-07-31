/**
 * `checkride gate` — the stop-gate verdict.
 *
 * The spawn is injected throughout, so these test the *decision* (skip, green,
 * red, which artifact to name, which protocol to answer in) without a real
 * toolchain. What a real `<pm> run check` does is the orchestrator's business
 * and is covered where that lives; what matters here is that each harness gets
 * an answer it can act on.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkArgs, DIRTY_MARKER, type GateSpawn, runGate } from '../gate.js';
import type { Out } from '../orchestrator.js';

/** A collecting `Out`, so the two streams can be asserted apart. */
function capture(): Out & { text: () => string } {
  let text = '';
  return { write: (s: string) => ((text += s), true), text: () => text };
}

/** A spawn that never runs anything and reports `code`. */
const exits = (code: number | null): GateSpawn => () => Promise.resolve(code);

/** A spawn that writes to the stream it was handed, then reports red. */
const noisy: GateSpawn = (_command, _args, opts) => {
  opts.stderr.write('tsc: error TS2345\n');
  return Promise.resolve(1);
};

/** A spawn that fails the test if the pipeline is started at all. */
const never: GateSpawn = () => {
  throw new Error('the deferred gate must not run the pipeline');
};

describe('checkArgs', () => {
  test('runs the gate strictly and writes a digest', () => {
    expect(checkArgs('pnpm')).toEqual(['run', 'check', '--strict', '--digest']);
  });

  test('npm alone needs `--` to reach the script with flags', () => {
    expect(checkArgs('npm')).toEqual(['run', 'check', '--', '--strict', '--digest']);
  });
});

describe('runGate', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-gate-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const marker = (): string => join(dir, DIRTY_MARKER);
  async function touchMarker(): Promise<void> {
    await mkdir(join(dir, '.check'), { recursive: true });
    await writeFile(marker(), '');
  }

  test('--if-dirty skips entirely when no edit happened this turn', async () => {
    let ran = false;
    const result = await runGate({
      cwd: dir,
      ifDirty: true,
      spawn: () => {
        ran = true;
        return Promise.resolve(1);
      },
      stdout: capture(),
      stderr: capture(),
    });
    expect(result).toEqual({ exitCode: 0, ran: false, green: true });
    // A stop hook fires on every turn; a conversation must not run the pipeline.
    expect(ran).toBe(false);
  });

  test('--if-dirty runs once the marker is present', async () => {
    await touchMarker();
    const result = await runGate({ cwd: dir, ifDirty: true, spawn: exits(0), stdout: capture(), stderr: capture() });
    expect(result.ran).toBe(true);
  });

  test('without --if-dirty the gate always runs', async () => {
    const result = await runGate({ cwd: dir, spawn: exits(0), stdout: capture(), stderr: capture() });
    expect(result.ran).toBe(true);
  });

  test('a green gate clears the marker', async () => {
    await touchMarker();
    const result = await runGate({ cwd: dir, ifDirty: true, spawn: exits(0), stdout: capture(), stderr: capture() });
    expect(result).toEqual({ exitCode: 0, ran: true, green: true });
    expect(existsSync(marker())).toBe(false);
  });

  test('a red gate leaves the marker, so the next turn re-gates', async () => {
    await touchMarker();
    await runGate({ cwd: dir, ifDirty: true, spawn: exits(1), stdout: capture(), stderr: capture() });
    expect(existsSync(marker())).toBe(true);
  });

  test('claude: red blocks with exit 2 and the message on stderr', async () => {
    const stdout = capture();
    const stderr = capture();
    const result = await runGate({ cwd: dir, harness: 'claude', spawn: exits(1), stdout, stderr });
    // Exit 1 would not block — Claude Code treats only 2 as deny.
    expect(result.exitCode).toBe(2);
    expect(stderr.text()).toContain('the gate is red');
    expect(stdout.text()).toBe('');
  });

  test('cursor: red exits 0 and carries the verdict as JSON on stdout', async () => {
    const stdout = capture();
    const stderr = capture();
    const result = await runGate({ cwd: dir, harness: 'cursor', spawn: exits(1), stdout, stderr });
    // Cursor reads a non-zero stop hook as a *broken* hook and ends the turn
    // anyway, so the verdict cannot ride on the exit code.
    expect(result).toEqual({ exitCode: 0, ran: true, green: false });
    expect(stderr.text()).toBe('');
    const body = JSON.parse(stdout.text()) as { followup_message: string };
    expect(body.followup_message).toContain('the gate is red');
  });

  test('the default harness is claude', async () => {
    const result = await runGate({ cwd: dir, spawn: exits(1), stdout: capture(), stderr: capture() });
    expect(result.exitCode).toBe(2);
  });

  test('a harness-broken check (exit 2) is red too — not green', async () => {
    const result = await runGate({ cwd: dir, spawn: exits(2), stdout: capture(), stderr: capture() });
    expect(result.green).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  test('a check that could not spawn at all is red, not a crash', async () => {
    const result = await runGate({ cwd: dir, spawn: exits(null), stdout: capture(), stderr: capture() });
    expect(result.green).toBe(false);
  });

  test('points at the digest when the run wrote one, the summary otherwise', async () => {
    const bare = capture();
    await runGate({ cwd: dir, spawn: exits(1), stdout: capture(), stderr: bare });
    expect(bare.text()).toContain('.check/summary.json');

    await mkdir(join(dir, '.check'), { recursive: true });
    await writeFile(join(dir, '.check', 'digest.md'), '# failures');
    const withDigest = capture();
    await runGate({ cwd: dir, spawn: exits(1), stdout: capture(), stderr: withDigest });
    // The capped excerpt is a far better landing spot than raw summary.json.
    expect(withDigest.text()).toContain('.check/digest.md');
  });

  test('names a reader the agent can actually reach, spelled for the repo’s PM', async () => {
    const stderr = capture();
    await runGate({ cwd: dir, pm: 'npm', spawn: exits(1), stdout: capture(), stderr });
    expect(stderr.text()).toContain('npm exec checkride triage');
  });

  test('forwards the check’s own output to stderr, never stdout', async () => {
    const stdout = capture();
    const stderr = capture();
    await runGate({ cwd: dir, harness: 'cursor', spawn: noisy, stdout, stderr });
    expect(stderr.text()).toContain('TS2345');
    // Under --harness cursor stdout must parse as the hook's JSON and nothing else.
    expect(() => JSON.parse(stdout.text())).not.toThrow();
  });
});

/**
 * Cursor loads a repo's `.claude/settings.json` hooks alongside its own and runs
 * every matching source, so a repo wired for both harnesses would fire two full
 * pipelines into one `.check/` for a single turn. The Claude-protocol run is the
 * one that stands down — only when a Cursor gate is actually registered, so a
 * stale environment variable costs a duplicate run, never the gate.
 */
describe('runGate — deferring to a native Cursor gate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-gate-defer-'));
    await mkdir(join(dir, '.check'), { recursive: true });
    await writeFile(join(dir, DIRTY_MARKER), '');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const underCursor = { CURSOR_PROJECT_DIR: '/repo' };

  async function writeCursorHooks(command: string): Promise<void> {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    await writeFile(join(dir, '.cursor', 'hooks.json'), JSON.stringify({ hooks: { stop: [{ command }] } }));
  }

  test('stands down when Cursor is running the repo’s Claude hooks', async () => {
    await writeCursorHooks('sh .cursor/hooks/checkride-gate.sh');
    const result = await runGate({ cwd: dir, harness: 'claude', spawn: never, env: underCursor, stdout: capture(), stderr: capture() });
    expect(result).toEqual({ exitCode: 0, ran: false, green: true });
  });

  test('leaves the edit marker for the Cursor gate that will run', async () => {
    await writeCursorHooks('sh .cursor/hooks/checkride-gate.sh');
    await runGate({ cwd: dir, harness: 'claude', spawn: never, env: underCursor, stdout: capture(), stderr: capture() });
    expect(existsSync(join(dir, DIRTY_MARKER))).toBe(true);
  });

  test('does not stand down for the cursor protocol itself — that is the gate', async () => {
    await writeCursorHooks('sh .cursor/hooks/checkride-gate.sh');
    const result = await runGate({ cwd: dir, harness: 'cursor', spawn: exits(1), env: underCursor, stdout: capture(), stderr: capture() });
    expect(result.ran).toBe(true);
  });

  test('runs normally under Claude Code, however the repo is wired', async () => {
    await writeCursorHooks('sh .cursor/hooks/checkride-gate.sh');
    const result = await runGate({ cwd: dir, harness: 'claude', spawn: exits(1), env: {}, stdout: capture(), stderr: capture() });
    expect(result).toEqual({ exitCode: 2, ran: true, green: false });
  });

  test('runs when Cursor has hooks but no checkride gate among them', async () => {
    await writeCursorHooks('./notify.sh');
    const result = await runGate({ cwd: dir, harness: 'claude', spawn: exits(1), env: underCursor, stdout: capture(), stderr: capture() });
    expect(result.ran).toBe(true);
  });

  test('runs when there is no Cursor config at all', async () => {
    const result = await runGate({ cwd: dir, harness: 'claude', spawn: exits(1), env: underCursor, stdout: capture(), stderr: capture() });
    expect(result.ran).toBe(true);
  });
});
