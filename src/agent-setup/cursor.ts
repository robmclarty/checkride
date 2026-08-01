/**
 * The Cursor hook writer — `.cursor/hooks.json` plus the scripts its entries
 * invoke.
 *
 * Same contract as the Claude writer (`./claude.ts`): sentinel-keyed identity,
 * in-place refresh, every unrelated key preserved, re-applying is a no-op. The
 * schema is what differs, and it differs enough that sharing the merge would
 * cost more than it saved:
 *
 * - Cursor requires a top-level `"version": 1`.
 * - An event maps to a flat list of `{command, matcher?, timeout?}` entries —
 *   there is no group wrapper and no `type` discriminator, so a hook is one
 *   object where Claude Code needs two levels.
 * - The events are lowercase and differently cut: `stop`, `afterFileEdit`
 *   (purpose-built, no matcher) and `preToolUse` (matched against Cursor's own
 *   tool names — `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:*`).
 * - Cursor cuts the shell out as its own pair of events, `beforeShellExecution`
 *   and `afterShellExecution`, whose matchers run against the **command string**
 *   rather than a tool name. Both guards take a second entry there to cover what
 *   the file tools never see; the gate does not, since it is not per-call.
 *
 * A hook name therefore maps to one *or more* entries, on different events. They
 * share a name because they are one guard — `--remove-hook protect` takes out
 * both — and share a script, since the script branches on `hook_event_name`.
 *
 * The gate entry carries three fields the Claude writer has no equivalent for —
 * `timeout`, `loop_limit` and `failClosed` — because Cursor's defaults for all
 * three end a turn that checkride would keep blocking. See {@link hookSpecs}.
 */

import type { HarnessName } from '../gate.js';
import { CURSOR_HOOKS_FILE } from '../gate.js';
import type { HarnessSpec, WriteOptions } from './harness.js';
import { GATE_TIMEOUT_SECONDS, HOOK_NAMES, writeHarnessHooks } from './harness.js';
import type { HookFile } from './files.js';

/**
 * Project-shared Cursor hook config (committed), relative to the repo root.
 * Declared in `../gate.js`, which reads it to detect a native Cursor gate, and
 * re-exported here so this module stays the one place a caller looks for it.
 */
export { CURSOR_HOOKS_FILE };

const GATE_SCRIPT_FILE = '.cursor/hooks/checkride-gate.sh';
const DIRTY_SCRIPT_FILE = '.cursor/hooks/checkride-dirty.sh';
const PROTECT_SCRIPT_FILE = '.cursor/hooks/checkride-protect.cjs';

const HARNESS: HarnessName = 'cursor';

/** The schema version Cursor's loader expects at the top of the file. */
const SCHEMA_VERSION = 1;

/** The Cursor hook events checkride writes under. */
type HookEvent = 'stop' | 'afterFileEdit' | 'preToolUse' | 'beforeShellExecution' | 'afterShellExecution';

/**
 * One Cursor hook entry. Unknown keys pass through untouched.
 *
 * `loop_limit` is `number | null` in Cursor's schema, where `null` carries the
 * meaning — no cap — so it cannot be modelled as "absent".
 */
type CursorHook = {
  command?: string;
  matcher?: string;
  timeout?: number;
  loop_limit?: number | null;
  failClosed?: boolean;
} & Record<string, unknown>;

/** The subset of `.cursor/hooks.json` we touch; every other key is preserved. */
export type CursorHooks = {
  version?: number;
  hooks?: Partial<Record<HookEvent, CursorHook[]>> & Record<string, unknown>;
} & Record<string, unknown>;

type HookSpec = {
  name: string;
  event: HookEvent;
  matcher?: string;
  timeout?: number;
  loopLimit?: number | null;
  failClosed?: boolean;
  sentinels: readonly string[];
  command: string;
};

/**
 * `sh` (not the exec bit) runs the script so a clone that lost file modes still
 * gates; `CURSOR_PROJECT_DIR` anchors it when the session cwd is a subdirectory.
 *
 * **Unverified against a live Cursor.** Cursor documents `command` as "a shell
 * string, an absolute path, or a relative path", but every documented example is
 * a bare path, and it states separately that project hooks already run from the
 * project root. If Cursor ever spawns these without a shell, `${…}` stays
 * literal, the spawn fails, and Cursor's fail-open default ends the turn with no
 * signal at all — the one failure mode `failClosed` cannot cover, because the
 * hook it would guard never started. `failClosed` is set regardless; if that
 * turns out not to catch it, drop both the interpreter and the variable and
 * write the bare `.cursor/hooks/checkride-gate.sh` the docs show, accepting the
 * dependence on the exec bit. See docs/cursor.md.
 */
