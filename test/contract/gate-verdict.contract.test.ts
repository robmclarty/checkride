/**
 * Contract: what the gate's three verdicts mean (docs/contract.md §CLI).
 *
 * `gate` sits outside the 0/1/2 split because it answers a harness's hook
 * protocol, and the exit codes there are already pinned by
 * `./exit-codes.contract.test.ts` and `./flags.contract.test.ts`. What this file
 * locks is the *distinction the body carries*, which is what an agent acts on:
 *
 *   green            — checks ran, all passed.
 *   red              — checks ran, some failed; `.check/` describes this run.
 *   could not run    — the package manager refused to start the script. NOTHING
 *                      ran, no artifact was written, and no code change clears it.
 *                      Blocks when the repo can fix it (a missing `check`
 *                      script); stands down, loudly, when only the environment
 *                      can (an `engines` pin the hook's Node fails).
 *
 * The third exists because a launch refusal is invisible in the status code —
 * pnpm answers an `engines.node` mismatch with exit 1, exactly as a failing test
 * does. Reported as red, that produced a permanent red pointing at a
 * `summary.json` no run had written, in every repo whose contributors' default
 * Node differs from the pin. Since agent harnesses run hooks in a non-login
 * shell, that is the common case rather than the rare one.
 *
 * A change that breaks one of these tests is a breaking change: it needs a
 * "Contract" entry in CHANGELOG.md, not a quiet edit here.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CLAUDE_SETTINGS_FILE, runHooks } from '../../src/agent-setup/index.js';
import type { GateSpawn } from '../../src/gate.js';
import { DIRTY_MARKER, runGate } from '../../src/gate.js';
import type { PinEnv } from '../../src/node-pin.js';

function capture(): { write: (text: string) => boolean; text: () => string } {
  let text = '';
  return { write: (s: string) => ((text += s), true), text: () => text };
}

/** A spawn that prints what a refusing pnpm prints, and exits as pnpm does: 1. */
const refusing: GateSpawn = (_command, _args, opts) => {
  opts.stderr.write('[ERR_PNPM_UNSUPPORTED_ENGINE] Unsupported environment\nExpected version: >=22 <23\nGot: v24.9.0\n');
  return Promise.resolve(1);
};

/** A spawn that fails a check the ordinary way. */
const failing: GateSpawn = (_command, _args, opts) => {
  opts.stderr.write('src/a.ts(3,1): error TS2345\n');
  return Promise.resolve(1);
};

/** A refusal the repo itself can clear, which is the half that still blocks. */
const noScript: GateSpawn = (_command, _args, opts) => {
  opts.stderr.write('ERR_PNPM_NO_SCRIPT  Missing script: check\n');
  return Promise.resolve(1);
};

