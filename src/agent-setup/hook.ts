/**
 * Agent hooks — the mechanical half of the agent contract.
 *
 * `init` and `checkride agent-setup` write a small registry of hooks into every
 * selected harness's config. The load-bearing one is the gate: it runs the
 * project's `check` script when the turn ends and refuses to let the agent
 * finish while the pipeline is red, so "exit 0 = done" becomes enforcement, not
 * just advice.
 *
 * This module is the harness-neutral half — which hooks exist, which harnesses a
 * repo wants, and the fan-out. Everything harness-shaped lives in a sibling:
 * `./claude.ts` and `./cursor.ts` own their config schemas, `./scripts.ts` owns
 * the generated scripts, and `../gate.ts` owns the verdict those scripts hand
 * back. Adding a third harness means one more sibling and one more entry in
 * `HARNESS_NAMES`, not a change here.
 *
 * The AGENTS.md stanza and the higher-level `agent-setup` command live in
 * `init.ts`, which imports the writers here — a single direction, so there is no
 * cycle.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { HARNESS_NAMES, type HarnessName } from '../gate.js';
import type { PackageManager } from '../pm/index.js';
import { writeClaudeHooks } from './claude.js';
import { writeCursorHooks } from './cursor.js';
import type { HookFile } from './files.js';
import { HOOK_NAMES, type HookName, type WriteOptions } from './harness.js';

export { HOOK_NAMES, type HookName };

/** The per-harness writers, keyed so the fan-out is a lookup, not a switch. */
const WRITERS: Record<HarnessName, (cwd: string, opts: WriteOptions) => Promise<HookFile[]>> = {
  claude: writeClaudeHooks,
  cursor: writeCursorHooks,
};

/** The directory whose presence means a repo is already using that harness. */
const HARNESS_MARKER: Record<HarnessName, string> = {
  claude: '.claude',
  cursor: '.cursor',
};

/**
 * Which harnesses to wire up when `--harness` was not given.
 *
 * Claude Code is always included: it is the harness checkride was built against,
 * and writing its hooks into a repo that never opens Claude costs two ignored
 * files. Cursor is included only on evidence (`.cursor/` exists), because the
 * inverse — seeding `.cursor/` into every repo checkride touches — would put
 * config in front of people who never asked for it.
 */
export function detectHarnesses(cwd: string): HarnessName[] {
  return HARNESS_NAMES.filter((h) => h === 'claude' || existsSync(join(cwd, HARNESS_MARKER[h])));
}

/**
 * Write or refresh the selected hooks (default: all) for the selected harnesses
 * (default: detected) in `cwd`, and tear out any named in `remove`. Every write
 * is idempotent — a second run reports `changed: false` per file — and `dryRun`
 * computes the result without writing.
 *
 * Removal is how a hook goes away *after the fact*: unselecting one with
 * `hooks` only declines to refresh it, which leaves an already-installed gate
 * firing. The two compose — `{ hooks: [], remove: ['gate'] }` removes the gate
 * and leaves everything else exactly as it stands.
 */
export async function writeHooks(
  cwd: string,
  opts: {
    pm?: PackageManager;
    dryRun?: boolean;
    hooks?: readonly HookName[];
    remove?: readonly HookName[];
    harnesses?: readonly HarnessName[];
  } = {},
): Promise<{ files: HookFile[] }> {
  const hooks = opts.hooks ?? HOOK_NAMES;
  const harnesses = opts.harnesses ?? detectHarnesses(cwd);
  const write: WriteOptions = {
    ...(opts.pm ? { pm: opts.pm } : {}),
    ...(opts.remove ? { remove: opts.remove } : {}),
    dryRun: opts.dryRun ?? false,
    hooks,
  };
  // Concurrent: no two harnesses share a path, and `Promise.all` keeps the
  // reported order tied to the selection rather than to who finished first.
  const perHarness = await Promise.all(harnesses.map((h) => WRITERS[h](cwd, write)));
  return { files: perHarness.flat() };
}
