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
import type { PinEnv } from '../node-pin.js';
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

/** A spawn that prints `text` the way a refusing package manager would, then reports red. */
const printing =
  (text: string): GateSpawn =>
  (_command, _args, opts) => {
    opts.stderr.write(text);
    return Promise.resolve(1);
  };

/** What pnpm prints when the repo's `engines.node` excludes the Node it is running on. */
const PNPM_ENGINE_REFUSAL = [
  '[ERR_PNPM_UNSUPPORTED_ENGINE] Unsupported environment (bad pnpm and/or Node.js version)',
  '',
  'Expected version: >=22 <23',
  'Got: v24.9.0',
  '',
].join('\n');

/** A {@link PinEnv} that finds nothing, so alignment is a no-op unless a test says otherwise. */
function pinEnv(over: Partial<PinEnv> = {}): PinEnv {
  return {
    exists: () => false,
    read: () => null,
    list: () => [],
    home: () => '/home/dev',
    running: () => '24.9.0',
    variable: () => undefined,
    ...over,
  };
}

/** The PATH the child was handed, captured from the spawn. */
function capturingSpawn(): { spawn: GateSpawn; path: () => string | undefined } {
  let seen: string | undefined;
  return {
    spawn: (_command, _args, opts) => {
      seen = opts.env['PATH'];
      return Promise.resolve(0);
    },
    path: () => seen,
  };
}

/** A repo pinning `version`, with an nvm install of it present when `installed`. */
function pinnedRepo(version: string, opts: { installed: boolean }): PinEnv {
  const root = join('/home/dev', '.nvm', 'versions', 'node');
  return pinEnv({
    read: (path) => (path.endsWith('.nvmrc') ? `${version}\n` : null),
    list: (dir) => (opts.installed && dir === root ? [`v${version}`] : []),
    exists: (path) => opts.installed && path.startsWith(join(root, `v${version}`)),
  });
}

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
    expect(result).toEqual({ exitCode: 0, ran: false, green: true, refusal: null });
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
    expect(result).toEqual({ exitCode: 0, ran: true, green: true, refusal: null });
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
    expect(result).toEqual({ exitCode: 0, ran: true, green: false, refusal: null });
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
 * A package manager refusing to *start* the check script exits non-zero exactly
 * as a failing test does, and pnpm does it for an `engines.node` pin the running
 * Node does not satisfy — which is the norm under an agent harness, since hooks
 * run in a non-login shell and get the machine's default Node. Read as a red,
 * that is a verdict no code change can clear, pointing the reader at a summary
 * no run wrote.
 */
describe('runGate — the package manager refused to start the check', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-gate-refusal-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('reports "could not run" rather than red, and names the cause', async () => {
    const stdout = capture();
    const result = await runGate({
      cwd: dir,
      spawn: printing(PNPM_ENGINE_REFUSAL),
      stdout,
      stderr: capture(),
      pinEnv: pinEnv(),
      now: fakeClock(265),
    });
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };
    expect(systemMessage).toContain('checkride ⚠ could not run in 265ms');
    expect(systemMessage).toContain('engines');
    expect(systemMessage).not.toContain('red');
    expect(result.refusal).not.toBeNull();
  });

  /**
   * The failure this replaces: a reader sent to an artifact that describes some
   * earlier turn, because this one wrote none.
   */
  test('does not send the reader to an artifact this run never wrote', async () => {
    const stderr = capture();
    await runGate({ cwd: dir, spawn: printing(PNPM_ENGINE_REFUSAL), stdout: capture(), stderr, pinEnv: pinEnv() });
    expect(stderr.text()).not.toContain('.check/summary.json');
    expect(stderr.text()).toContain('Nothing ran');
    expect(stderr.text()).toContain('non-login shell');
  });

  test('still blocks — an unrunnable gate is never a pass', async () => {
    const claude = await runGate({ cwd: dir, spawn: printing(PNPM_ENGINE_REFUSAL), stdout: capture(), stderr: capture(), pinEnv: pinEnv() });
    expect(claude).toMatchObject({ exitCode: 2, ran: true, green: false });

    const stdout = capture();
    const cursor = await runGate({ cwd: dir, harness: 'cursor', spawn: printing(PNPM_ENGINE_REFUSAL), stdout, stderr: capture(), pinEnv: pinEnv() });
    // Cursor reads any non-zero stop hook as a broken hook, so the block rides
    // in the body — the same split a red uses.
    expect(cursor.exitCode).toBe(0);
    expect((JSON.parse(stdout.text()) as { followup_message: string }).followup_message).toContain('could not run');
  });

  /**
   * The guard that makes the whole classification safe. checkride's own test
   * suite prints these markers; any repo's could. A summary written by *this*
   * run proves the pipeline started, so on that branch the output cannot mean it
   * did not — a false "could not run" would blame the environment for broken
   * code, which is worse than the bug being fixed.
   */
  test('a run that wrote a summary is red however its output reads', async () => {
    // The pipeline runs and fails, and one of its checks happens to print the
    // marker — checkride's own suite does exactly this.
    const ranAndFailed: GateSpawn = async (_command, _args, opts) => {
      opts.stderr.write(`a test asserted on ${PNPM_ENGINE_REFUSAL}`);
      await mkdir(join(dir, '.check'), { recursive: true });
      await writeFile(
        join(dir, '.check', 'summary.json'),
        JSON.stringify({
          schema_version: 1,
          timestamp: new Date(0).toISOString(),
          ok: false,
          checks_run: 1,
          total_duration_ms: 10,
          checks: [{ adapter: 'test', name: 'test', description: 'test', ok: false, exit_code: 1, duration_ms: 10, output_file: null }],
        }),
      );
      return 1;
    };
    const stdout = capture();
    const result = await runGate({ cwd: dir, spawn: ranAndFailed, stdout, stderr: capture(), pinEnv: pinEnv() });
    expect(result.refusal).toBeNull();
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };
    expect(systemMessage).toContain('✘ red');
    expect(systemMessage).toContain('1 of 1 failed: test');
  });

  test('a package manager that is not on PATH is a refusal, not an unexplained red', async () => {
    const stderr = capture();
    const result = await runGate({
      cwd: dir,
      spawn: printing('checkride: could not start `pnpm`: spawn pnpm ENOENT\n'),
      stdout: capture(),
      stderr,
      pinEnv: pinEnv(),
    });
    expect(result.refusal).toContain('PATH');
    expect(stderr.text()).toContain('could not run');
  });

  /** With a pin to name, the message says which Node the repo wanted and which one ran. */
  test('names the repo’s pin and the Node the hook actually got', async () => {
    const stderr = capture();
    await runGate({
      cwd: dir,
      spawn: printing(PNPM_ENGINE_REFUSAL),
      stdout: capture(),
      stderr,
      pinEnv: pinnedRepo('22.22.3', { installed: false }),
    });
    expect(stderr.text()).toContain('the repo pins 22.22.3 (.nvmrc)');
    expect(stderr.text()).toContain('Node 24.9.0');
    expect(stderr.text()).toContain('CHECKRIDE_NODE_BIN');
  });
});

