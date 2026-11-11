/**
 * Contract: `checkride protect` (docs/contract.md §CLI).
 *
 * `protect` is the edit guard as a command, for a harness whose guard is a hook
 * and a repo with no Node to run a generated script on. Like `gate`, it sits
 * outside the 0/1/2 split because it answers a harness's hook protocol. What
 * this file locks is what a hook runner sees:
 *
 *   denied    — a write to the baseline, a named suite's baseline, or `.check/`:
 *               one `{"permission":"deny",…}` object on stdout, exit 0.
 *   allowed   — anything else, a payload it can't read included: no output,
 *               exit 0. Reads are never denied.
 *   fault     — the guard itself failed, and checked nothing: one line on
 *               stderr, nothing on stdout, exit 1. Never an allow.
 *   usage     — a harness other than `cursor`: exit 2, naming `cursor`.
 *
 * And which repos are pointed at it: under Cursor, `agent-setup` writes the
 * hook as a call to the command where the entry command is not a
 * package-manager script, and as the generated script where it is. The call
 * sits behind a guard: where the command can't be run, the hook allows the
 * call and says the guard didn't run, in the body and on stderr, and exits 0.
 *
 * A change that breaks one of these tests is a breaking change: it needs a
 * "Contract" entry in CHANGELOG.md, not a quiet edit here.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CURSOR_HOOKS_FILE, runHooks } from '../../src/agent-setup/index.js';
import { CLI_COMMANDS, runCli } from '../../src/cli.js';

function capture(): { write: (text: string) => boolean; text: () => string } {
  let text = '';
  return { write: (s: string) => ((text += s), true), text: () => text };
}

/** A `preToolUse` payload for a file tool writing `path`. */
function write(path: string): string {
  return JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: path } });
}

const SCRIPT = '.cursor/hooks/checkride-protect.cjs';

/** What the two `protect` entries of `dir`'s `.cursor/hooks.json` run. */
async function commands(dir: string): Promise<string[]> {
  const config = JSON.parse(await readFile(join(dir, CURSOR_HOOKS_FILE), 'utf8')) as { hooks: Record<string, { command: string }[]> };
  return ['preToolUse', 'beforeShellExecution'].flatMap((event) => (config.hooks[event] ?? []).map((h) => h.command));
}

/** `hooks add protect --harness cursor` in `dir`. */
function add(dir: string): Promise<unknown> {
  return runHooks({ cwd: dir, action: 'add', hooks: ['protect'], harnesses: ['cursor'] });
}

