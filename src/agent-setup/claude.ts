/**
 * The Claude Code hook writer — `.claude/settings.json`, and the one script its
 * entries still invoke.
 *
 * Merging is surgical: each hook is identified by a per-hook sentinel substring
 * in its command (legacy forms included, so repos carrying an older spelling are
 * migrated rather than duplicated). Unrelated hooks, sibling groups, and every
 * other settings key are preserved, and re-applying is a no-op.
 *
 * Claude Code's schema nests: an event maps to a list of *groups*, each with an
 * optional tool `matcher` and its own list of `{type, command}` hooks. Cursor's
 * is flat, which is why the two writers do not share a merge (see `./cursor.ts`).
 *
 * **Two of the three hooks are configuration here, not code.** `protect` is a
 * pair of `permissions.deny` rules and `dirty` is an inline one-liner, so
 * neither puts a file in the consumer's repo. Only the gate keeps a script, and
 * only because it has a branch config cannot express — see {@link GATE_SCRIPT_FILE}.
 */

import { posix } from 'node:path';

import type { HarnessName } from '../gate.js';
import { DIRTY_MARKER } from '../gate.js';
import type { PackageManager } from '../pm/index.js';
import type { HarnessSpec, WriteOptions } from './harness.js';
import { gateStatusMessage, GATE_TIMEOUT_SECONDS, HOOK_NAMES, writeHarnessHooks } from './harness.js';
import type { HookFile } from './files.js';

/** Project-shared Claude Code settings (committed), relative to the repo root. */
export const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

/**
 * The checkride-owned Stop-hook gate script, relative to the repo root — the
 * only file checkride still generates for Claude Code.
 *
 * It survives the move to configuration because it carries a branch nothing in
 * settings.json can: when `checkride gate` never runs at all — not installed, a
 * launcher that died — the command exits with neither of the gate's two codes,
 * and Claude Code reads a plain non-zero hook as *hook failed, carry on*. The
 * script is what turns that into a block. Inlining it would mean a `sh -c` of a
 * dozen lines in a settings file, which is configuration only in the sense that
 * it is JSON.
 */
export const GATE_SCRIPT_FILE = '.claude/hooks/checkride-gate.sh';

/** Scripts an earlier checkride wrote here; both are configuration now. */
const DIRTY_SCRIPT_FILE = '.claude/hooks/checkride-dirty.sh';
export const PROTECT_SCRIPT_FILE = '.claude/hooks/checkride-protect.cjs';

const HARNESS: HarnessName = 'claude';

/** The `protect` hook's name, which is now a settings region rather than a hook. */
const PROTECT = 'protect';

/**
 * What `protect` denies, as Claude Code permission rules.
 *
 * `Edit(...)` and nothing else: Claude Code checks file permissions against
 * `Edit(path)` and `Read(path)` rules **only**, and an `Edit` rule covers every
 * file-editing tool. A `Write(...)` or `NotebookEdit(...)` path rule is accepted
 * but never consulted — it would warn at startup and silently protect nothing,
 * which is the failure mode this list must not have.
 *
 * The leading `**` prefixes are deliberate. Without them the matching depth depends
 * on the rule *type* — a bare single-segment directory pattern matches at any
 * depth in a deny rule but only at the anchor in an allow rule — and a
 * protection whose reach changes with its category is one nobody can reason
 * about. Spelled this way it means the same thing everywhere, and covers a
 * monorepo's per-package `.check/` as well as the root's.
 */
const PROTECT_DENY_RULES: readonly string[] = [
  'Edit(**/checkride.baseline.json)',
  'Edit(**/.check/**)',
];

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

/**
 * A single Claude Code command hook (fields optional — settings.json is
 * untrusted). Unknown keys pass through untouched, so a hand-added `if` or
 * `once` on a checkride entry survives a refresh.
 */
