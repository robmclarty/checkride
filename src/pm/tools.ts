/**
 * Slot-tool resolution — where a check's tool has to be for the gate to run it,
 * and how to install it when it isn't.
 *
 * `translate.ts` decides *how* a tool is spawned; this decides *whether it may
 * be*. The two are deliberately separate. `--no-install` bounds the download
 * but not the launcher's per-user cache, so the spawn alone cannot promise the
 * tool came from this repo: a copy an unrelated `npx` left behind months ago
 * satisfies the launcher just as well as a declared dependency. Resolving the
 * binary in the local tree first is what makes a slot's verdict depend on the
 * committed lockfile rather than on one machine's accumulated cache — the
 * property that lets a green run mean the same thing locally and in CI.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { PackageManager } from './detect.js';

/**
 * The `<tool>` in a canonical `pnpm exec <tool> …` adapter invocation, or `null`
 * for anything else — `pnpm audit`, `pnpm run <script>`, a built-in, or a config
 * custom check's own command. Those either have no tool to resolve or resolve it
 * themselves, so they are never pre-flighted.
 *
 * This is the same prefix test {@link translateExec} keys on, named once so the
 * run path, the fix path and `doctor` cannot drift on what counts as a tool.
 */
export function execTool(command: string, args: readonly string[]): string | null {
  if (command !== 'pnpm' || args[0] !== 'exec') return null;
  return args[1] ?? null;
}

/**
 * How each PM installs a tool as a dev dependency — the remediation a missing
 * tool points at. `bun` spells the flag `-d`; the rest take `-D`.
 */
const INSTALL: Record<PackageManager, string> = {
  pnpm: 'pnpm add -D',
  npm: 'npm install -D',
  yarn: 'yarn add -D',
  bun: 'bun add -d',
};

/** The command that would declare `tool` as a dev dependency under `pm`. */
export function installCommand(pm: PackageManager, tool: string): string {
  return `${INSTALL[pm]} ${tool}`;
}

/**
 * Find `tool`'s binary in the local tree, walking `cwd` upward the way the
 * package managers themselves do.
 *
 * The walk is what makes this correct in a workspace: pnpm and npm both hoist a
 * shared tool's bin to the workspace root, so a check running in
 * `packages/web` finds it two directories up and a root-only check finds it
 * immediately. Checking `cwd` alone would report every hoisted tool missing in
 * every monorepo — which is most of the repos with a workspace preset.
 *
 * `exists` is injected so the walk is testable against a synthetic tree.
 */
export function resolveSlotTool(cwd: string, tool: string, exists: (p: string) => boolean = existsSync): string | null {
  let dir = cwd;
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', tool);
    if (exists(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Whether `pm`'s exec launcher can supply a tool this repo never declared.
 *
 * True for exactly the two launchers that keep a per-user package cache: `npx`
 * and `bunx` will run a cached copy even under `--no-install`. `pnpm exec` and
 * `yarn` resolve from the project tree only, so they already give the stronger
 * guarantee and need no pre-flight — and Yarn PnP has no `node_modules/.bin`
 * to resolve against at all, so pre-flighting it would report every tool
 * missing. Kept in lockstep with `translate.ts`'s `EXEC` table by a test: any
 * PM carrying `--no-install` must be listed here.
 */
export function execUsesGlobalCache(pm: PackageManager): boolean {
  return pm === 'npm' || pm === 'bun';
}
