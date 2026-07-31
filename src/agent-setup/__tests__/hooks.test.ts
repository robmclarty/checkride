/**
 * The hook writers, one describe per harness plus the parts they share.
 *
 * Two things are worth more than the rest here. The **merge** tests pin
 * idempotence and migration: `agent-setup` runs repeatedly over a file a human
 * also edits, so a writer that duplicates an entry or clobbers a sibling is the
 * failure that actually bites. The **live script** tests spawn the generated
 * `protect` scripts as real processes, because they are emitted source rather
 * than imported code — nothing else in the suite would notice if a generated
 * script stopped parsing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyCursorHooks,
  applyHooks,
  CLAUDE_SETTINGS_FILE,
  CURSOR_HOOKS_FILE,
  CURSOR_SKILLS_DIR,
  detectHarnesses,
  dirtyScript,
  GATE_SCRIPT_FILE,
  gateScript,
  HOOK_NAMES,
  PROTECT_SCRIPT_FILE,
  protectScript,
  renameSkill,
  writeHooks,
} from '../index.js';

const CLAUDE_FILES = [
  CLAUDE_SETTINGS_FILE,
  GATE_SCRIPT_FILE,
  '.claude/hooks/checkride-dirty.sh',
  PROTECT_SCRIPT_FILE,
];
const CURSOR_FILES = [
  CURSOR_HOOKS_FILE,
  '.cursor/hooks/checkride-gate.sh',
  '.cursor/hooks/checkride-dirty.sh',
  '.cursor/hooks/checkride-protect.cjs',
];

describe('generated scripts', () => {
  test('the gate script delegates to `checkride gate` rather than carrying the logic', () => {
    const script = gateScript('pnpm', { harness: 'claude' });
    expect(script).toContain('checkride gate --harness claude');
    // The decision moved into the command; the script must not re-implement it.
    expect(script).not.toContain('run check');
    expect(script).not.toContain('digest.md');
  });

  test('the gate script spells the launcher for the detected package manager', () => {
    expect(gateScript('npm', { harness: 'claude' })).toContain('npx --no-install checkride gate');
    expect(gateScript('bun', { harness: 'claude' })).toContain('bunx --no-install checkride gate');
    expect(gateScript('yarn', { harness: 'claude' })).toContain('yarn checkride gate');
    expect(gateScript('pnpm', { harness: 'claude' })).toContain('pnpm');
  });

  test('the gate guards on the edit marker by default, and not at all without the dirty hook', () => {
    expect(gateScript('pnpm', { harness: 'claude' })).toContain('--if-dirty');
    expect(gateScript('pnpm', { harness: 'claude', dirtyGuard: false })).not.toContain('--if-dirty');
  });

  /**
   * The gate is the one hook that fails *closed*. Claude Code reads a plain
   * exit 1 as "hook failed, carry on", so an unresolvable checkride would leave
   * a repo whose gate had silently stopped gating.
   */
  test('an exit outside the gate’s own 0/2 still blocks, per harness', () => {
    const claude = gateScript('pnpm', { harness: 'claude' });
    expect(claude).toContain('[ "$status" -eq 2 ] && exit 2');
    expect(claude).toMatch(/could not run[\s\S]*exit 2/);

    const cursor = gateScript('pnpm', { harness: 'cursor' });
    // Cursor treats non-zero as a broken hook, so the fallback rides in the body.
    expect(cursor).toContain('followup_message');
    expect(cursor.trimEnd().endsWith('exit 0')).toBe(true);
  });

  /**
   * A repo it cannot even enter is a gate that never ran, which is the same
   * verdict as an unresolvable checkride — and under Cursor, exiting non-zero
   * there would read as a *broken* hook and let the turn end.
   */
  test('a repo it cannot enter reports the unrunnable verdict, per harness', () => {
    const claude = gateScript('pnpm', { harness: 'claude' });
    expect(claude).toMatch(/if ! cd [\s\S]*could not run[\s\S]*exit 2\nfi/);

    const cursor = gateScript('pnpm', { harness: 'cursor' });
    expect(cursor).toMatch(/if ! cd [\s\S]*followup_message[\s\S]*exit 0\nfi/);
    // Nowhere in the cursor script may a non-zero status escape.
    expect(cursor).not.toMatch(/^\s*exit [1-9]/m);
  });

  /**
   * `sh` runs a backtick span inside double quotes as a command. The message
   * carries two backticked command names, and an early draft using `echo "…"`
   * had them silently substituted away.
   */
  test('the unrunnable message is single-quoted, so its backticks survive', () => {
    const claude = gateScript('pnpm', { harness: 'claude' });
    // Both branches that can emit it — the failed `cd` and the unknown status.
    const lines = claude.split('\n').filter((l) => l.includes('could not run'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.trim()).toMatch(/^printf '%s\\n' '.*' >&2$/);
      expect(line).not.toContain('"');
    }
  });

  test('the dirty script creates the marker directory and always exits 0', () => {
    const script = dirtyScript();
    expect(script).toContain('.check/.dirty');
    // Failing to record an edit must never block the edit itself.
    expect(script).toContain('exit 0');
  });

  test.each(['claude', 'cursor'] as const)('the %s protect script names what it defends', (harness) => {
    const script = protectScript(harness);
    expect(script).toContain('checkride.baseline.json');
    expect(script).toContain('.check');
  });

  test('protect denies in each harness’s own spelling', () => {
    expect(protectScript('claude')).toContain('process.exit(2)');
    expect(protectScript('cursor')).toContain("permission: 'deny'");
    // Cursor reads a non-zero hook as broken, so its denial cannot use the code.
    expect(protectScript('cursor')).not.toContain('process.exit(2)');
  });
});