type CommandHook = {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
} & Record<string, unknown>;
/** A hook group. Tool events carry a `matcher`; Stop groups don't. Other keys pass through. */
type HookGroup = { matcher?: string; hooks?: CommandHook[] } & Record<string, unknown>;
/** Claude Code's permission rules. Only `deny` is checkride's business. */
type Permissions = { deny?: string[] } & Record<string, unknown>;
/** The subset of `.claude/settings.json` we touch; every other key is preserved. */
export type ClaudeSettings = {
  hooks?: Partial<Record<HookEvent, HookGroup[]>> & Record<string, unknown>;
  permissions?: Permissions;
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
  /** Seconds before Claude Code cancels the hook; absent leaves its default. */
  timeout?: number;
  /** Spinner text shown while the hook runs; absent leaves the default spinner. */
  statusMessage?: string;
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
 *
 * This is a hook *matcher*, which is a different vocabulary from a permission
 * rule: matchers name tools, and {@link PROTECT_DENY_RULES} does not, because
 * only `Edit` rules are consulted for file paths.
 */
const EDIT_TOOLS = 'Edit|Write|NotebookEdit';

/**
 * The `dirty` hook, inline. It is three shell words — make the directory, touch
 * the marker — with nothing in it a repo would want to customize, so a generated
 * file to hold it was a file for its own sake. It was inline before it became a
 * script, and {@link LEGACY_DIRTY_SENTINEL} recognizes both spellings.
 *
 * `|| true` is load-bearing: a PostToolUse hook that exits non-zero reports a
 * failure against the edit it was only observing. Failing to record a marker
 * costs one skipped gate; failing an edit costs the edit.
 */
const DIRTY_COMMAND =
  `mkdir -p "\${CLAUDE_PROJECT_DIR:-.}/${posix.dirname(DIRTY_MARKER)}" && ` +
  `touch "\${CLAUDE_PROJECT_DIR:-.}/${DIRTY_MARKER}" || true`;

/**
 * The hook registry. Order is write order; sentinels key identity in settings.
 *
 * Only the gate carries `timeout` and `statusMessage`, and for the same reason
 * Cursor's gate entry carries three fields of its own: the platform defaults are
 * tuned for hooks that observe, and the gate does not observe. It runs for
 * minutes (Claude Code's 600s default can cut a slow pipeline short, and a
 * cancelled Stop hook exits non-zero, which Claude Code reads as a *broken* hook
 * and lets the turn end — a silent vacuous green), and it is the one hook whose
 * runtime the user actually waits on, so it names itself in the spinner instead
 * of leaving them to guess whether the model hung. The two guards are fast and
 * invisible, and take the defaults.
 */
function hookSpecs(pm: PackageManager): HookSpec[] {
  return [
    {
      name: 'gate',
      event: 'Stop',
      sentinels: [GATE_SCRIPT_FILE, LEGACY_GATE_SENTINEL],
      command: run('sh', GATE_SCRIPT_FILE),
      timeout: GATE_TIMEOUT_SECONDS,
      statusMessage: gateStatusMessage(pm),
    },
    {
      name: 'dirty',
      event: 'PostToolUse',
      matcher: EDIT_TOOLS,
      // Current form first: the inline command contains the marker path, which
      // is also what the pre-script spelling carried. The script path is listed
      // after it so a repo on that form is migrated in place, not duplicated.
      sentinels: [LEGACY_DIRTY_SENTINEL, DIRTY_SCRIPT_FILE],
      command: DIRTY_COMMAND,
    },
  ];
}

/**
 * The `PreToolUse` entry an earlier checkride wrote for `protect`. It is never
 * applied — only recognized, so adopting the deny rules takes the hook it
 * replaces with it instead of leaving two mechanisms guarding one path.
 */
const RETIRED_PROTECT_HOOK: HookSpec = {
  name: PROTECT,
  event: 'PreToolUse',
  matcher: EDIT_TOOLS,
  sentinels: [PROTECT_SCRIPT_FILE],
  command: '',
};

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

/** The canonical fields for `spec`, omitting the optional ones it doesn't set. */
function specFields(spec: HookSpec): CommandHook {
  return {
    command: spec.command,
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.statusMessage !== undefined ? { statusMessage: spec.statusMessage } : {}),
  };
}

/**
 * Merge one hook into parsed settings, idempotently. An existing entry (found by
 * sentinel, legacy forms included) has its checkride-owned fields refreshed in
 * place and its group's matcher normalized; otherwise a new group is appended.
 * Sibling hooks in the same group, other groups, keys checkride does not own, and
 * every unrelated settings key are left untouched, so applying twice yields
 * deep-equal settings.
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
      hooks: (existing.hooks ?? []).map((h) => (isSpecHook(spec, h) ? { ...h, ...specFields(spec) } : h)),
    };
  } else {
    groups.push({
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', ...specFields(spec) }],
    });
  }
  return { ...settings, hooks: { ...hooks, [spec.event]: groups } };
}

/** The rules in `settings.permissions.deny`, tolerating a malformed value. */
function denyRules(settings: ClaudeSettings): string[] {
  const deny = settings.permissions?.deny;
  return Array.isArray(deny) ? [...deny] : [];
}

/** Rebuild `permissions` around `deny`, dropping keys that would be left empty. */
function withDeny(settings: ClaudeSettings, deny: readonly string[]): ClaudeSettings {
  const permissions: Permissions = { ...settings.permissions };
  if (deny.length > 0) permissions.deny = [...deny];
  else delete permissions.deny;
  // Scaffolding a repo never asked for reads worse than leaving no trace, so an
  // emptied `permissions` is dropped rather than left behind as `{}`.
  if (Object.keys(permissions).length === 0) {
    const { permissions: _dropped, ...rest } = settings;
    return rest;
  }
  return { ...settings, permissions };
}

