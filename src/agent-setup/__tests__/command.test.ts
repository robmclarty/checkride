import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CLAUDE_SETTINGS_FILE, GATE_SCRIPT_FILE, PROTECT_SCRIPT_FILE, runHooks } from '../index.js';

/** An AGENTS.md carrying a stanza the guard in `init.ts` would refuse to touch. */
const EDITED_AGENTS = [
  '# AGENTS.md',
  '',
  '<!-- checkride:begin hash=v10000000000000000 -->',
  '',
  '## Checkride: the definition of done',
  '',
  'Something this repo changed by hand.',
  '',
  '<!-- checkride:end -->',
  '',
].join('\n');

/**
 * The other refusing state, and the one a consumer is most likely to be in: a
 * stanza with no `hash=` at all, whose wording matches nothing checkride
 * released. `edited` has a stamp that disagrees; `unstamped` has no stamp to
 * disagree with, and the guard treats it the same way.
 */
const UNSTAMPED_AGENTS = [
  '# AGENTS.md',
  '',
  '<!-- checkride:begin -->',
  '',
  '## Checkride: the definition of done',
  '',
  'A wording from some fork or hand-edit that checkride never shipped.',
  '',
  '<!-- checkride:end -->',
  '',
].join('\n');

describe('hooks command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-hooks-cmd-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    await runHooks({ cwd: dir, action: 'add' });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /**
   * The reason this command exists. `agent-setup` puts the stanza guard in front
   * of the whole run, so a repo whose AGENTS.md had been edited — or had merely
   * been written by an older checkride — could not remove a hook at all: the run
   * refused and, by contract, wrote nothing. Hook management is not stanza
   * management, and this is the line between them. (`init.test.ts` holds the
   * other half: that agent-setup still refuses the same repo.)
   */
  test('removes a hook while AGENTS.md carries edits that would stop agent-setup', async () => {
    await writeFile(join(dir, 'AGENTS.md'), EDITED_AGENTS);

    const result = await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'] });

    expect(result.exitCode).toBe(0);
    expect(result.removed).toContain(PROTECT_SCRIPT_FILE);
    expect(existsSync(join(dir, PROTECT_SCRIPT_FILE))).toBe(false);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(EDITED_AGENTS);
  });

  /**
   * The state a consumer upgrading from an old checkride, or running a forked
   * one, actually lands in — and the one that made removal impossible: with the
   * guard in front of every `agent-setup` write, `--remove-hook` threw
   * "refusing to overwrite the checkride stanza" and the gate had to be torn out
   * by hand. Uninstalling the gate must never require permission to rewrite the
   * repo's contract file.
   *
   * Both directions are asserted. That this same stanza state genuinely stops
   * `agent-setup` — so the test cannot pass merely because it was not refusing —
   * is the paired half in `init.test.ts`, which is where a test may import both
   * commands without crossing a module boundary.
   */
  test('adds and removes hooks in a repo whose stanza is unstamped', async () => {
    await writeFile(join(dir, 'AGENTS.md'), UNSTAMPED_AGENTS);

    const removed = await runHooks({ cwd: dir, action: 'remove', hooks: ['gate', 'dirty', 'protect'] });
    expect(removed.exitCode).toBe(0);
    expect(removed.removed).toContain(GATE_SCRIPT_FILE);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);

    const added = await runHooks({ cwd: dir, action: 'add' });
    expect(added.written).toContain(GATE_SCRIPT_FILE);

    // Byte-identical through both: the contract file is not this command's.
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(UNSTAMPED_AGENTS);
  });

  test('never reads or writes AGENTS.md — not even when there is none', async () => {
    await runHooks({ cwd: dir, action: 'remove', hooks: ['gate'] });
    await runHooks({ cwd: dir, action: 'add', hooks: ['gate'] });
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });

  test('removing one hook leaves the others exactly as they were', async () => {
    const before = await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8');
    const result = await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'] });
    expect(await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8')).toBe(before);
    // The settings file is edited (its entry dropped), so it counts as written;
    // no *script* is, which is what "the others are untouched" means here.
    expect(result.written).toEqual([CLAUDE_SETTINGS_FILE]);
    expect(result.removed).toEqual([PROTECT_SCRIPT_FILE]);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks['Stop']).toHaveLength(1);
    expect(settings.hooks['PreToolUse']).toBeUndefined();
  });

  test('is idempotent in both directions', async () => {
    await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'] });
    const again = await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'] });
    expect(again.removed).toEqual([]);
    expect(again.skipped.some((s) => s.includes('(absent)'))).toBe(true);

    await runHooks({ cwd: dir, action: 'add', hooks: ['protect'] });
    const secondAdd = await runHooks({ cwd: dir, action: 'add', hooks: ['protect'] });
    expect(secondAdd.written).toEqual([]);
    expect(secondAdd.skipped.some((s) => s.includes('(unchanged)'))).toBe(true);
  });

  test('--dry-run reports the change without making it', async () => {
    const result = await runHooks({ cwd: dir, action: 'remove', hooks: ['protect'], dryRun: true });
    expect(result.removed).toContain(PROTECT_SCRIPT_FILE);
    expect(existsSync(join(dir, PROTECT_SCRIPT_FILE))).toBe(true);
  });

  test('remove refuses an empty selection rather than tearing out the gate', async () => {
    await expect(runHooks({ cwd: dir, action: 'remove' })).rejects.toThrow('name the hooks to remove');
    await expect(runHooks({ cwd: dir, action: 'remove', hooks: [] })).rejects.toThrow('name the hooks to remove');
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);
  });

  test('add with no selection writes every hook', async () => {
    await runHooks({ cwd: dir, action: 'remove', hooks: ['gate', 'dirty', 'protect'] });
    const result = await runHooks({ cwd: dir, action: 'add' });
    expect(result.written).toContain(GATE_SCRIPT_FILE);
    expect(result.written).toContain(PROTECT_SCRIPT_FILE);
  });
});
