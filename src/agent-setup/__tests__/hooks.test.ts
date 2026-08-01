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
  removeCursorHooks,
  removeHooks,
  renameSkill,
  writeHooks,
} from '../index.js';

/**
 * Claude Code gets two files, not four: `protect` is a `permissions.deny` rule
 * and `dirty` is an inline command, so only the gate still needs a script.
 */
const CLAUDE_FILES = [CLAUDE_SETTINGS_FILE, GATE_SCRIPT_FILE];
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

  /**
   * Claude Code parses a hook body only on exit 0, and only a body can carry a
   * user-visible message alongside the block — so the script forwards what
   * checkride wrote and exits 0, rather than re-blocking on the status.
   */
  test('the claude gate script forwards checkride’s hook body and exits 0 on it', () => {
    const script = gateScript('pnpm', { harness: 'claude' });
    expect(script).toMatch(/body=\$\(.*checkride gate/);
    expect(script).toMatch(/if \[ -n "\$body" \][\s\S]*0\|2\) exit 0 ;;/);
  });

  /**
   * A hook script generated before the body existed blocks on exit 2 and ignores
   * stdout. Keeping that branch means an unrefreshed repo keeps gating — and it
   * is also what answers an older checkride that emits no body at all.
   */
  test('the claude gate script still blocks on the exit code when no body came back', () => {
    const script = gateScript('pnpm', { harness: 'claude' });
    expect(script).toContain('[ "$status" -eq 2 ] && exit 2');
  });

  /** Cursor reads the hook's own stdout, so there is nothing for its script to capture. */
  test('the cursor gate script lets its stdout stream straight through', () => {
    expect(gateScript('pnpm', { harness: 'cursor' })).not.toContain('body=$(');
  });

  test('the dirty script creates the marker directory and always exits 0', () => {
    const script = dirtyScript();
    expect(script).toContain('.check/.dirty');
    // Failing to record an edit must never block the edit itself.
    expect(script).toContain('exit 0');
  });

  test('the protect script names what it defends', () => {
    const script = protectScript();
    expect(script).toContain('checkride.baseline.json');
    expect(script).toContain('.check');
  });

  /**
   * Cursor only: Claude Code enforces the same paths through `permissions.deny`.
   * Cursor reads a non-zero hook as *broken* and proceeds, so its denial cannot
   * ride on the exit code and has to travel in the body.
   */
  test('protect denies in the one spelling that still needs a script', () => {
    expect(protectScript()).toContain("permission: 'deny'");
    expect(protectScript()).not.toContain('process.exit(2)');
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

  /**
   * The gate is the one hook a user waits on, and the default spinner says
   * nothing about why. Naming the command in `statusMessage` is the difference
   * between "a full pipeline is running" and "the model appears to have hung".
   */
  test('the gate names the command it is running in the spinner', () => {
    const entry = applyHooks({}, ['gate'], 'npm').hooks?.Stop?.[0]?.hooks?.[0];
    // `npm check` is not a command — the label has to be a line the user could
    // actually paste, since the reason they are reading it is to run it themselves.
    expect(entry?.statusMessage).toContain('npm run check');
    expect(applyHooks({}, ['gate'], 'pnpm').hooks?.Stop?.[0]?.hooks?.[0]?.statusMessage).toContain('pnpm check');
  });

  /**
   * Claude Code's default command-hook timeout is 600s, and it reads a cancelled
   * hook as a *broken* one — which ends the turn. A pipeline slower than the
   * default would therefore stop gating silently: a vacuous green.
   */
  test('the gate raises the timeout past a real pipeline’s runtime', () => {
    const entry = applyHooks({}, ['gate']).hooks?.Stop?.[0]?.hooks?.[0];
    expect(entry?.timeout).toBeGreaterThan(600);
  });

  /** The two guards are fast and invisible; only the gate overrides the defaults. */
  test('the guards take the platform defaults', () => {
    const entry = applyHooks({}, ['dirty']).hooks?.PostToolUse?.[0]?.hooks?.[0];
    expect(entry?.timeout).toBeUndefined();
    expect(entry?.statusMessage).toBeUndefined();
  });

  test('a refresh restores the gate’s fields but keeps keys checkride does not own', () => {
    const weakened = applyHooks({}, ['gate']);
    const entry = weakened.hooks?.Stop?.[0]?.hooks?.[0];
    if (entry) {
      entry.timeout = 5;
      entry['if'] = 'Edit(*.ts)';
    }
    const next = applyHooks(weakened, ['gate']).hooks?.Stop?.[0]?.hooks?.[0];
    expect(next?.timeout).toBeGreaterThan(600);
    expect(next?.['if']).toBe('Edit(*.ts)');
  });

  /**
   * `protect` is configuration, not a hook: Claude Code evaluates a deny rule
   * regardless of what a PreToolUse hook returns, so this is the same protection
   * enforced a level lower, with no process spawned per edit.
   */
  test('protect is a permissions deny rule, not a hook at all', () => {
    const next = applyHooks({}, ['protect']);
    expect(next.permissions?.deny).toEqual(['Edit(**/checkride.baseline.json)', 'Edit(**/.check/**)']);
    expect(next.hooks?.PreToolUse).toBeUndefined();
  });

  /**
   * Only `Edit(path)` and `Read(path)` rules are consulted for file paths. A
   * `Write(...)` or `NotebookEdit(...)` rule is accepted, never checked, and
   * warns at startup — it would look like protection and be none. `Read` is
   * deliberately absent for the opposite reason: the stanza's procedure and the
   * skills read `.check/` artifacts, so denying reads would break triage.
   */
  test('every rule is an Edit rule — the only kind checked against a path', () => {
    for (const rule of applyHooks({}, ['protect']).permissions?.deny ?? []) {
      expect(rule.startsWith('Edit(')).toBe(true);
    }
  });

  test('appends to a deny list rather than owning it', () => {
    const mine = 'Edit(**/fallow.baseline.json)';
    const next = applyHooks({ permissions: { deny: [mine] } }, ['protect']);
    expect(next.permissions?.deny?.[0]).toBe(mine);
    expect(next.permissions?.deny).toHaveLength(3);
    // A second run adds nothing: the rules are keyed by their exact text.
    expect(applyHooks(next, ['protect'])).toEqual(next);
  });

  test('removing protect strips checkride’s rules and leaves the repo’s own', () => {
    const mine = 'Edit(**/fallow.baseline.json)';
    const added = applyHooks({ permissions: { deny: [mine] } }, ['protect']);
    expect(removeHooks(added, ['protect']).permissions?.deny).toEqual([mine]);
  });

  test('removing protect from a repo that had only checkride’s rules leaves no scaffolding', () => {
    const added = applyHooks({}, ['protect']);
    expect(removeHooks(added, ['protect'])).toEqual({});
  });

  /**
   * A repo set up by an older checkride has the `.cjs` hook. Adopting the deny
   * rules must take that entry with it, or one path ends up guarded by two
   * mechanisms and the dead one keeps spawning Node on every edit.
   */
  test('adopting the deny rules retires the PreToolUse hook that used to do this', () => {
    const legacy = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|NotebookEdit',
            hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR:-.}/${PROTECT_SCRIPT_FILE}"` }],
          },
        ],
      },
    };
    const next = applyHooks(legacy, ['protect']);
    expect(next.hooks?.PreToolUse).toBeUndefined();
    expect(next.permissions?.deny).toHaveLength(2);
  });

  test('removing protect works whichever form the repo had', () => {
    const legacy = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|NotebookEdit',
            hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR:-.}/${PROTECT_SCRIPT_FILE}"` }],
          },
        ],
      },
    };
    expect(removeHooks(legacy, ['protect'])).toEqual({});
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

  test('removing the gate takes its group with it, leaving no empty scaffolding', () => {
    const next = removeHooks(applyHooks({}, HOOK_NAMES), ['gate']);
    expect(next.hooks?.Stop).toBeUndefined();
    expect(next.hooks?.PostToolUse).toHaveLength(1);
  });

  test('removing keeps a sibling hook that shares the group', () => {
    const withSibling = applyHooks(
      { hooks: { PreToolUse: [{ matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: 'echo mine' }] }] } },
      ['protect'],
    );
    const next = removeHooks(withSibling, ['protect']);
    expect(next.hooks?.PreToolUse?.[0]?.hooks).toEqual([{ type: 'command', command: 'echo mine' }]);
  });

  test('removing what was never there changes nothing', () => {
    // An unrelated `permissions.allow` is exactly what must survive, now that
    // checkride writes into `permissions` itself.
    const settings = { permissions: { allow: ['Bash'] } };
    expect(removeHooks(settings, HOOK_NAMES)).toEqual(settings);
  });

  /**
   * `dirty` is three shell words with nothing to customize, so it holds no
   * script — it was inline before it became one, and is inline again.
   */
  test('dirty is an inline command, not a script', () => {
    const command = applyHooks({}, ['dirty']).hooks?.PostToolUse?.[0]?.hooks?.[0]?.command ?? '';
    expect(command).toContain('touch');
    expect(command).toContain('.check/.dirty');
    expect(command).not.toContain('checkride-dirty.sh');
    // Never fails the edit it was only observing.
    expect(command.endsWith('|| true')).toBe(true);
  });

  test('migrates the script form back to inline, in place', () => {
    const scripted = 'sh "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/checkride-dirty.sh"';
    const next = applyHooks(
      { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: scripted }] }] } },
      ['dirty'],
    );
    // One entry, migrated — not a second one alongside the old.
    expect(next.hooks?.PostToolUse).toHaveLength(1);
    expect(next.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).not.toContain('checkride-dirty.sh');
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

  /**
   * Each guard takes a second entry on the shell events, because the file tools
   * never see `echo … > checkride.baseline.json`. They share their sibling's
   * name — one guard, one `--remove-hook` — and its script.
   */
  test('both guards extend onto the shell events, under the same name', () => {
    const next = applyCursorHooks({}, HOOK_NAMES);
    expect(next.hooks?.beforeShellExecution?.[0]?.command).toContain('checkride-protect.cjs');
    expect(next.hooks?.afterShellExecution?.[0]?.command).toContain('checkride-dirty.sh');
    // The gate is not per-call, so it takes no shell entry.
    expect(next.hooks?.beforeShellExecution).toHaveLength(1);
    expect(applyCursorHooks({}, ['gate']).hooks?.beforeShellExecution).toBeUndefined();
  });

  test('removing a guard takes out both of its entries', () => {
    const next = removeCursorHooks(applyCursorHooks({}, HOOK_NAMES), ['protect']);
    expect(next.hooks?.preToolUse).toBeUndefined();
    expect(next.hooks?.beforeShellExecution).toBeUndefined();
    // Its sibling guard is untouched.
    expect(next.hooks?.afterShellExecution).toHaveLength(1);
  });

  /**
   * `protect`'s matcher is what keeps a command-line parse affordable: only
   * commands already naming an accounting path are parsed at all. Reads match
   * too — the script, not the matcher, is what decides they are allowed.
   */
  test('protect’s shell matcher selects the commands worth parsing', () => {
    const matcher = applyCursorHooks({}, ['protect']).hooks?.beforeShellExecution?.[0]?.matcher;
    const re = new RegExp(String(matcher));
    expect(re.test('echo x > checkride.baseline.json')).toBe(true);
    expect(re.test('rm -rf .check')).toBe(true);
    expect(re.test('cat .check/summary.json')).toBe(true);
    // `pnpm check` is the script, not the directory.
    expect(re.test('pnpm check')).toBe(false);
    expect(re.test('echo hi > src/index.ts')).toBe(false);
  });

  /**
   * `dirty`'s matcher decides entirely on its own whether a turn is dirty, so
   * the `2>&1` trailing half the agent's commands is the case that matters: a
   * matcher that reads it as a redirect marks every turn and the gate stops
   * skipping anything.
   */
  test('dirty’s shell matcher reads a write, not a stderr redirect', () => {
    const matcher = applyCursorHooks({}, ['dirty']).hooks?.afterShellExecution?.[0]?.matcher;
    const re = new RegExp(String(matcher));
    expect(re.test('pnpm test 2>&1')).toBe(false);
    expect(re.test('git status')).toBe(false);
    expect(re.test('grep -rn foo src/')).toBe(false);
    expect(re.test('echo hi > src/new.ts')).toBe(true);
    expect(re.test('sed -i s/a/b/ src/x.ts')).toBe(true);
    expect(re.test('git apply patch.diff')).toBe(true);
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

  test('removing the gate drops its event key and leaves the rest standing', () => {
    const next = removeCursorHooks(applyCursorHooks({}, HOOK_NAMES), ['gate']);
    expect(next.hooks?.stop).toBeUndefined();
    expect(next.hooks?.preToolUse).toHaveLength(1);
    expect(next.version).toBe(1);
  });

  test('removing keeps a foreign hook registered on the same event', () => {
    const config = applyCursorHooks({ hooks: { stop: [{ command: './notify.sh' }] } }, ['gate']);
    const next = removeCursorHooks(config, ['gate']);
    expect(next.hooks?.stop).toEqual([{ command: './notify.sh' }]);
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

/**
 * Removal is what makes the gate optional *after* it is installed. Declining to
 * refresh a hook (`--hook dirty,protect`) leaves an installed one firing
 * exactly as before, so "I no longer want the stop hook" needs its own verb.
 */
describe('writeHooks — removal', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-unhook-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** The parsed Claude settings on disk. */
  async function settings(): Promise<{
    hooks?: Record<string, unknown[]>;
    permissions?: { deny?: string[] };
  } & Record<string, unknown>> {
    return JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks?: Record<string, unknown[]>;
      permissions?: { deny?: string[] };
    } & Record<string, unknown>;
  }

  test('takes out the config entry and the script it invoked', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    const result = await writeHooks(dir, { remove: ['gate'], harnesses: ['claude'] });

    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
    expect((await settings()).hooks?.['Stop']).toBeUndefined();
    expect(result.files.find((f) => f.path === GATE_SCRIPT_FILE)).toEqual({
      path: GATE_SCRIPT_FILE,
      changed: true,
      removed: true,
    });
  });

  test('leaves the hooks it was not asked to remove', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    await writeHooks(dir, { remove: ['gate'], harnesses: ['claude'] });
    // `protect` and `dirty` are configuration here, so "still installed" is a
    // deny rule and a PostToolUse entry rather than two files on disk.
    expect((await settings()).permissions?.deny).toHaveLength(2);
    expect((await settings()).hooks?.['PostToolUse']).toHaveLength(1);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
  });

  test('removing twice is a no-op, like every other write here', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    await writeHooks(dir, { remove: ['gate'], harnesses: ['claude'] });
    const again = await writeHooks(dir, { remove: ['gate'], harnesses: ['claude'] });
    expect(again.files.every((f) => !f.changed || f.removed !== true)).toBe(true);
  });

  /**
   * The gate guards on the edit marker only while the hook that sets it exists.
   * Dropping `dirty` and leaving the guard in place would disarm the gate on
   * every turn — it would find no marker and skip.
   */
  test('removing dirty rewrites a surviving gate unguarded', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    expect(await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8')).toContain('--if-dirty');
    await writeHooks(dir, { remove: ['dirty'], harnesses: ['claude'] });
    expect(await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8')).not.toContain('--if-dirty');
  });

  test('a pure removal never creates a config for a harness that had none', async () => {
    const result = await writeHooks(dir, { hooks: [], remove: ['gate'], harnesses: ['claude'] });
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
    expect(result.files.every((f) => !f.changed)).toBe(true);
  });

  test('removes from every selected harness', async () => {
    await writeHooks(dir, { harnesses: ['claude', 'cursor'] });
    await writeHooks(dir, { remove: ['gate'], harnesses: ['claude', 'cursor'] });
    expect(existsSync(join(dir, '.cursor/hooks/checkride-gate.sh'))).toBe(false);
    const cursor = JSON.parse(await readFile(join(dir, CURSOR_HOOKS_FILE), 'utf8')) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
    expect(cursor.hooks['stop']).toBeUndefined();
    expect(cursor.hooks['preToolUse']).toHaveLength(1);
    expect(cursor.version).toBe(1);
  });

  test('dryRun removes nothing', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    const result = await writeHooks(dir, { dryRun: true, remove: ['gate'], harnesses: ['claude'] });
    expect(result.files.find((f) => f.path === GATE_SCRIPT_FILE)?.changed).toBe(true);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);
  });

  test('a hook removed by hand from settings still has its script cleaned up', async () => {
    await writeHooks(dir, { harnesses: ['claude'] });
    await writeFile(join(dir, CLAUDE_SETTINGS_FILE), JSON.stringify({ model: 'sonnet' }));
    await writeHooks(dir, { hooks: [], remove: ['gate'], harnesses: ['claude'] });
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
    expect((await settings())['model']).toBe('sonnet');
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

/**
 * A `beforeShellExecution` payload. `cwd` is what a relative path in the command
 * resolves against, and Cursor sends it separately from the project root.
 */
function shellCall(command: string, cwd: string): string {
  return JSON.stringify({ hook_event_name: 'beforeShellExecution', command, cwd });
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
  function verdict(stdin: string): { code: number; stdout: string } {
    const script = join(dir, '.cursor/hooks/checkride-protect.cjs');
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CURSOR_PROJECT_DIR: dir };
    try {
      const stdout = execFileSync('node', [script], { input: stdin, env, stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, stdout: stdout.toString() };
    } catch (err) {
      return { code: (err as { status?: number }).status ?? -1, stdout: '' };
    }
  }

  /** Write Cursor's hooks once, then run every payload against them. */
  async function verdicts(inputs: string[]): Promise<boolean[]> {
    await writeHooks(dir, { harnesses: ['cursor'] });
    return inputs.map((i) => denied(verdict(i)));
  }

  test('denies the accounting files, allows the rest', async () => {
    expect(
      await verdicts([
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

  test('fails open on input it cannot read', async () => {
    // A broken hook must not brick every edit in the repo.
    expect(
      await verdicts([
        'not json',
        JSON.stringify({ tool_name: 'Write' }),
        JSON.stringify({ tool_input: { file_path: 42 } }),
      ]),
    ).toEqual([false, false, false]);
  }, 30000);

  test('reads every path key Cursor might send', async () => {
    // Cursor documents no key for Write/Delete, so the script accepts each
    // plausible spelling — including the two Claude Code documents.
    expect(
      await verdicts([
        call({ notebook_path: join(dir, '.check', 'n.ipynb') }),
        call({ path: join(dir, '.check', 'x') }),
        call({ target_file: join(dir, '.check', 'y') }),
      ]),
    ).toEqual([true, true, true]);
  }, 30000);

  /**
   * The gap a tool-name matcher cannot close: `echo … > checkride.baseline.json`
   * is a shell call, not a `Write`, so `preToolUse` never sees it.
   */
  test('denies a shell command that writes to the accounting files', async () => {
    expect(
      await verdicts([
        shellCall('echo "[]" > checkride.baseline.json', dir),
        shellCall('echo "[]" >> checkride.baseline.json', dir),
        // No spaces around the operator — the tokenizer splits on it anyway.
        shellCall('echo x>.check/summary.json', dir),
        shellCall('rm -rf .check', dir),
        shellCall('mv checkride.baseline.json /tmp/stash.json', dir),
        shellCall('sed -i s/a/b/ checkride.baseline.json', dir),
        shellCall('cat x | tee .check/summary.json', dir),
        shellCall('dd if=/dev/null of=.check/summary.json', dir),
        // Only the second command writes; a segment is judged on its own verb.
        shellCall('git status && echo "{}" > checkride.baseline.json', dir),
      ]),
    ).toEqual([true, true, true, true, true, true, true, true, true]);
  }, 30000);

  /**
   * The half that matters more. Triage *reads* `.check/` artifacts, so a guard
   * that denied on the mere mention of one would break the flow it exists to
   * protect — and the matcher routes every such command here to be judged.
   */
  test('allows every shell command that only reads the accounting files', async () => {
    expect(
      await verdicts([
        shellCall('cat .check/summary.json', dir),
        shellCall('jq . .check/summary.json', dir),
        shellCall('grep -r ok .check/', dir),
        shellCall('ls -la .check', dir),
        // A copy *out* of .check is a backup: the source is read, the dest written.
        shellCall('cp .check/summary.json /tmp/backup.json', dir),
        shellCall('cat .check/summary.json > /tmp/out.json', dir),
        // Mentioning the path in prose is not touching it.
        shellCall('echo ".check is checkride-owned"', dir),
        // A write, but not to accounting.
        shellCall('echo hi > src/index.ts', dir),
        shellCall('rm -rf node_modules', dir),
      ]),
    ).toEqual([false, false, false, false, false, false, false, false, false]);
  }, 30000);

  /**
   * The command's own cwd, not the project root, is what a relative path in it
   * resolves against — Cursor sends the two separately and they differ whenever
   * the agent has cd'd into a subdirectory.
   */
  test('resolves a shell path against the command’s cwd', async () => {
    expect(
      await verdicts([
        shellCall('echo x > ../checkride.baseline.json', join(dir, 'src')),
        // The same relative path from the root is a different file, and fine.
        shellCall('echo x > ../checkride.baseline.json', dir),
      ]),
    ).toEqual([true, false]);
  }, 30000);

  /**
   * macOS resolves the project root to `/private/var/…` while a harness may
   * hand over the `/var/…` spelling of the same directory. Comparing the two
   * raw made every in-repo path look external, so the baseline was writable.
   */
  test('resolves a symlinked project root before comparing', async () => {
    await writeHooks(dir, { harnesses: ['cursor'] });
    const script = join(dir, '.cursor/hooks/checkride-protect.cjs');
    // `dir` is under /var on macOS; process.cwd() would report /private/var.
    const env = { ...process.env, CURSOR_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: '' };
    const stdout = execFileSync('node', [script], {
      input: call({ file_path: join(dir, 'checkride.baseline.json') }),
      env,
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    // Cursor's denial rides in the body, not the exit code.
    expect(stdout).toContain('deny');
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