/** A pin surface that finds nothing, so no alignment happens. */
function bare(over: Partial<PinEnv> = {}): PinEnv {
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

describe('gate verdicts', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-gate-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('a launch refusal is not a red, and does not name an artifact', async () => {
    const stdout = capture();
    const result = await runGate({ cwd: dir, spawn: refusing, stdout, stderr: capture(), pinEnv: bare() });
    const { systemMessage } = JSON.parse(stdout.text()) as { systemMessage: string };

    expect(result.refusal).not.toBeNull();
    expect(systemMessage).toContain('could not run');
    // The failure this replaces: sending a reader to a file this run never wrote.
    expect(systemMessage).not.toContain('.check/summary.json');
    expect(systemMessage).toContain('Nothing ran');
  });

  test('an ordinary failure is still a red, and still names the artifact', async () => {
    const stdout = capture();
    const result = await runGate({ cwd: dir, spawn: failing, stdout, stderr: capture(), pinEnv: bare() });
    const { systemMessage, reason } = JSON.parse(stdout.text()) as { systemMessage: string; reason: string };

    expect(result.refusal).toBeNull();
    expect(systemMessage).toContain('✘ red');
    expect(reason).toContain('.check/summary.json');
  });

  /**
   * The load-bearing half, and the one that changed in 0.11.0.
   *
   * Could-not-run used to block unconditionally, on the reasoning that a gate
   * which stops gating is the vacuous green this contract exists to prevent.
   * That reasoning holds only while blocking can *lead to* a fix. When the cause
   * is a Node the harness never put on `PATH`, it cannot: the harness re-prompts
   * the same agent, which has no lever to pull, and the loop ends with a
   * contributor removing the gate. So the split is now by who can clear it —
   * `repo` blocks, `environment` stands down loudly — and the promise is that
   * neither one is ever silent or ever reported as a pass.
   */
  test('a refusal the repo can fix blocks, in both harnesses', async () => {
    const claude = await runGate({ cwd: dir, spawn: noScript, stdout: capture(), stderr: capture(), pinEnv: bare() });
    expect(claude.exitCode).toBe(2);
    expect(claude.green).toBe(false);

    const stdout = capture();
    const cursor = await runGate({ cwd: dir, harness: 'cursor', spawn: noScript, stdout, stderr: capture(), pinEnv: bare() });
    // Cursor reads any non-zero stop hook as a *broken* hook and ends the turn,
    // so the block has to ride in the body — the same split a red uses.
    expect(cursor.exitCode).toBe(0);
    expect((JSON.parse(stdout.text()) as { followup_message: string }).followup_message).toContain('could not run');
  });

  /**
   * The counterpart promise: standing down is not passing. A caller reading
   * `green` gets `false`, and both harnesses are told in the one channel that
   * reaches a human. Cursor's is stderr, because its only stop-hook output field
   * submits a new turn — using it here would rebuild the loop by hand.
   */
  test('a refusal only the environment can fix stands down, and says so', async () => {
    const stdout = capture();
    const stderr = capture();
    const claude = await runGate({ cwd: dir, spawn: refusing, stdout, stderr, pinEnv: bare() });
    expect(claude.exitCode).toBe(0);
    expect(claude.green).toBe(false);

    const body = JSON.parse(stdout.text()) as { systemMessage: string; decision?: string };
    expect(body.decision).toBeUndefined();
    expect(body.systemMessage).toContain('could not run');
    expect(body.systemMessage).toContain('Nothing was verified');

    const cursorOut = capture();
    const cursorErr = capture();
    const cursor = await runGate({
      cwd: dir, harness: 'cursor', spawn: refusing, stdout: cursorOut, stderr: cursorErr, pinEnv: bare(),
    });
    expect(cursor.exitCode).toBe(0);
    expect(cursor.green).toBe(false);
    expect(cursorOut.text()).toBe('');
    expect(cursorErr.text()).toContain('could not run');
  });

  /** Only a green run clears the marker, so a refused turn is re-gated on the next one. */
  test('a gate that could not run leaves the edit marker standing', async () => {
    await mkdir(join(dir, '.check'), { recursive: true });
    await writeFile(join(dir, DIRTY_MARKER), '');
    await runGate({ cwd: dir, ifDirty: true, spawn: refusing, stdout: capture(), stderr: capture(), pinEnv: bare() });
    expect(existsSync(join(dir, DIRTY_MARKER))).toBe(true);
  });
});

/** The PATH the check run was handed, captured from the spawn. */
function pathSeen(): { spawn: GateSpawn; value: () => string | undefined } {
  let seen: string | undefined;
  return {
    spawn: (_c, _a, opts) => { seen = opts.env['PATH']; return Promise.resolve(0); },
    value: () => seen,
  };
}

/**
 * `CHECKRIDE_NODE_BIN` — the promised wrapping point for hook authors, and the
 * opt-out. checkride's own layout search covers nvm, fnm, nodenv, asdf, volta
 * and n; this variable is what covers everything else, in both directions.
 */
describe('CHECKRIDE_NODE_BIN', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-gate-bin-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('a directory is prepended to the check run’s PATH', async () => {
    const { spawn, value } = pathSeen();
    await runGate({
      cwd: dir, spawn, stdout: capture(), stderr: capture(), env: { PATH: '/usr/bin' },
      pinEnv: bare({ variable: () => '/opt/node22/bin' }),
    });
    expect(value()).toBe('/opt/node22/bin:/usr/bin');
  });

  test('`off` leaves PATH exactly as it was', async () => {
    const { spawn, value } = pathSeen();
    await runGate({
      cwd: dir, spawn, stdout: capture(), stderr: capture(), env: { PATH: '/usr/bin' },
      // A repo that pins a Node this process does not satisfy, and an install
      // that would otherwise be used: `off` still declines.
      pinEnv: bare({
        variable: () => 'off',
        read: (p) => (p.endsWith('.nvmrc') ? '22.22.3' : null),
        list: () => ['v22.22.3'],
        exists: () => true,
      }),
    });
    expect(value()).toBe('/usr/bin');
  });

  test('an aligned run says so — the interpreter is never swapped silently', async () => {
    const stderr = capture();
    await runGate({
      cwd: dir, spawn: () => Promise.resolve(0), stdout: capture(), stderr, env: { PATH: '/usr/bin' },
      pinEnv: bare({ variable: () => '/opt/node22/bin' }),
    });
    expect(stderr.text()).toContain('/opt/node22/bin');
  });
});