describe('claude merge (applyHooks)', () => {
  test('the settings entry is a stable one-liner invoking the checkride-owned script', () => {
    const command = applyHooks({}, ['gate']).hooks?.Stop?.[0]?.hooks?.[0]?.command;
    expect(command).toContain(GATE_SCRIPT_FILE);
    // PM-independent: the PM lives in the script, so the settings entry never
    // changes when the PM does — that is what makes a refresh lossless.
    expect(command).not.toContain('checkride gate');
  });

  test('applying twice is a no-op (deep equal)', () => {
    const once = applyHooks({ hooks: { Stop: [] } }, HOOK_NAMES);
    expect(applyHooks(once, HOOK_NAMES)).toEqual(once);
  });

  test('protect is a PreToolUse deny on the edit tools, and only those', () => {
    const group = applyHooks({}, ['protect']).hooks?.PreToolUse?.[0];
    // Read is deliberately absent: the stanza's procedure and the skills read
    // `.check/` artifacts, so a read-deny would break checkride's own triage.
    expect(group?.matcher).toBe('Edit|Write|NotebookEdit');
    expect(group?.hooks?.[0]?.command).toContain(PROTECT_SCRIPT_FILE);
  });

  test('dirty is a PostToolUse marker, and selecting it alone leaves the gate unwritten', () => {
    const next = applyHooks({}, ['dirty']);
    expect(next.hooks?.PostToolUse?.[0]?.matcher).toBe('Edit|Write|NotebookEdit');
    expect(next.hooks?.Stop).toBeUndefined();
  });

  test('preserves unrelated settings keys and other Stop groups', () => {
    const settings = {
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] },
    };
    const next = applyHooks(settings, ['gate']);
    expect(next['permissions']).toEqual({ allow: ['Bash'] });
    expect(next.hooks?.Stop).toHaveLength(2);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('echo other');
  });

  test('migrates the legacy inline gate command in place (no duplicate group)', () => {
    const inline =
      "pnpm run check || { echo 'checkride: the gate is red — read .check/summary.json, fix the failing slot.' >&2; exit 2; }";
    const next = applyHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: inline }] }] } }, ['gate']);
    expect(next.hooks?.Stop).toHaveLength(1);
    expect(next.hooks?.Stop?.[0]?.hooks).toHaveLength(1);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain(GATE_SCRIPT_FILE);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).not.toContain('pnpm run check');
  });

  /** The dirty hook was an inline `touch` before it became a script. */
  test('migrates the legacy inline dirty command in place', () => {
    const inline = 'mkdir -p "${CLAUDE_PROJECT_DIR:-.}/.check" && touch "${CLAUDE_PROJECT_DIR:-.}/.check/.dirty"';
    const next = applyHooks({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: inline }] }] } }, ['dirty']);
    expect(next.hooks?.PostToolUse).toHaveLength(1);
    expect(next.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain('checkride-dirty.sh');
  });
});

