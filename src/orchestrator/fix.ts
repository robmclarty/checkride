/**
 * `checkride fix` — run every active adapter's `fixArgs` in sequence under the
 * resolved package manager, on the same binary the run path spawns.
 */

import { spawn } from 'node:child_process';

import type { Adapter, Slot } from '../adapters.js';
import type { CheckrideConfig } from '../config.js';
import { resolveChecks } from '../config.js';
import type { PackageManager } from '../pm/index.js';
import { detectPackageManager, translateExec } from '../pm/index.js';
import { resolveCommonOptions } from './context.js';
import { nameWidth, writeLine } from './report.js';
import { selectChecks, validateSelection } from './select.js';
import type { Out, RunFlags } from './types.js';

/** Result of a single adapter's fix command. */
export type FixOutcome = { ok: boolean; exit_code: number };

/** Runs one adapter's `fixArgs` under the resolved PM. Injectable for testing. */
export type FixRunner = (adapter: Adapter, ctx: { cwd: string; pm: PackageManager }) => Promise<FixOutcome>;

export type FixOptions = RunFlags & {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stderr?: Out;
  fixRunner?: FixRunner;
  pm?: PackageManager;
};

export type FixResult = { ok: boolean; exitCode: number; ran: string[] };

function spawnInherit(command: string, args: string[], cwd: string): Promise<FixOutcome> {
  return new Promise((resolveOutcome) => {
    const proc = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    proc.on('error', () => { resolveOutcome({ ok: false, exit_code: -1 }); });
    proc.on('close', (code) => { resolveOutcome({ ok: code === 0, exit_code: code ?? -1 }); });
  });
}

/**
 * The command `checkride fix` spawns for one adapter under `pm` — the fix
 * path's counterpart to `defaultRunner`'s `translateExec` call, so a fix runs
 * on the same binary the run path does (a canonical `pnpm exec oxlint --fix`
 * becomes `npx oxlint --fix` under npm). Non-`pnpm exec` fix commands, and
 * everything under pnpm, pass through unchanged.
 */
export function fixInvocation(adapter: Adapter, pm: PackageManager): { command: string; args: string[] } {
  return translateExec(adapter.command, adapter.fixArgs ?? [], pm);
}

const defaultFixRunner: FixRunner = (adapter, ctx) => {
  const { command, args } = fixInvocation(adapter, ctx.pm);
  return spawnInherit(command, args, ctx.cwd);
};

/** Run every active adapter's `fixArgs` (`checkride fix`). */
export async function runFix(options: FixOptions): Promise<FixResult> {
  const { cwd, slots, adapters, config, stderr } = resolveCommonOptions(options);
  const fixRunner = options.fixRunner ?? defaultFixRunner;
  const pm = options.pm ?? detectPackageManager({ cwd });

  const resolved = resolveChecks({ slots, adapters, config, cwd });
  validateSelection(resolved, options);
  const fixable = selectChecks(resolved, options).filter((r) => r.adapter?.fixArgs);

  if (fixable.length === 0) {
    writeLine(stderr, 'checkride fix: no active adapters expose a fix command.');
    return { ok: true, exitCode: 0, ran: [] };
  }

  const ran: string[] = [];
  const width = nameWidth(fixable);
  let ok = true;
  for (const r of fixable) {
    const adapter = r.adapter;
    if (!adapter) continue;
    writeLine(stderr, `  ▸ fix ${r.slot.padEnd(width)} (${adapter.name})`);
    // oxlint-disable-next-line no-await-in-loop -- fixers mutate the working tree; running them sequentially prevents two (for example oxlint --fix and prettier --write) racing on the same files.
    const outcome = await fixRunner(adapter, { cwd, pm });
    ran.push(adapter.name);
    writeLine(stderr, outcome.ok ? `  ✔ ${r.slot}` : `  ✘ ${r.slot} (exit ${outcome.exit_code})`);
    if (!outcome.ok) ok = false;
  }

  return { ok, exitCode: ok ? 0 : 1, ran };
}