/**
 * Contract: `protect` is enforcement wherever it lives (docs/contract.md §CLI).
 *
 * The three hook names are promised; the *mechanism* is checkride's to choose
 * per harness. Under Claude Code it is a `permissions.deny` rule rather than a
 * generated script, which is a better guarantee — Claude Code evaluates deny
 * rules regardless of what a PreToolUse hook returns — but only if the rules are
 * spelled the one way that is actually consulted.
 */
describe('protect as configuration', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-protect-contract-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const settings = async (): Promise<{ permissions?: { deny?: string[] } }> =>
    JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8'));

  /**
   * Claude Code checks file paths against `Edit` and `Read` rules only. A
   * `Write(...)` or `NotebookEdit(...)` path rule is accepted, never consulted,
   * and warns at startup — it would look like protection and be none. `Read` is
   * absent for the opposite reason: triage reads `.check/` artifacts.
   */
  test('every rule is an Edit rule, which is the only kind consulted for a path', async () => {
    await runHooks({ cwd: dir, action: 'add', hooks: ['protect'], harnesses: ['claude'] });
    const deny = (await settings()).permissions?.deny ?? [];
    expect(deny.length).toBeGreaterThan(0);
    for (const rule of deny) expect(rule.startsWith('Edit(')).toBe(true);
    expect(deny.some((r) => r.includes('checkride.baseline.json'))).toBe(true);
    expect(deny.some((r) => r.includes('.check'))).toBe(true);
  });

  /** The promise a consumer builds on: the list is shared, not owned. */
  test('checkride appends to the deny list and removes only its own rules', async () => {
    const mine = 'Edit(**/fallow.baseline.json)';
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, CLAUDE_SETTINGS_FILE), JSON.stringify({ permissions: { deny: [mine] } }));

    await runHooks({ cwd: dir, action: 'add', hooks: ['protect'], harnesses: ['claude'] });
    expect((await settings()).permissions?.deny).toContain(mine);

    await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'], harnesses: ['claude'] });
    expect((await settings()).permissions?.deny).toEqual([mine]);
  });
});

/** The user-visible line out of a Claude-protocol hook body. */
function message(out: { text: () => string }): string {
  return (JSON.parse(out.text()) as { systemMessage: string }).systemMessage;
}

/**
 * Contract: a narrowed gate discloses it (docs/contract.md §CLI).
 *
 * A profile trades coverage for speed, which is a legitimate trade only while
 * the reader knows they made it. A green that quietly covered three of eighteen
 * slots is the vacuous pass this contract exists to prevent, arrived at from the
 * comfortable direction — so the clause is part of the feature, not a nicety.
 */
describe('gate profile disclosure', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-profile-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test.each([
    ['green', 0],
    ['red', 1],
  ])('a %s verdict under a profile states it was not the full check', async (_name, code) => {
    const stdout = capture();
    await runGate({
      cwd: dir,
      spawn: () => Promise.resolve(code),
      stdout,
      stderr: capture(),
      pinEnv: bare(),
      profile: { only: ['types'] },
    });
    expect(message(stdout)).toContain('gate profile');
    expect(message(stdout)).toContain('NOT the full check');
  });

  /** The inverse matters as much: the warning must not appear on a complete run. */
  test('a verdict with no profile claims nothing about narrowing', async () => {
    const stdout = capture();
    await runGate({ cwd: dir, spawn: () => Promise.resolve(0), stdout, stderr: capture(), pinEnv: bare() });
    expect(message(stdout)).not.toContain('profile');
  });
});