describe('checkride protect', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-protect-command-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function protect(payload: string, args: string[] = ['--harness', 'cursor']): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['protect', ...args], { cwd: dir, stdout, stderr, env: { CURSOR_PROJECT_DIR: dir }, stdin: () => Promise.resolve(payload) });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  const shell = (command: string): string => JSON.stringify({ hook_event_name: 'beforeShellExecution', command, cwd: dir });

  test('the command is in the dispatch table', () => {
    expect(CLI_COMMANDS).toContain('protect');
  });

  test.each([
    ['the baseline', write('checkride.baseline.json'), 'checkride.baseline.json'],
    ['a named suite’s baseline', write('checkride.evals.baseline.json'), 'checkride.evals.baseline.json'],
    ['a file under .check/', write('.check/summary.json'), '.check/summary.json'],
    ['a shell redirect onto the baseline', shell('echo "{}" > checkride.baseline.json'), 'checkride.baseline.json'],
    ['a shell rm of .check', shell('rm -rf .check'), '.check'],
  ])('a write to %s is denied in the body, with exit 0', async (_name, payload, rel) => {
    const { code, stdout, stderr } = await protect(payload);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const body = JSON.parse(stdout) as Record<string, string>;
    expect(Object.keys(body)).toEqual(['permission', 'user_message', 'agent_message']);
    expect(body['permission']).toBe('deny');
    expect(body['agent_message']).toContain(`checkride: ${rel} is checkride-owned accounting.`);
    expect(body['user_message']).toBe(body['agent_message']);
  });

  test.each([
    ['an ordinary file', write('src/index.ts')],
    ['the config', write('checkride.config.json')],
    ['a shell read of .check/', shell('cat .check/summary.json')],
    ['an empty payload', ''],
    ['a payload that is not JSON', 'not json'],
    ['a payload of an unknown shape', JSON.stringify({ event: 'write', target: 'checkride.baseline.json' })],
  ])('%s is allowed: no output, exit 0', async (_name, payload) => {
    expect(await protect(payload)).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('a fault of the guard’s own is exit 1 with a line on stderr and nothing on stdout, never an allow', async () => {
    const stdout = capture();
    const stderr = capture();
    const unreadable = { get CURSOR_PROJECT_DIR(): string { throw new Error('unreadable'); } };
    const code = await runCli(['protect', '--harness', 'cursor'], { cwd: dir, stdout, stderr, env: unreadable, stdin: () => Promise.resolve(write('checkride.baseline.json')) });
    expect(code).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('checkride protect: the edit guard failed, so this call was not checked: unreadable\n');
  });

  test('cursor is the default harness, and any other is exit 2 naming it', async () => {
    expect((await protect(write('checkride.baseline.json'), [])).stdout).toContain('"permission":"deny"');
    const refused = await protect(write('checkride.baseline.json'), ['--harness', 'claude']);
    expect(refused).toEqual({ code: 2, stdout: '', stderr: "checkride: invalid --harness 'claude' (protect answers cursor)\n" });
  });

  describe('which Cursor repos call it', () => {
    test('a repo whose entry is `checkride` on PATH: the hook calls the command, and no script is written', async () => {
      await add(dir);
      const [pre, onShell] = await commands(dir);
      expect(pre).toContain('$(checkride protect --harness cursor)');
      expect(onShell).toBe(pre);
      expect(existsSync(join(dir, SCRIPT))).toBe(false);
    });

    test('where the command is not there to run, the hook allows the call and says the guard did not run: exit 0, never a bare failure', async () => {
      await add(dir);
      const [command] = await commands(dir);
      const done = spawnSync('/bin/sh', ['-c', command ?? ''], { cwd: dir, input: write('checkride.baseline.json'), encoding: 'utf8', env: { PATH: join(dir, 'no-such-bin') } });
      expect(done.status).toBe(0);
      const body = JSON.parse(done.stdout) as Record<string, string>;
      expect(Object.keys(body)).toEqual(['permission', 'user_message', 'agent_message']);
      expect(body['permission']).toBe('allow');
      expect(body['user_message']).toContain('checkride: the edit guard could not run — checkride is not on PATH');
      expect(body['agent_message']).toBe(body['user_message']);
      expect(done.stderr).toContain('checkride: the edit guard could not run');
    });

    test('an entry respelled by hand is still checkride’s: a re-run leaves one, and a removal none', async () => {
      await add(dir);
      const config = JSON.parse(await readFile(join(dir, CURSOR_HOOKS_FILE), 'utf8')) as { hooks: Record<string, { command: string }[]> };
      for (const event of ['preToolUse', 'beforeShellExecution']) config.hooks[event] = [{ ...config.hooks[event]?.[0], command: 'checkride protect' }];
      await writeFile(join(dir, CURSOR_HOOKS_FILE), JSON.stringify(config));
      await add(dir);
      expect(await commands(dir)).toHaveLength(2);
      await writeFile(join(dir, CURSOR_HOOKS_FILE), JSON.stringify(config));
      await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'], harnesses: ['cursor'] });
      expect(await commands(dir)).toEqual([]);
    });

    test('a repo whose entry is mise’s checkride: the hook calls the command through mise', async () => {
      await writeFile(join(dir, 'mise.toml'), '[tools]\n"github:robmclarty/checkride" = "0.21.0"\n');
      await add(dir);
      const [pre, onShell] = await commands(dir);
      expect(pre).toContain('$(mise exec -- checkride protect --harness cursor)');
      expect(onShell).toBe(pre);
      expect(existsSync(join(dir, SCRIPT))).toBe(false);
    });

    test('a repo with a package manager: the hook runs the generated script on Node, as it did', async () => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract', scripts: { check: 'checkride' } }));
      await add(dir);
      const script = `node "\${CURSOR_PROJECT_DIR:-.}/${SCRIPT}"`;
      expect(await commands(dir)).toEqual([script, script]);
      expect(existsSync(join(dir, SCRIPT))).toBe(true);
    });

    test('a repo whose entry command changes moves to the other form, leaving no script behind', async () => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
      await add(dir);
      await rm(join(dir, 'package.json'));
      await add(dir);
      const moved = await commands(dir);
      expect(moved).toHaveLength(2);
      for (const command of moved) expect(command).toContain('$(checkride protect --harness cursor)');
      expect(existsSync(join(dir, SCRIPT))).toBe(false);
    });
  });
});
