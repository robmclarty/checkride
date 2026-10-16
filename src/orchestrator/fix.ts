/**
 * `checkride fix` — run every active adapter's `fixArgs` in sequence, each
 * launched through its check's pin chain the way the run path launches the
 * check, so a fix runs the same copy of the tool and is refused where the
 * check would be.
 */

import { spawn } from 'node:child_process';

import type { Adapter, Slot } from '../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import { resolveChecks } from '../config.js';
import type { Launch, LaunchContext, PackageManager } from '../launch/index.js';
import { launchCheck, pinChain } from '../launch/index.js';
import { checkName, configuredTargets } from '../targets/index.js';
import { packageManagerAt, resolveCommonOptions } from './context.js';
import { checkCwd } from './place.js';
import { nameWidth, writeLine } from './report.js';
import { selectChecks, validateSelection, withFileLists } from './select.js';
import type { Out, RunFlags } from './types.js';

/**
 * Result of a single adapter's fix command. `refusal` is the launcher's
 * message when it wouldn't start the fixer, which `runFix` prints.
 */
export type FixOutcome = { ok: boolean; exit_code: number; refusal?: string };

/**
 * Runs one adapter's `fixArgs`, launched with `ctx`: the check's directory and
 * package manager, the repo root, its pin chain and `requirePins`. Injectable
 * for testing.
 */
export type FixRunner = (adapter: Adapter, ctx: LaunchContext) => Promise<FixOutcome>;

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

function spawnInherit(command: string, args: string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<FixOutcome> {
  return new Promise((resolveOutcome) => {
    const proc = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    proc.on('error', () => { resolveOutcome({ ok: false, exit_code: -1 }); });
    proc.on('close', (code) => { resolveOutcome({ ok: code === 0, exit_code: code ?? -1 }); });
  });
}

/**
 * What `checkride fix` launches for one adapter — the fix path's counterpart
 * to `defaultRunner`'s `launchCheck` call, so a fix runs the copy of the tool
 * the run path does (a canonical `pnpm exec oxlint --fix` becomes
 * `npx --no-install oxlint --fix` under npm), or is refused where the check
 * would be: a tool the project never installed under `npx` or `bunx`, a pin
 * whose source can't run it, an unpinned tool under `requirePins`. Non-tool
 * fix commands pass through unchanged.
 */
export function fixInvocation(adapter: Adapter, ctx: LaunchContext): Launch {
  return launchCheck(adapter.slot, adapter.command, adapter.fixArgs ?? [], ctx);
}

const defaultFixRunner: FixRunner = (adapter, ctx) => {
  const launch = fixInvocation(adapter, ctx);
  if ('refusal' in launch) return Promise.resolve({ ok: false, exit_code: 1, refusal: launch.refusal });
  return spawnInherit(launch.command, launch.args, ctx.cwd, launch.env);
};

/**
 * Print one fix command's result and classify it. A custom check whose fix
 * exits its `skipExitCode` reports as skipped, as the run path records it, and
 * neither fails the fix nor counts as one that ran.
 */
function reportFix(stderr: Out, r: ResolvedCheck, outcome: FixOutcome): 'ok' | 'skipped' | 'failed' {
  const name = checkName(r);
  if (outcome.exit_code === r.skipExitCode) {
    writeLine(stderr, `  ○ ${name} skipped (exit ${outcome.exit_code})`);
    return 'skipped';
  }
  writeLine(stderr, outcome.ok ? `  ✔ ${name}` : `  ✘ ${name} (exit ${outcome.exit_code})`);
  if (outcome.refusal !== undefined) stderr.write(outcome.refusal);
  return outcome.ok ? 'ok' : 'failed';
}

/**
 * Run every active adapter's `fixArgs` (`checkride fix`), a target's from its
 * root under the package manager declared nearest it.
 */
export async function runFix(options: FixOptions): Promise<FixResult> {
  const { cwd, slots, adapters, config, stderr } = resolveCommonOptions(options);
  const fixRunner = options.fixRunner ?? defaultFixRunner;
  const pmAt = packageManagerAt(options.pm, cwd);
  const requirePins = config?.requirePins === true;

  const resolved = resolveChecks({ slots, adapters, config, cwd });
  validateSelection(resolved, options);
  const selected = await withFileLists(selectChecks(resolved, options), cwd, configuredTargets(config));
  const fixable = selected.filter((r) => r.adapter?.fixArgs);

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
    // A file-list target with no files has nothing to fix.
    if (r.skip !== null) {
      writeLine(stderr, `  ○ ${checkName(r)} skipped (${r.skip})`);
      continue;
    }
    writeLine(stderr, `  ▸ fix ${checkName(r).padEnd(width)} (${adapter.name})`);
    const dir = checkCwd(cwd, r);
    // oxlint-disable-next-line no-await-in-loop -- fixers mutate the working tree; running them sequentially prevents two (for example oxlint --fix and prettier --write) racing on the same files.
    const outcome = await fixRunner(adapter, { cwd: dir, pm: pmAt(dir), repo: cwd, pins: pinChain(r.pack), requirePins });
    const result = reportFix(stderr, r, outcome);
    if (result !== 'skipped') ran.push(adapter.name);
    if (result === 'failed') ok = false;
  }

  return { ok, exitCode: ok ? 0 : 1, ran };
}