describe('cursor merge (applyCursorHooks)', () => {
  test('seeds the schema version Cursor requires', () => {
    expect(applyCursorHooks({}, ['gate']).version).toBe(1);
  });

  test('never overwrites a version the repo already declares', () => {
    expect(applyCursorHooks({ version: 2 }, ['gate']).version).toBe(2);
  });

  test('entries are flat — no group wrapper, no `type` discriminator', () => {
    const entry = applyCursorHooks({}, ['gate']).hooks?.stop?.[0];
    expect(entry?.command).toContain('.cursor/hooks/checkride-gate.sh');
    expect(entry).not.toHaveProperty('hooks');
    expect(entry).not.toHaveProperty('type');
  });

  test('the gate carries a timeout, because a full pipeline run is minutes', () => {
    expect(applyCursorHooks({}, ['gate']).hooks?.stop?.[0]?.timeout).toBeGreaterThan(60);
  });

  /**
   * Cursor caps a stop hook's auto-followups at five per script. Claude Code
   * re-blocks indefinitely, so leaving the default would make the Cursor gate
   * five nudges rather than a gate.
   */
  test('the gate opts out of Cursor’s five-followup cap', () => {
    expect(applyCursorHooks({}, ['gate']).hooks?.stop?.[0]?.['loop_limit']).toBeNull();
  });

  /**
   * Cursor's default is fail-*open*: a hook that crashes, times out, or emits
   * unparseable JSON lets the turn end. For the gate that is a vacuous green.
   * The two guards keep the default — neither may ever block an edit.
   */
  test('only the gate fails closed; the guards stay fail-open', () => {
    const next = applyCursorHooks({}, HOOK_NAMES);
    expect(next.hooks?.stop?.[0]?.['failClosed']).toBe(true);
    expect(next.hooks?.afterFileEdit?.[0]?.['failClosed']).toBeUndefined();
    expect(next.hooks?.preToolUse?.[0]?.['failClosed']).toBeUndefined();
    expect(next.hooks?.preToolUse?.[0]?.['loop_limit']).toBeUndefined();
  });

  test('dirty uses the purpose-built afterFileEdit event, with no matcher to drift', () => {
    const entry = applyCursorHooks({}, ['dirty']).hooks?.afterFileEdit?.[0];
    expect(entry?.command).toContain('checkride-dirty.sh');
    expect(entry?.matcher).toBeUndefined();
  });

  test('protect matches Cursor’s own mutating tool names, not Claude’s', () => {
    const entry = applyCursorHooks({}, ['protect']).hooks?.preToolUse?.[0];
    // Cursor has no `Edit` tool — `Write` covers both create and modify.
    expect(entry?.matcher).toBe('Write|Delete');
    expect(entry?.matcher).not.toContain('NotebookEdit');
  });

  test('applying twice is a no-op (deep equal)', () => {
    const once = applyCursorHooks({}, HOOK_NAMES);
    expect(applyCursorHooks(once, HOOK_NAMES)).toEqual(once);
  });

  test('preserves unrelated keys and foreign hooks on the same event', () => {
    const config = {
      version: 1,
      teamId: 'acme',
      hooks: { stop: [{ command: './notify.sh' }], beforeSubmitPrompt: [{ command: './x.sh' }] },
    };
    const next = applyCursorHooks(config, ['gate']);
    expect(next['teamId']).toBe('acme');
    expect(next.hooks?.['beforeSubmitPrompt']).toHaveLength(1);
    expect(next.hooks?.stop).toHaveLength(2);
    expect(next.hooks?.stop?.[0]?.command).toBe('./notify.sh');
  });

  test('refreshes checkride’s own entry in place, keeping keys it does not own', () => {
    const once = applyCursorHooks({}, ['gate']);
    const customized = {
      ...once,
      hooks: { stop: [{ ...once.hooks?.stop?.[0], teamNote: 'reviewed', timeout: 30 }] },
    };
    const next = applyCursorHooks(customized, ['gate']);
    expect(next.hooks?.stop).toHaveLength(1);
    // A key checkride does not write survives; one it does is refreshed.
    expect(next.hooks?.stop?.[0]?.['teamNote']).toBe('reviewed');
    expect(next.hooks?.stop?.[0]?.timeout).toBeGreaterThan(60);
  });

  /**
   * The corollary of the refresh: the three fields that make the gate a gate are
   * checkride's, so a repo that edits them gets them back. The escape hatch is
   * not editing the entry, it is `--hook dirty,protect` (or `--no-hook`).
   */
  test('the gate’s own fields are restored when a repo overrides them', () => {
    const once = applyCursorHooks({}, ['gate']);
    const weakened = {
      ...once,
      hooks: { stop: [{ ...once.hooks?.stop?.[0], loop_limit: 1, failClosed: false }] },
    };
    const entry = applyCursorHooks(weakened, ['gate']).hooks?.stop?.[0];
    expect(entry?.['loop_limit']).toBeNull();
    expect(entry?.['failClosed']).toBe(true);
  });
});