/**
 * Add checkride's deny rules, appending only the ones that are missing.
 *
 * Appending — rather than replacing the array — is what makes this a list the
 * repo shares rather than one checkride owns. A team that adds its own
 * suppression file (a `fallow.baseline`, a lint baseline) alongside these keeps
 * it across every refresh, which the generated script could never offer: that
 * file was overwritten wholesale on every run.
 */
function applyDeny(settings: ClaudeSettings): ClaudeSettings {
  const current = denyRules(settings);
  const missing = PROTECT_DENY_RULES.filter((rule) => !current.includes(rule));
  return missing.length === 0 ? settings : withDeny(settings, [...current, ...missing]);
}

/** Strip checkride's deny rules by exact match, leaving every rule it did not write. */
function removeDeny(settings: ClaudeSettings): ClaudeSettings {
  const current = denyRules(settings);
  const kept = current.filter((rule) => !PROTECT_DENY_RULES.includes(rule));
  return kept.length === current.length ? settings : withDeny(settings, kept);
}

/**
 * Merge the selected hooks into parsed settings (see {@link applyHook}). `pm`
 * only reaches the gate's spinner text, so it defaults to the near-universal
 * `pnpm` for callers (tests, the removal path) that have no repo to detect one from.
 *
 * `protect` takes the other branch: it is a permission rule, not a hook, so it
 * lands in `permissions.deny` and takes the retired hook entry away with it.
 * Claude Code evaluates deny rules regardless of what a `PreToolUse` hook
 * returns, so this is enforcement at a lower level than the script it replaces,
 * at no cost per tool call.
 */
export function applyHooks(
  settings: ClaudeSettings = {},
  names: readonly string[] = HOOK_NAMES,
  pm: PackageManager = 'pnpm',
): ClaudeSettings {
  const applied = hookSpecs(pm)
    .filter((spec) => names.includes(spec.name))
    .reduce((acc, spec) => applyHook(acc, spec), settings);
  return names.includes(PROTECT) ? applyDeny(removeHook(applied, RETIRED_PROTECT_HOOK)) : applied;
}

/**
 * Strip one hook from parsed settings. A group that is left with no hooks is
 * dropped, and an event left with no groups loses its key — a settings file that
 * accumulates empty scaffolding is worse than one that reads as if the hook was
 * never there. Sibling hooks sharing the group survive, so removing `protect`
 * cannot take a co-located `PreToolUse` hook with it.
 */
function removeHook(settings: ClaudeSettings, spec: HookSpec): ClaudeSettings {
  const hooks = { ...settings.hooks };
  const groups = eventGroups(settings, spec.event)
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isSpecHook(spec, h)) }))
    .filter((g) => g.hooks.length > 0);
  if (groups.length > 0) hooks[spec.event] = groups;
  else delete hooks[spec.event];
  // The pruning runs all the way up. Without this last step a repo with no hooks
  // left still carries `"hooks": {}` — and now that `protect` is a permission
  // rule, applying it alone would *introduce* that empty key into a settings
  // file that had none, which is scaffolding for a hook that no longer exists.
  if (Object.keys(hooks).length === 0) {
    const { hooks: _dropped, ...rest } = settings;
    return rest;
  }
  return { ...settings, hooks };
}

/**
 * Remove the named hooks from parsed settings — the inverse of
 * {@link applyHooks}, and idempotent in the same way. The package manager is
 * irrelevant here: entries are matched by sentinel, never by their rendered
 * fields, so a repo whose gate was written under a different launcher still has
 * its gate found and removed.
 */
export function removeHooks(
  settings: ClaudeSettings = {},
  names: readonly string[] = HOOK_NAMES,
): ClaudeSettings {
  const removed = hookSpecs('pnpm')
    .filter((spec) => names.includes(spec.name))
    .reduce((acc, spec) => removeHook(acc, spec), settings);
  // Both spellings of `protect` go: the deny rules this version writes, and the
  // hook entry an older one did. Uninstalling must not depend on which you had.
  return names.includes(PROTECT) ? removeDeny(removeHook(removed, RETIRED_PROTECT_HOOK)) : removed;
}

const SPEC: HarnessSpec<ClaudeSettings> = {
  name: HARNESS,
  configFile: CLAUDE_SETTINGS_FILE,
  scripts: { gate: GATE_SCRIPT_FILE },
  retired: { dirty: DIRTY_SCRIPT_FILE, protect: PROTECT_SCRIPT_FILE },
  apply: applyHooks,
  remove: removeHooks,
};

/** Write or refresh the selected Claude Code hooks in `cwd`. */
export function writeClaudeHooks(cwd: string, opts: WriteOptions): Promise<HookFile[]> {
  return writeHarnessHooks(cwd, SPEC, opts);
}