const run = (interpreter: string, file: string): string => `${interpreter} "\${CURSOR_PROJECT_DIR:-.}/${file}"`;

/**
 * Cursor's file-mutating tool names. There is no separate `Edit` tool — `Write`
 * covers both creating and modifying — and `Delete` can remove an accounting
 * file just as effectively as a write can overwrite it.
 */
const EDIT_TOOLS = 'Write|Delete';

/**
 * Commands `protect` bothers to parse: the ones that name an accounting path at
 * all. `beforeShellExecution` matches its `matcher` against the **full command
 * string**, and that is the whole reason a shell guard is affordable here.
 *
 * checkride's standing objection to matching a shell tool is that a guard firing
 * on a wrong parse is worse than a known hole. Filtering first turns the blast
 * radius from "every command the agent runs" into "commands that already mention
 * `checkride.baseline.json` or `.check`" — and inside that set the script still
 * denies only on demonstrated write intent. Reads land here too and are allowed;
 * they have to be, because triage reads these files.
 */
const ACCOUNTING_PATHS = 'checkride\\.baseline\\.json|\\.check\\b';

/**
 * Commands `dirty` reads as having written a file: a `>`/`>>` redirect, or one of
 * the mutating verbs. The negative lookahead on `&` is load-bearing — without it
 * the `2>&1` on the end of half the agent's commands marks every turn dirty and
 * the gate stops skipping anything.
 *
 * Heuristic on purpose, and biased toward matching: a false positive costs one
 * pipeline run on a turn that changed nothing, while a false negative is the
 * status quo — a shell-written file that no gate ever sees. Only the first of
 * those is recoverable by running the gate.
 */
const SHELL_WRITES =
  '>>?\\s*[^&\\s>]' +
  '|(^|[\\s;&|(])(rm|mv|cp|tee|sed|truncate|dd|patch|install|shred|ln)(\\s|$)' +
  '|(^|[\\s;&|(])git\\s+(apply|checkout|restore|stash|clean|reset|revert|switch|merge|rebase|pull|cherry-pick)(\\s|$)';

/**
 * Cursor's defaults are tuned for observers; the gate is not one, so all three
 * of its non-command fields are set against the default rather than with it:
 *
 * - `timeout` — a full pipeline run is minutes, and the platform default is not.
 * - `loop_limit: null` — the default of **5** stops the auto-followup after five
 *   turns, at which point a red repo finishes anyway. Claude Code re-blocks
 *   indefinitely; without this the two harnesses are not the same gate, and the
 *   Cursor one degrades into five nudges.
 * - `failClosed: true` — Cursor's default is fail-*open*: a hook that crashes,
 *   times out, or emits unparseable JSON lets the turn end silently. That is the
 *   vacuous green the whole contract exists to prevent (docs/contract.md).
 *
 * The two guards keep Cursor's fail-open default on purpose — see `dirty` and
 * `protect` in `./scripts.ts` for why each must never block an edit.
 */
function hookSpecs(): HookSpec[] {
  return [
    {
      name: 'gate',
      event: 'stop',
      timeout: GATE_TIMEOUT_SECONDS,
      loopLimit: null,
      failClosed: true,
      sentinels: [GATE_SCRIPT_FILE],
      command: run('sh', GATE_SCRIPT_FILE),
    },
    {
      // `afterFileEdit` rather than `postToolUse`: it is purpose-built for "a
      // file changed", needs no matcher, and so cannot drift when Cursor renames
      // a tool.
      name: 'dirty',
      event: 'afterFileEdit',
      sentinels: [DIRTY_SCRIPT_FILE],
      command: run('sh', DIRTY_SCRIPT_FILE),
    },
    {
      // The shell half of the edit marker. `afterFileEdit` sees only the file
      // tools, so a turn that wrote through the shell alone used to skip the
      // gate entirely. The matcher does all the deciding here — the script is
      // the same unconditional `touch` either event reaches it through.
      name: 'dirty',
      event: 'afterShellExecution',
      matcher: SHELL_WRITES,
      sentinels: [DIRTY_SCRIPT_FILE],
      command: run('sh', DIRTY_SCRIPT_FILE),
    },
    {
      name: 'protect',
      event: 'preToolUse',
      matcher: EDIT_TOOLS,
      sentinels: [PROTECT_SCRIPT_FILE],
      command: run('node', PROTECT_SCRIPT_FILE),
    },
    {
      // The shell half of the same guard. A tool-name matcher cannot see
      // `echo … > checkride.baseline.json`, because that is a shell call and not
      // a `Write`; `beforeShellExecution` is where it becomes visible. Same
      // script, same fail-open default — see `protectScript` in `./scripts.ts`
      // for why the parse behind it refuses to guess.
      name: 'protect',
      event: 'beforeShellExecution',
      matcher: ACCOUNTING_PATHS,
      sentinels: [PROTECT_SCRIPT_FILE],
      command: run('node', PROTECT_SCRIPT_FILE),
    },
  ];
}

