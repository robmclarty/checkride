/**
 * Claude Code hooks — the mechanical half of the agent contract.
 *
 * `init` and `checkride agent-setup` write a small registry of hooks into
 * `.claude/settings.json`. The load-bearing one is the Stop-hook gate: it runs
 * the project's `check` script and exits 2 while the pipeline is red, so
 * "exit 0 = done" becomes enforcement, not just advice.
 *
 * The settings entry for the gate is a stable one-liner invoking a
 * checkride-owned script (`.claude/hooks/checkride-gate.sh`); the behavior
 * lives in the script. That split is what makes a refresh lossless: checkride
 * overwrites its script freely, while a consumer customizes via a sibling
 * script or the environment — never by editing the settings command, which
 * earlier versions rewrote in place and thereby clobbered.
 *
 * Merging into settings.json is surgical: each hook is identified by a
 * per-hook sentinel substring in its command (legacy forms included, so repos
 * carrying the old inline command are migrated, never duplicated). Unrelated
 * hooks, sibling groups, and every other settings key are preserved, and
 * re-applying is a no-op.
 *
 * This module owns only the hooks; the AGENTS.md stanza and the higher-level
 * `agent-setup` command live in `init.ts`, which imports the writers here — a
 * single direction, so there is no cycle.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { detectPackageManager, type PackageManager } from '../pm/index.js';

/** Project-shared Claude Code settings (committed), relative to the repo root. */
export const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

/** The checkride-owned Stop-hook gate script, relative to the repo root. */
export const GATE_SCRIPT_FILE = '.claude/hooks/checkride-gate.sh';