describe('harness detection', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-harness-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('claude is always selected; cursor only on evidence', async () => {
    expect(detectHarnesses(dir)).toEqual(['claude']);
    await mkdir(join(dir, '.cursor'), { recursive: true });
    expect(detectHarnesses(dir)).toEqual(['claude', 'cursor']);
  });
});

describe('writeHooks', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-hook-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes one harness’s files, then a second run is a no-op', async () => {
    const first = await writeHooks(dir, { harnesses: ['claude'] });
    expect(first.files.map((f) => f.path)).toEqual(CLAUDE_FILES);
    expect(first.files.every((f) => f.changed)).toBe(true);
    const second = await writeHooks(dir, { harnesses: ['claude'] });
    expect(second.files.every((f) => !f.changed)).toBe(true);
  });

  test('fans out over every selected harness', async () => {
    const result = await writeHooks(dir, { harnesses: ['claude', 'cursor'] });
    expect(result.files.map((f) => f.path)).toEqual([...CLAUDE_FILES, ...CURSOR_FILES]);
    expect(existsSync(join(dir, CURSOR_HOOKS_FILE))).toBe(true);
  });

  test('defaults to the detected harnesses', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const result = await writeHooks(dir);
    expect(result.files.map((f) => f.path)).toEqual([...CLAUDE_FILES, ...CURSOR_FILES]);
  });

  test('the script uses the detected package manager (npm lockfile → npx)', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{}');
    await writeHooks(dir, { harnesses: ['claude'] });
    expect(await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8')).toContain('npx --no-install checkride gate');
  });

  test('merges into an existing settings file, preserving other keys', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, CLAUDE_SETTINGS_FILE),
      JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Bash' }] } }),
    );
    await writeHooks(dir, { hooks: ['gate'], harnesses: ['claude'] });
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      model: string;
      hooks: { PreToolUse: unknown[]; Stop: unknown[] };
    };
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  test('dryRun computes without writing', async () => {
    const result = await writeHooks(dir, { dryRun: true, harnesses: ['claude', 'cursor'] });
    expect(result.files.every((f) => f.changed)).toBe(true);
    for (const rel of [...CLAUDE_FILES, ...CURSOR_FILES]) {
      expect(existsSync(join(dir, rel))).toBe(false);
    }
  });

  test.each([
    ['claude', CLAUDE_SETTINGS_FILE],
    ['cursor', CURSOR_HOOKS_FILE],
  ] as const)('names the file on malformed %s config', async (harness, file) => {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), '{ not valid json');
    await expect(writeHooks(dir, { harnesses: [harness] })).rejects.toThrow(`invalid ${file}`);
  });
});

/** True when a run denied the call, in whichever spelling the harness uses. */
function denied(r: { code: number; stdout: string }): boolean {
  return r.code === 2 || (r.code === 0 && r.stdout.includes('"permission":"deny"'));
}

/** A pre-tool hook payload, as a harness sends it. */
function call(toolInput: Record<string, string>): string {
  return JSON.stringify({ tool_name: 'Write', tool_input: toolInput });
}