/** True when an entry belongs to `spec` (matched by any of its sentinels). */
function isSpecHook(spec: HookSpec, hook: CursorHook): boolean {
  const command = hook.command;
  return typeof command === 'string' && spec.sentinels.some((s) => command.includes(s));
}

/** The event's entry list, tolerating a malformed (non-array) config value. */
function eventHooks(config: CursorHooks, event: HookEvent): CursorHook[] {
  const entries = config.hooks?.[event];
  return Array.isArray(entries) ? entries.map((h) => ({ ...h })) : [];
}

/**
 * The canonical fields for `spec`, omitting the optional ones it doesn't set.
 * `loopLimit` is compared against `undefined` rather than truth-tested, because
 * the value checkride writes is `null`.
 */
function specFields(spec: HookSpec): CursorHook {
  return {
    command: spec.command,
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.loopLimit !== undefined ? { loop_limit: spec.loopLimit } : {}),
    ...(spec.failClosed !== undefined ? { failClosed: spec.failClosed } : {}),
  };
}

/**
 * Merge one hook into a parsed config, idempotently. An existing entry (found by
 * sentinel) has its fields refreshed in place, keeping any key checkride does not
 * own; otherwise a new entry is appended.
 */
function applyHook(config: CursorHooks, spec: HookSpec): CursorHooks {
  const hooks = { ...config.hooks };
  const entries = eventHooks(config, spec.event);
  const idx = entries.findIndex((h) => isSpecHook(spec, h));
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...specFields(spec) };
  } else {
    entries.push(specFields(spec));
  }
  return { ...config, hooks: { ...hooks, [spec.event]: entries } };
}

/**
 * Merge the selected hooks into a parsed config, seeding `version` when absent.
 * An existing `version` is never overwritten: if a future Cursor bumps it, the
 * repo's value is the one that matches the rest of the file.
 */
export function applyCursorHooks(config: CursorHooks = {}, names: readonly string[] = HOOK_NAMES): CursorHooks {
  const seeded = config.version === undefined ? { version: SCHEMA_VERSION, ...config } : config;
  return hookSpecs()
    .filter((spec) => names.includes(spec.name))
    .reduce((acc, spec) => applyHook(acc, spec), seeded);
}

/**
 * Strip one hook from a parsed config. An event left with no entries loses its
 * key; `version` and every unrelated entry stay. Cursor's schema is flat, so
 * there is no empty group to prune — the Claude writer's extra step has no
 * counterpart here.
 */
function removeHook(config: CursorHooks, spec: HookSpec): CursorHooks {
  const hooks = { ...config.hooks };
  const entries = eventHooks(config, spec.event).filter((h) => !isSpecHook(spec, h));
  if (entries.length > 0) hooks[spec.event] = entries;
  else delete hooks[spec.event];
  return { ...config, hooks };
}

/** Remove the named hooks from a parsed config — the inverse of {@link applyCursorHooks}. */
export function removeCursorHooks(
  config: CursorHooks = {},
  names: readonly string[] = HOOK_NAMES,
): CursorHooks {
  return hookSpecs()
    .filter((spec) => names.includes(spec.name))
    .reduce((acc, spec) => removeHook(acc, spec), config);
}

const SPEC: HarnessSpec<CursorHooks> = {
  name: HARNESS,
  configFile: CURSOR_HOOKS_FILE,
  // Cursor's config has no field that renders the gate's command in its UI, so
  // the package manager reaches its hooks only through the generated script.
  apply: applyCursorHooks,
  scripts: { gate: GATE_SCRIPT_FILE, dirty: DIRTY_SCRIPT_FILE, protect: PROTECT_SCRIPT_FILE },
  remove: removeCursorHooks,
};

/** Write or refresh the selected Cursor hooks in `cwd`. */
export function writeCursorHooks(cwd: string, opts: WriteOptions): Promise<HookFile[]> {
  return writeHarnessHooks(cwd, SPEC, opts);
}
