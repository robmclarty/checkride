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

/** A clock that advances by exactly `elapsedMs` across the run, so the report is assertable. */
function fakeClock(elapsedMs: number): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : elapsedMs);
}

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

  /** Write the `.check/summary.json` a run would have left, from the fields a report reads. */
  async function writeSummary(input: {
    ok: boolean;
    checks: { name: string; ok: boolean; duration_ms: number; skipped?: boolean }[];
  }): Promise<void> {
    await mkdir(join(dir, '.check'), { recursive: true });
    const summary = {
      schema_version: 1,
      timestamp: new Date(0).toISOString(),
      ok: input.ok,
      checks_run: input.checks.filter((c) => c.skipped !== true).length,
      total_duration_ms: input.checks.reduce((n, c) => n + c.duration_ms, 0),
      checks: input.checks.map((c) => ({
        adapter: c.name,
        description: c.name,
        exit_code: c.ok ? 0 : 1,
        output_file: null,
        ...c,
      })),
    };
    await writeFile(join(dir, '.check', 'summary.json'), JSON.stringify(summary));
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
  });

  /**
   * Claude Code parses a hook body only on exit 0, and only a body can carry a
   * `systemMessage` for the user alongside the block. checkride emits both
   * spellings so a hook script generated before the body existed — which blocks
   * on the exit code and ignores stdout — keeps gating across the upgrade.
   */
  test('claude: red also writes a blocking hook body on stdout', async () => {
    const stdout = capture();
    const result = await runGate({ cwd: dir, harness: 'claude', spawn: exits(1), stdout, stderr: capture() });
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(stdout.text()) as { decision: string; reason: string; systemMessage: string };
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('the gate is red');
    expect(body.systemMessage).toContain('checkride ✘ red');
  });

  test('claude: green says so, so a silent minute is not mistaken for a hang', async () => {
    const stdout = capture();
    const result = await runGate({
      cwd: dir,
      harness: 'claude',
      spawn: exits(0),
      stdout,
      stderr: capture(),
      now: fakeClock(4200),
    });
    expect(result.green).toBe(true);
    const body = JSON.parse(stdout.text()) as { systemMessage: string; decision?: string };
    expect(body.systemMessage).toBe('checkride ✔ green in 4.2s');
    // Nothing to block on: a green gate must not carry a decision.
    expect(body.decision).toBeUndefined();
  });

  /**
   * Cursor's stop hook takes one field, and that field *submits a new turn*.
   * Announcing a pass through it would put the agent back to work every time it
   * succeeded, so a green Cursor gate stays silent. See docs/cursor.md.
   */
  test('cursor: green writes nothing, because its only field starts a turn', async () => {
    const stdout = capture();
    await runGate({ cwd: dir, harness: 'cursor', spawn: exits(0), stdout, stderr: capture() });
    expect(stdout.text()).toBe('');
  });

  test('the report names the failing slots and the wall clock the user waited', async () => {
    await writeSummary({
      ok: false,
      checks: [
        { name: 'types', ok: true, duration_ms: 900 },
        { name: 'lint', ok: false, duration_ms: 300 },
        { name: 'test', ok: false, duration_ms: 8000 },
        { name: 'spell', ok: true, skipped: true, duration_ms: 0 },
      ],
    });
    const stdout = capture();
    await runGate({ cwd: dir, spawn: exits(1), stdout, stderr: capture(), now: fakeClock(61_000) });
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };
    // Skipped checks are not part of "3 checks" — nothing ran for them.
    expect(systemMessage).toBe('checkride ✘ red in 1.0m — 2 of 3 failed: lint, test');
  });

  test('a green report names the slowest check, the one worth knowing about', async () => {
    await writeSummary({
      ok: true,
      checks: [
        { name: 'lint', ok: true, duration_ms: 300 },
        { name: 'test', ok: true, duration_ms: 21_400 },
      ],
    });
    const stdout = capture();
    await runGate({ cwd: dir, spawn: exits(0), stdout, stderr: capture(), now: fakeClock(30_000) });
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };
    expect(systemMessage).toBe('checkride ✔ green in 30.0s — 2 checks, slowest test 21.4s');
  });

  /**
   * A gate that could not run wrote no summary, and a report that invents "0
   * checks failed" from a missing file is the vacuous green the artifact exists
   * to disprove. The elapsed time is still true, so it is still reported.
   */
  test('no readable summary reports the time and claims nothing else', async () => {
    const stdout = capture();
    await runGate({ cwd: dir, spawn: exits(1), stdout, stderr: capture(), now: fakeClock(1500) });
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };
    expect(systemMessage).toBe('checkride ✘ red in 1.5s');
  });

  /**
   * A check script shaped `tsc --build && checkride` leaves the summary
   * untouched when the build fails. Reading it anyway would report the previous
   * run's failing slots as this run's — confidently, and wrongly.
   */
  test('a summary older than this run is not this run’s, and is not reported', async () => {
    await writeSummary({ ok: false, checks: [{ name: 'lint', ok: false, duration_ms: 10 }] });
    const stdout = capture();
    // A start time after the summary was written: nothing on disk can belong to it.
    const after = Date.now() + 60_000;
    await runGate({ cwd: dir, spawn: exits(1), stdout, stderr: capture(), now: () => after });
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };
    expect(systemMessage).not.toContain('lint');
    expect(systemMessage).toBe('checkride ✘ red in 0ms');
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