/** Every hook `agent-setup` can write; `--hook <a,b>` selects a subset. */
export const HOOK_NAMES = ['gate', 'dirty'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * The edit marker: touched by the `dirty` PostToolUse hook, checked by the
 * gate script (marker absent → the turn edited nothing → skip the run), and
 * cleared by a green gate. Dot-named so it can never collide with a slot's
 * `<slot>.json`/`<slot>.stdout.txt` artifacts, which the orchestrator deletes
 * per slot before a re-run — the marker must survive every run.
 */
const DIRTY_MARKER = '.check/.dirty';

/**
 * Sentinel carried by the legacy inline Stop command (pre-script versions
 * rewrote the whole command in settings.json). Still matched so migration
 * replaces that entry in place instead of adding a second gate.
 */
const LEGACY_GATE_SENTINEL = 'checkride: the gate is red';

/** The settings events checkride writes hooks under. */
type HookEvent = 'Stop' | 'PostToolUse' | 'PreToolUse';

/** A single Claude Code command hook (fields optional — settings.json is untrusted). */
type CommandHook = { type?: string; command?: string };
/** A hook group. Tool events carry a `matcher`; Stop groups don't. Other keys pass through. */
type HookGroup = { matcher?: string; hooks?: CommandHook[] } & Record<string, unknown>;
/** The subset of `.claude/settings.json` we touch; every other key is preserved. */
type ClaudeSettings = {
  hooks?: Partial<Record<HookEvent, HookGroup[]>> & Record<string, unknown>;
} & Record<string, unknown>;

/** One registry entry: where the hook lives and how to recognize prior forms of it. */
type HookSpec = {
  name: HookName;
  event: HookEvent;
  /** Group matcher for tool events; absent for Stop. */
  matcher?: string;
  /** Recognition substrings, current form first, legacy forms after. */
  sentinels: readonly string[];
  /** The canonical settings command. */
  command: string;
};

/**
 * The gate's settings one-liner. `sh` (not the exec bit) runs the script so a
 * clone that lost file modes still gates; `CLAUDE_PROJECT_DIR` anchors it when
 * the session cwd is a subdirectory, falling back to cwd for older harnesses.
 */
const GATE_COMMAND = `sh "\${CLAUDE_PROJECT_DIR:-.}/${GATE_SCRIPT_FILE}"`;

/**
 * The `dirty` hook's one-liner: mark that this turn edited a file. Stop fires
 * on every turn, including pure-conversation ones; the marker is what lets the
 * gate skip those instead of taxing every reply with a full pipeline run.
 */
const DIRTY_COMMAND = `mkdir -p "\${CLAUDE_PROJECT_DIR:-.}/.check" && touch "\${CLAUDE_PROJECT_DIR:-.}/${DIRTY_MARKER}"`;

/** The hook registry. Order is write order; sentinels key identity in settings. */
function hookSpecs(): HookSpec[] {
  return [
    {
      name: 'gate',
      event: 'Stop',
      sentinels: [GATE_SCRIPT_FILE, LEGACY_GATE_SENTINEL],
      command: GATE_COMMAND,
    },
    {
      name: 'dirty',
      event: 'PostToolUse',
      matcher: 'Edit|Write|NotebookEdit',
      sentinels: [DIRTY_MARKER],
      command: DIRTY_COMMAND,
    },
  ];
}

/**
 * The gate's `check`-script invocation for `pm` (the alias `agent-setup`
 * ensures exists). The hook IS a gate, so it runs `--strict` (zero checks
 * running is exit 2, not a pass — docs/contract.md) and `--digest` (the
 * token-bounded failure excerpt is a far better landing spot for an agent than
 * raw summary.json). npm alone needs `--` to reach the script with flags;
 * pnpm/yarn/bun forward them directly.
 */
function runCheckCommand(pm: PackageManager): string {
  const passthrough = pm === 'npm' ? ' --' : '';
  return `${pm} run check${passthrough} --strict --digest`;
}

/**
 * The gate script for `pm`. checkride owns and overwrites this file on every
 * `agent-setup`/`init`, so consumer customization belongs beside it, never in
 * it. `dirtyGuard` (on when the `dirty` hook is written alongside — the
 * default) makes the gate conditional on the edit marker, so
 * pure-conversation turns don't pay for a full pipeline run; without the
 * marker hook the guard would disarm the gate entirely, so a `--hook gate`
 * selection writes an unconditional script.
 */
export function gateScript(pm: PackageManager, opts: { dirtyGuard?: boolean } = {}): string {
  const dirtyGuard = opts.dirtyGuard ?? true;
  return [
    '#!/bin/sh',
    '# checkride-gate.sh — the Claude Code Stop-hook gate.',
    '#',
    '# checkride owns this file: `checkride agent-setup` (and `checkride init`)',
    '# overwrite it on every run. Customize via a sibling script or the',
    '# environment, not by editing here — edits are lost on the next refresh.',
    '#',
    "# Runs the repo's `check` script as a hard gate. Exit 2 blocks the agent",
    '# from finishing while the pipeline is red.',
    '',
    'cd "${CLAUDE_PROJECT_DIR:-.}" || exit 2',
    '',
    ...(dirtyGuard
      ? [
          '# No edit marker → this turn touched no files → nothing to gate. The',
          '# marker comes from the PostToolUse dirty hook (Edit/Write/NotebookEdit;',
          '# file writes made through Bash are a known, accepted gap) and is',
          '# cleared below after a green run.',
          `[ -f ${DIRTY_MARKER} ] || exit 0`,
          '',
        ]
      : []),
    `if ${runCheckCommand(pm)}; then`,
    ...(dirtyGuard ? [`  rm -f ${DIRTY_MARKER}`] : []),
    '  exit 0',
    'fi',
    '',
    '# --digest wrote a capped failure excerpt on red; point there when present.',
    'where=.check/summary.json',
    '[ -f .check/digest.md ] && where=.check/digest.md',
    'echo "checkride: the gate is red — read $where, fix the failing slot, then finish (do not stop while checkride is red). With the checkride plugin installed, /checkride:check runs full triage." >&2',
    'exit 2',
    '',
  ].join('\n');
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
 * Merge one hook into parsed settings, idempotently. An existing entry (found
 * by sentinel, legacy forms included) has its command refreshed in place and
 * its group's matcher normalized; otherwise a new group is appended. Sibling
 * hooks in the same group, other groups, and every unrelated settings key are
 * left untouched, so applying twice yields deep-equal settings.
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
export function applyHooks(settings: ClaudeSettings, names: readonly HookName[]): ClaudeSettings {
  return hookSpecs()
    .filter((spec) => names.includes(spec.name))
    .reduce((acc, spec) => applyHook(acc, spec), settings);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse an existing settings file, naming the file on malformed JSON so a
 * consumer sees `invalid .claude/settings.json: <reason>` instead of a bare
 * `SyntaxError` stack (mirrors `invalidConfig` in `config.ts`).
 */
function parseSettings(raw: string): ClaudeSettings {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid ${CLAUDE_SETTINGS_FILE}: ${reason}`, { cause: err });
  }
}

type HookFile = { path: string; changed: boolean };

/** Write `content` to `cwd/rel` (creating directories) unless it already matches. */
async function putFile(
  cwd: string,
  rel: string,
  content: string,
  opts: { dryRun: boolean; executable?: boolean },
): Promise<HookFile> {
  const path = join(cwd, rel);
  const raw = await readIfExists(path);
  const changed = raw !== content;
  if (changed && !opts.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    if (opts.executable) await chmod(path, 0o755);
  }
  return { path: rel, changed };
}

/**
 * Write or refresh the selected hooks (default: all) in `cwd`: the settings
 * entries in `.claude/settings.json`, plus the gate script the gate entry
 * invokes, for the detected (or provided) package manager. Every write is
 * idempotent — a second run reports `changed: false` per file. `dryRun`
 * computes the result without writing.
 */
export async function writeHooks(
  cwd: string,
  opts: { pm?: PackageManager; dryRun?: boolean; hooks?: readonly HookName[] } = {},
): Promise<{ files: HookFile[] }> {
  const pm = opts.pm ?? detectPackageManager({ cwd });
  const dryRun = opts.dryRun ?? false;
  const names = opts.hooks ?? HOOK_NAMES;
  const files: HookFile[] = [];

  const settingsPath = join(cwd, CLAUDE_SETTINGS_FILE);
  const raw = await readIfExists(settingsPath);
  const settings: ClaudeSettings = raw ? parseSettings(raw) : {};
  const nextRaw = `${JSON.stringify(applyHooks(settings, names), null, 2)}\n`;
  const changed = raw !== nextRaw;
  if (changed && !dryRun) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, nextRaw);
  }
  files.push({ path: CLAUDE_SETTINGS_FILE, changed });

  if (names.includes('gate')) {
    const script = gateScript(pm, { dirtyGuard: names.includes('dirty') });
    files.push(await putFile(cwd, GATE_SCRIPT_FILE, script, { dryRun, executable: true }));
  }
  return { files };
}
