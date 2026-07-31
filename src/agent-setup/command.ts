/**
 * The `hooks` command — install or remove agent hooks, and nothing else.
 *
 * `agent-setup` writes four things at once: the `check` script alias, the
 * AGENTS.md stanza, the hooks, and the Cursor skills. That bundle is right for
 * adopting checkride and wrong for the day you want one hook gone, because the
 * stanza guard sits in front of the whole run — so a repo whose AGENTS.md had
 * been edited could not remove a hook at all, and a repo mid-upgrade had its
 * stanza rewritten by a command it had asked to touch hooks.
 *
 * Hook management is not stanza management. This command reads and writes the
 * harness config and the generated scripts, never AGENTS.md, so no state of that
 * file can block it and no run of it can change that file.
 */

import type { HarnessName } from '../gate.js';
import type { HookFile } from './files.js';
import { type HookName, writeHooks } from './hook.js';

/** What the command does to the named hooks. */
export type HooksAction = 'add' | 'remove';

export type HooksOptions = {
  action: HooksAction;
  cwd?: string;
  /** Which hooks; defaults to all of them on `add`, and is required on `remove`. */
  hooks?: readonly HookName[];
  harnesses?: readonly HarnessName[];
  dryRun?: boolean;
  stdout?: { write: (chunk: string) => void };
};

export type HooksResult = {
  written: string[];
  removed: string[];
  skipped: string[];
  exitCode: number;
};

/** Split the writer's per-file report into the three lists the caller reports. */
function partition(files: readonly HookFile[]): Omit<HooksResult, 'exitCode'> {
  const out: Omit<HooksResult, 'exitCode'> = { written: [], removed: [], skipped: [] };
  for (const f of files) {
    if (!f.changed) out.skipped.push(`${f.path} (${f.removed === true ? 'absent' : 'unchanged'})`);
    else if (f.removed === true) out.removed.push(f.path);
    else out.written.push(f.path);
  }
  return out;
}

/**
 * What to hand the writer for this action.
 *
 * Removal passes an empty write set alongside `remove`: tearing out one hook
 * must not refresh the others as a side effect, or `hooks remove protect` would
 * quietly rewrite the gate script it was never asked about.
 *
 * `remove` requires an explicit list. Defaulting it to every hook would let a
 * bare `checkride hooks remove` silently tear out the gate, which is the one
 * thing making "done" mean anything here; `add` defaults to all because the
 * worst it can do is rewrite a file that was already correct.
 */
function hookSelection(options: HooksOptions): { hooks?: readonly HookName[]; remove?: readonly HookName[] } {
  const names = options.hooks;
  if (options.action !== 'remove') return names ? { hooks: names } : {};
  if (!names || names.length === 0) {
    throw new Error('hooks remove: name the hooks to remove (e.g. `checkride hooks remove gate`)');
  }
  return { hooks: [], remove: names };
}

/**
 * Install or remove the named hooks for the selected harnesses (default:
 * detected). Idempotent in both directions — a second `add` reports every file
 * unchanged, a second `remove` reports every file absent — and `dryRun` computes
 * the same answer without touching the disk.
 */
export async function runHooks(options: HooksOptions): Promise<HooksResult> {
  const cwd = options.cwd ?? process.cwd();
  const { files } = await writeHooks(cwd, {
    dryRun: options.dryRun ?? false,
    ...(options.harnesses ? { harnesses: options.harnesses } : {}),
    ...hookSelection(options),
  });
  const parts = partition(files);
  if (options.stdout) {
    // Counted as *files changed*, not files deleted. A hook a harness expresses
    // as configuration — Claude Code's `protect` is a `permissions.deny` rule —
    // is torn out by rewriting the config and deleting nothing, and a report of
    // "removed 0 file(s)" for a run that did exactly what was asked reads as a
    // no-op.
    const verb = options.action === 'remove' ? 'removed' : 'wrote';
    const count = parts.written.length + parts.removed.length;
    const dry = options.dryRun === true ? ' [dry run]' : '';
    options.stdout.write(`checkride hooks: ${verb} ${options.hooks?.join(', ') ?? 'every hook'} — ${count} file(s) changed${dry}.\n`);
  }
  return { ...parts, exitCode: 0 };
}