/**
 * Aligning the child to the repo's Node pin — the half that stops the refusal
 * from happening at all. Narrow by construction: only an explicit `.nvmrc` /
 * `.node-version`, only when the running Node does not satisfy it, only an
 * interpreter already installed, and never without saying so.
 */
describe('runGate — aligning to the repo’s Node pin', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-gate-pin-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('puts the pinned interpreter in front of the child’s PATH', async () => {
    const { spawn, path } = capturingSpawn();
    await runGate({
      cwd: dir,
      spawn,
      stdout: capture(),
      stderr: capture(),
      env: { PATH: '/usr/bin' },
      pinEnv: pinnedRepo('22.22.3', { installed: true }),
    });
    expect(path()).toBe(`${join('/home/dev', '.nvm', 'versions', 'node', 'v22.22.3', 'bin')}:/usr/bin`);
  });

  test('says so — which Node a pipeline ran on is never changed silently', async () => {
    const stderr = capture();
    await runGate({
      cwd: dir,
      spawn: exits(0),
      stdout: capture(),
      stderr,
      env: { PATH: '/usr/bin' },
      pinEnv: pinnedRepo('22.22.3', { installed: true }),
    });
    expect(stderr.text()).toContain('running the check on Node 22.22.3');
    expect(stderr.text()).toContain('.nvmrc pins 22.22.3');
    expect(stderr.text()).toContain('this hook started on 24.9.0');
  });

  test('leaves a healthy environment alone', async () => {
    const { spawn, path } = capturingSpawn();
    const stderr = capture();
    await runGate({
      cwd: dir,
      spawn,
      stdout: capture(),
      stderr,
      env: { PATH: '/usr/bin' },
      // The running Node already satisfies the pin: nothing to do.
      pinEnv: pinnedRepo('24.9.0', { installed: true }),
    });
    expect(path()).toBe('/usr/bin');
    expect(stderr.text()).not.toContain('running the check on Node');
  });

  test('CHECKRIDE_NODE_BIN=off declines to align at all', async () => {
    const { spawn, path } = capturingSpawn();
    const pinned = pinnedRepo('22.22.3', { installed: true });
    await runGate({
      cwd: dir,
      spawn,
      stdout: capture(),
      stderr: capture(),
      env: { PATH: '/usr/bin' },
      pinEnv: { ...pinned, variable: () => 'off' },
    });
    expect(path()).toBe('/usr/bin');
  });

  test('CHECKRIDE_NODE_BIN=<dir> is used verbatim, whatever the layouts hold', async () => {
    const { spawn, path } = capturingSpawn();
    await runGate({
      cwd: dir,
      spawn,
      stdout: capture(),
      stderr: capture(),
      env: { PATH: '/usr/bin' },
      pinEnv: { ...pinEnv(), variable: () => '/opt/node22/bin' },
    });
    expect(path()).toBe('/opt/node22/bin:/usr/bin');
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
    expect(result).toEqual({ exitCode: 0, ran: false, green: true, refusal: null });
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
    expect(result).toEqual({ exitCode: 2, ran: true, green: false, refusal: null });
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