describe('protect script behavior (live)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-protect-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /**
   * Run the already-written script for `harness` against `stdin`. It must not
   * write the hooks itself: the payloads run concurrently, and a second writer
   * truncating the script mid-read leaves node executing an empty file — which
   * exits 0 and reads as "allowed", so the race fails the *assertion* rather
   * than the run.
   */
  function verdict(harness: 'claude' | 'cursor', stdin: string): { code: number; stdout: string } {
    const script = join(dir, harness === 'claude' ? PROTECT_SCRIPT_FILE : '.cursor/hooks/checkride-protect.cjs');
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CURSOR_PROJECT_DIR: dir };
    try {
      const stdout = execFileSync('node', [script], { input: stdin, env, stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, stdout: stdout.toString() };
    } catch (err) {
      return { code: (err as { status?: number }).status ?? -1, stdout: '' };
    }
  }

  /** Write the harness's hooks once, then run every payload against them. */
  async function verdicts(harness: 'claude' | 'cursor', inputs: string[]): Promise<boolean[]> {
    await writeHooks(dir, { harnesses: [harness] });
    return inputs.map((i) => denied(verdict(harness, i)));
  }

  test.each(['claude', 'cursor'] as const)('%s: denies the accounting files, allows the rest', async (harness) => {
    expect(
      await verdicts(harness, [
        call({ file_path: join(dir, 'checkride.baseline.json') }),
        call({ file_path: join(dir, '.check', 'summary.json') }),
        // A relative path is resolved against the project root, not the cwd.
        call({ file_path: '.check/digest.md' }),
        call({ file_path: join(dir, 'src', 'index.ts') }),
        // A file merely *named* like the baseline elsewhere is allowed.
        call({ file_path: join(dir, 'fixtures', 'checkride.baseline.json') }),
      ]),
    ).toEqual([true, true, true, false, false]);
  }, 30000);

  test.each(['claude', 'cursor'] as const)('%s: fails open on input it cannot read', async (harness) => {
    // A broken hook must not brick every edit in the repo.
    expect(
      await verdicts(harness, [
        'not json',
        JSON.stringify({ tool_name: 'Write' }),
        JSON.stringify({ tool_input: { file_path: 42 } }),
      ]),
    ).toEqual([false, false, false]);
  }, 30000);

  test('reads the path key each harness actually sends', async () => {
    // Claude Code documents `notebook_path`; Cursor documents neither key for
    // Write/Delete, so the script accepts the plausible spellings.
    expect(await verdicts('claude', [call({ notebook_path: join(dir, '.check', 'n.ipynb') })])).toEqual([true]);
    expect(
      await verdicts('cursor', [call({ path: join(dir, '.check', 'x') }), call({ target_file: join(dir, '.check', 'y') })]),
    ).toEqual([true, true]);
  }, 30000);

  /**
   * macOS resolves the project root to `/private/var/…` while a harness may
   * hand over the `/var/…` spelling of the same directory. Comparing the two
   * raw made every in-repo path look external, so the baseline was writable.
   */
  test('resolves a symlinked project root before comparing', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    const script = join(dir, PROTECT_SCRIPT_FILE);
    // `dir` is under /var on macOS; process.cwd() would report /private/var.
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CURSOR_PROJECT_DIR: '' };
    const target = join(dir, 'checkride.baseline.json');
    let code = 0;
    try {
      execFileSync('node', [script], {
        input: call({ file_path: target }),
        env,
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  }, 30000);
});

describe('cursor skills', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-skills-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('renames only the frontmatter name, leaving the body alone', () => {
    const body = '---\nname: check\ndescription: x\n---\n\n# heading\n\nname: not-frontmatter\n';
    const out = renameSkill(body, 'checkride-check');
    expect(out).toContain('name: checkride-check');
    expect(out).toContain('description: x');
    expect(out).toContain('name: not-frontmatter');
  });

  test('a body without frontmatter is passed through unchanged', () => {
    expect(renameSkill('# no frontmatter\n', 'x')).toBe('# no frontmatter\n');
  });

  test('agent-setup writes both skills under a checkride-prefixed name', async () => {
    const { runAgentSetup } = await import('../../init.js');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    await mkdir(join(dir, '.cursor'), { recursive: true });
    await runAgentSetup({ cwd: dir });

    const names = ['checkride-check', 'checkride-qa'];
    const bodies = await Promise.all(
      names.map((n) => readFile(join(dir, CURSOR_SKILLS_DIR, n, 'SKILL.md'), 'utf8')),
    );
    for (const [i, body] of bodies.entries()) {
      // A bare `check` would take the `/check` slash command in every repo.
      expect(body).toContain(`name: ${names[i]}`);
      // The skill must not depend on a plugin root Cursor never sets.
      expect(body.split('\n').slice(0, 40).join('\n')).toContain('checkride triage');
    }
  }, 30000);

  test('no cursor harness, no cursor skills', async () => {
    const { runAgentSetup } = await import('../../init.js');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    await runAgentSetup({ cwd: dir, harnesses: ['claude'] });
    expect(existsSync(join(dir, CURSOR_SKILLS_DIR))).toBe(false);
  }, 30000);
});
