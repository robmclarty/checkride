/**
 * Claude Code Stop hook — the mechanical half of the agent contract.
 *
 * `init` and `checkride agent-setup` write an idempotent Stop hook into
 * `.claude/settings.json`. It runs the project's `check` script as a hard gate:
 * exit 2 blocks the agent from finishing while the pipeline is red, so "exit 0 =
 * done" becomes enforcement, not just advice. The command uses the *detected*
 * package manager's run form (`pnpm run check`, `npm run check`, `yarn run
 * check`, `bun run check`) so the hook works in any repo, not only pnpm ones
 * (b7). Merging is surgical: unrelated hooks, other Stop groups, and every other
 * settings key are preserved, and re-applying with the same PM is a no-op.
 *
 * This module owns only the hook; the AGENTS.md stanza and the higher-level
 * `agent-setup` command live in `init.ts`, which imports the writer here — a
 * single direction, so there is no cycle.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { detectPackageManager, type PackageManager } from '../pm/index.js';

/** Project-shared Claude Code settings (committed), relative to the repo root. */
export const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

/**
 * Stable, package-manager-independent marker identifying checkride's Stop hook
 * inside a settings file. The run prefix varies by PM, so identity keys on the
 * guidance message, which does not.
 */
const HOOK_SENTINEL = 'checkride: the gate is red';

/** A single Claude Code command hook (fields optional — settings.json is untrusted). */
type CommandHook = { type?: string; command?: string };
/** A Stop-hook group. Only `hooks` is meaningful for Stop; other keys pass through. */
type StopGroup = { hooks?: CommandHook[] } & Record<string, unknown>;
/** The subset of `.claude/settings.json` we touch; every other key is preserved. */
type ClaudeSettings = { hooks?: { Stop?: StopGroup[] } & Record<string, unknown> } & Record<string, unknown>;

/** True when a hook entry is checkride's (matched by the PM-independent sentinel). */
function isCheckrideHook(hook: CommandHook): boolean {
  return hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes(HOOK_SENTINEL);
}

/**
 * The Stop-hook command for `pm`: run the gate, and on red print guidance and
 * exit 2 (the blocking code — a plain exit 1 lets the agent stop anyway).
 */
export function stopHookCommand(pm: PackageManager): string {
  const run = `${pm} run check`;
  const guidance = `${HOOK_SENTINEL} — read .check/summary.json, fix the failing slot, then finish (do not stop while checkride is red).`;
  return `${run} || { echo '${guidance}' >&2; exit 2; }`;
}

/**
 * Merge checkride's Stop hook into parsed settings, idempotently. An existing
 * checkride hook (found by its sentinel) has its command refreshed in place;
 * otherwise a new Stop group is appended. Sibling hooks in the same group, other
 * Stop groups, and every unrelated settings key are left untouched, so applying
 * twice with the same command yields deep-equal settings.
 */
export function applyStopHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const hooks = { ...settings.hooks };
  const stop: StopGroup[] = Array.isArray(hooks.Stop) ? hooks.Stop.map((g) => ({ ...g })) : [];
  const idx = stop.findIndex((g) => (g.hooks ?? []).some(isCheckrideHook));
  const existing = idx >= 0 ? stop[idx] : undefined;
  if (existing) {
    stop[idx] = {
      ...existing,
      hooks: (existing.hooks ?? []).map((h) => (isCheckrideHook(h) ? { ...h, command } : h)),
    };
  } else {
    stop.push({ hooks: [{ type: 'command', command }] });
  }
  return { ...settings, hooks: { ...hooks, Stop: stop } };
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export type StopHookResult = { path: string; changed: boolean };

/**
 * Write or refresh the Stop hook in `cwd/.claude/settings.json` for the detected
 * (or provided) package manager, preserving any other settings. Returns whether
 * the file changed: a second run with the same PM leaves it byte-identical, so
 * `changed` is `false`. `dryRun` computes the result without writing.
 */
export async function writeStopHook(
  cwd: string,
  opts: { pm?: PackageManager; dryRun?: boolean } = {},
): Promise<StopHookResult> {
  const path = join(cwd, CLAUDE_SETTINGS_FILE);
  const pm = opts.pm ?? detectPackageManager({ cwd });
  const raw = await readIfExists(path);
  const settings: ClaudeSettings = raw ? JSON.parse(raw) : {};
  const next = applyStopHook(settings, stopHookCommand(pm));
  const nextRaw = `${JSON.stringify(next, null, 2)}\n`;
  const changed = raw !== nextRaw;
  if (changed && !opts.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, nextRaw);
  }
  return { path: CLAUDE_SETTINGS_FILE, changed };
}
