/**
 * The Claude Code hook writer — `.claude/settings.json` plus the scripts its
 * entries invoke.
 *
 * Merging is surgical: each hook is identified by a per-hook sentinel substring
 * in its command (legacy forms included, so repos carrying an older spelling are
 * migrated rather than duplicated). Unrelated hooks, sibling groups, and every
 * other settings key are preserved, and re-applying is a no-op.
 *
 * Claude Code's schema nests: an event maps to a list of *groups*, each with an
 * optional tool `matcher` and its own list of `{type, command}` hooks. Cursor's
 * is flat, which is why the two writers do not share a merge (see `./cursor.ts`).
 */

import type { HarnessName } from '../gate.js';
import { DIRTY_MARKER } from '../gate.js';
import type { HarnessSpec, WriteOptions } from './harness.js';
import { HOOK_NAMES, writeHarnessHooks } from './harness.js';
import type { HookFile } from './files.js';

/** Project-shared Claude Code settings (committed), relative to the repo root. */
export const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

/** The checkride-owned Stop-hook gate script, relative to the repo root. */
export const GATE_SCRIPT_FILE = '.claude/hooks/checkride-gate.sh';

const DIRTY_SCRIPT_FILE = '.claude/hooks/checkride-dirty.sh';

/** The checkride-owned PreToolUse deny script, relative to the repo root. */
export const PROTECT_SCRIPT_FILE = '.claude/hooks/checkride-protect.cjs';

const HARNESS: HarnessName = 'claude';

/**
 * Sentinel carried by the legacy inline Stop command (pre-script versions rewrote
 * the whole command in settings.json). Still matched so migration replaces that
 * entry in place instead of adding a second gate.
 */
const LEGACY_GATE_SENTINEL = 'checkride: the gate is red';

/**
 * The `dirty` hook was an inline `mkdir … && touch .check/.dirty` before it
 * became a script. The marker path is what that spelling carried, so matching it
 * migrates those repos in place.
 */
const LEGACY_DIRTY_SENTINEL = DIRTY_MARKER;

/** The settings events checkride writes hooks under. */
type HookEvent = 'Stop' | 'PostToolUse' | 'PreToolUse';

/** A single Claude Code command hook (fields optional — settings.json is untrusted). */
type CommandHook = { type?: string; command?: string };
/** A hook group. Tool events carry a `matcher`; Stop groups don't. Other keys pass through. */
type HookGroup = { matcher?: string; hooks?: CommandHook[] } & Record<string, unknown>;
/** The subset of `.claude/settings.json` we touch; every other key is preserved. */
export type ClaudeSettings = {
  hooks?: Partial<Record<HookEvent, HookGroup[]>> & Record<string, unknown>;
} & Record<string, unknown>;

/** One registry entry: where the hook lives and how to recognize prior forms of it. */
type HookSpec = {
  name: string;
  event: HookEvent;
  /** Group matcher for tool events; absent for Stop. */
  matcher?: string;
  /** Recognition substrings, current form first, legacy forms after. */
  sentinels: readonly string[];
  /** The canonical settings command. */
  command: string;
};

/**
 * `sh` (not the exec bit) runs the script so a clone that lost file modes still
 * gates; `CLAUDE_PROJECT_DIR` anchors it when the session cwd is a subdirectory,
 * falling back to cwd for older harnesses.
 */
const run = (interpreter: string, file: string): string => `${interpreter} "\${CLAUDE_PROJECT_DIR:-.}/${file}"`;

/**
 * The tool names Claude Code exposes for file mutation. `Edit` and `Write` cover
 * source; `NotebookEdit` is a distinct tool rather than a mode of the other two.
 */
const EDIT_TOOLS = 'Edit|Write|NotebookEdit';

/** The hook registry. Order is write order; sentinels key identity in settings. */
function hookSpecs(): HookSpec[] {
  return [
    {
      name: 'gate',
      event: 'Stop',
      sentinels: [GATE_SCRIPT_FILE, LEGACY_GATE_SENTINEL],
      command: run('sh', GATE_SCRIPT_FILE),
    },
    {
      name: 'dirty',
      event: 'PostToolUse',
      matcher: EDIT_TOOLS,
      sentinels: [DIRTY_SCRIPT_FILE, LEGACY_DIRTY_SENTINEL],
      command: run('sh', DIRTY_SCRIPT_FILE),
    },
    {
      name: 'protect',
      event: 'PreToolUse',
      matcher: EDIT_TOOLS,
      sentinels: [PROTECT_SCRIPT_FILE],
      command: run('node', PROTECT_SCRIPT_FILE),
    },
  ];
}

/** True when a hook entry belongs to `spec` (matched by any of its sentinels). */
function isSpecHook(spec: HookSpec, hook: CommandHook): boolean {
  const command = hook.command;
  return hook.type === 'command' && typeof command === 'string' && spec.sentinels.some((s) => command.includes(s));
}

/** The event's group list, tolerating a malformed (non-array) settings value. */
function eventGroups(settings: ClaudeSettings, event: HookEvent): HookGroup[] {
  const groups = settings.hooks?.[event];
  return Array.isArray(groups) ? groups.map((g) => ({ ...g })) : [];
}

/**
 * Merge one hook into parsed settings, idempotently. An existing entry (found by
 * sentinel, legacy forms included) has its command refreshed in place and its
 * group's matcher normalized; otherwise a new group is appended. Sibling hooks in
 * the same group, other groups, and every unrelated settings key are left
 * untouched, so applying twice yields deep-equal settings.
 */
function applyHook(settings: ClaudeSettings, spec: HookSpec): ClaudeSettings {
  const hooks = { ...settings.hooks };
  const groups = eventGroups(settings, spec.event);
  const idx = groups.findIndex((g) => (g.hooks ?? []).some((h) => isSpecHook(spec, h)));
  const existing = idx >= 0 ? groups[idx] : undefined;
  if (existing) {
    groups[idx] = {
      ...existing,
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: (existing.hooks ?? []).map((h) => (isSpecHook(spec, h) ? { ...h, command: spec.command } : h)),
    };
  } else {
    groups.push({
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command: spec.command }],
    });
  }
  return { ...settings, hooks: { ...hooks, [spec.event]: groups } };
}

/** Merge the selected hooks into parsed settings (see {@link applyHook}). */
export function applyHooks(settings: ClaudeSettings = {}, names: readonly string[] = HOOK_NAMES): ClaudeSettings {
  return hookSpecs()
    .filter((spec) => names.includes(spec.name))
    .reduce((acc, spec) => applyHook(acc, spec), settings);
}

const SPEC: HarnessSpec<ClaudeSettings> = {
  name: HARNESS,
  configFile: CLAUDE_SETTINGS_FILE,
  scripts: { gate: GATE_SCRIPT_FILE, dirty: DIRTY_SCRIPT_FILE, protect: PROTECT_SCRIPT_FILE },
  apply: applyHooks,
};

/** Write or refresh the selected Claude Code hooks in `cwd`. */
export function writeClaudeHooks(cwd: string, opts: WriteOptions): Promise<HookFile[]> {
  return writeHarnessHooks(cwd, SPEC, opts);
}
