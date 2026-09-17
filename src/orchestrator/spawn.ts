/**
 * Process lifecycle for one check: the default runner, the built-in dispatch,
 * the pre-flights that refuse to spawn at all, the spawn itself with its
 * timeout and UTF-8 capture, and the registry of live process groups the CLI
 * reaps on a fatal signal. The interrupt latch lives here too, beside the one
 * function that reads it and the two that set it.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

import type { Adapter } from '../adapters.js';
import type { CheckOutcome } from '../links.js';
import { checkLinks } from '../links.js';
import { checkPack } from '../pack.js';
import type { PackageManager } from '../pm/index.js';
import { execTool, execUsesGlobalCache, installCommand, resolveSlotTool, translateExec } from '../pm/index.js';
import { KILL_GRACE_SECONDS, killGroup } from '../proc.js';
import { checkSecurity } from '../security.js';
import { checkSmoke } from '../smoke.js';
import { checkSnippets } from '../snippets.js';
import type { CheckRunner } from './types.js';

/** Append an adapter's `changedArgs` under `--changed` (otherwise base args). */
export function runtimeArgs(adapter: Adapter, changed: boolean): string[] {
  if (changed && adapter.changedArgs) return [...adapter.args, ...adapter.changedArgs];
  return adapter.args;
}

/**
 * Default per-check timeout (seconds) when neither the check nor the config
 * sets one. A definition-of-done gate that can hang forever fails its one job
 * on the worst day, so the cap is on by default — generous enough for any
 * legitimate single slot. Override per check or globally via `timeout`; `0`
 * disables the cap.
 */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Default pool width for a wave (equal-`order` group): `min(4, max(1, cores −
 * reserve))`. Heavy checks (test, mutation, build) parallelize internally, so
 * oversubscribing every core is worse than a conservative cap; one reserved
 * core keeps the machine responsive — for the human at it. A hosted CI runner
 * has no such human, and a standard GitHub-hosted runner reports 2 CPUs, so
 * reserving one there collapsed the pool to 1 and wave scheduling silently
 * degenerated to fully sequential — on exactly the machine class the docs say
 * to gate on. Every CI provider sets `CI`, so no core is reserved there.
 * Override with `--concurrency`; `--bail` stays fail-fast sequential.
 */
export function defaultConcurrency(env: NodeJS.ProcessEnv = process.env, cores: number = cpus().length): number {
  const reserve = env['CI'] ? 0 : 1;
  return Math.min(4, Math.max(1, cores - reserve));
}

/**
 * Process groups of checks currently in flight: pid → a promise that settles
 * when that child's `close` fires. `spawnCheck` registers each spawn and
 * unregisters it on close; `killLiveChecks` walks the registry to reap
 * everything when the CLI takes a fatal signal.
 */
const liveChecks = new Map<number, Promise<void>>();

/**
 * One-way interrupt latch. Between `killLiveChecks` reaping the registry and
 * the CLI re-raising the fatal signal, the still-running `runChecks` loop gets
 * control back (the killed check's outcome resolves) and would spawn the next
 * check — a fresh detached process group that outlives the dying CLI as
 * exactly the orphan the cleanup exists to prevent. Once latched, `spawnCheck`
 * starts nothing new.
 */
let interrupted = false;

/**
 * Reap every in-flight check before the process dies: SIGTERM each live
 * process group (grandchildren included — see `killGroup`), escalate to
 * SIGKILL after `KILL_GRACE_SECONDS` for a group that won't die politely, and
 * resolve once every group has closed or been SIGKILLed. The CLI's
 * SIGINT/SIGTERM handlers await this and then re-raise — cleanup first, the
 * signal's default exit semantics after.
 */
export async function killLiveChecks(): Promise<void> {
  interrupted = true;
  await Promise.all(
    [...liveChecks.entries()].map(async ([pid, closed]) => {
      killGroup(pid, 'SIGTERM');
      let escalate: ReturnType<typeof setTimeout> | null = null;
      const grace = new Promise<void>((resolve) => {
        escalate = setTimeout(() => {
          killGroup(pid, 'SIGKILL');
          resolve();
        }, KILL_GRACE_SECONDS * 1000);
      });
      await Promise.race([closed, grace]);
      if (escalate !== null) clearTimeout(escalate);
    }),
  );
}

/**
 * Clear the interrupt latch for a new run. `runChecks` calls this on entry: on
 * the CLI path it is a no-op — the process re-raises the signal and dies — but
 * `runChecks` is exported, and a long-lived programmatic consumer that took one
 * SIGINT would otherwise have every later run silently spawn nothing. A new
 * call necessarily follows the previous one's return, so there is no in-flight
 * run for this to un-latch.
 */
export function resetInterrupt(): void {
  interrupted = false;
}

/**
 * Spawn one check. A falsy or non-positive `timeoutSec` means no cap (the
 * default cap is applied by the runner, not here). When it fires, the check's
 * whole process group gets SIGTERM, then SIGKILL after a short grace (see
 * `killGroup` — `detached` + group signal so grandchildren die too), and a
 * failed outcome carries a `"timed out after Ns"` note so the slot is recorded
 * failed with its elapsed duration (both timers are always cleared on `close`).
 * Output is captured with an explicit UTF-8 decoder so a multibyte character
 * split across two read chunks survives intact rather than decoding to U+FFFD.
 * Every spawn is registered in `liveChecks` until it closes, so a fatal signal
 * can reap the lot (`killLiveChecks`); after that interrupt, no new check
 * starts.
 */
function spawnCheck(command: string, args: string[], cwd: string, timeoutSec?: number): Promise<CheckOutcome> {
  return new Promise((resolveOutcome) => {
    // Post-interrupt, the process is about to die by the re-raised signal —
    // starting another detached group here would orphan it (see `interrupted`).
    if (interrupted) {
      resolveOutcome({ ok: false, exit_code: -1, stdout: '', stderr: 'interrupted before start\n' });
      return;
    }
    const proc = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let resolveClosed: (() => void) | null = null;
    if (proc.pid !== undefined) {
      liveChecks.set(proc.pid, new Promise<void>((resolve) => { resolveClosed = resolve; }));
    }
    const unregister = (): void => {
      if (proc.pid !== undefined) liveChecks.delete(proc.pid);
      resolveClosed?.();
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = timeoutSec && timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          killGroup(proc.pid, 'SIGTERM');
          killTimer = setTimeout(() => { killGroup(proc.pid, 'SIGKILL'); }, KILL_GRACE_SECONDS * 1000);
        }, timeoutSec * 1000)
      : null;
    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    // A decoded string stream (not raw Buffers): the internal StringDecoder holds
    // a partial multibyte sequence until the continuation bytes arrive, so `+=`
    // never concatenates a half-decoded character.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { stdout += chunk; });
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (err) => {
      clearTimers();
      unregister();
      resolveOutcome({ ok: false, exit_code: -1, stdout: '', stderr: `Failed to spawn: ${err.message}` });
    });
    proc.on('close', (code) => {
      clearTimers();
      unregister();
      if (timedOut) {
        const note = `timed out after ${timeoutSec}s`;
        resolveOutcome({ ok: false, exit_code: -1, stdout, stderr: stderr ? `${stderr}\n${note}` : `${note}\n` });
        return;
      }
      resolveOutcome({ ok: code === 0, exit_code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Dispatch a built-in check, or `null` when the adapter spawns a real tool.
 * Every built-in that runs a subprocess goes through `spawnCheck`, so its
 * child registers in `liveChecks` and inherits the timeout + reaping like any
 * other check. `security` alone runs the adapter's own args — its
 * `--audit-level` doubles as the threshold the evaluator enforces, since
 * pnpm's JSON-mode exit code ignores the level. The snippets pair shares one
 * execution path, differing only in mode.
 */
function runBuiltin(
  adapter: Adapter,
  ctx: { cwd: string; changed: boolean; pm: PackageManager },
  timeout: number,
): Promise<CheckOutcome> | null {
  const base = { cwd: ctx.cwd, spawn: spawnCheck, timeoutSec: timeout };
  switch (adapter.builtin) {
    case 'pack':
      return checkPack({ ...base, pm: ctx.pm });
    case 'smoke':
      return checkSmoke(base);
    case 'security':
      return checkSecurity({ ...base, command: adapter.command, args: runtimeArgs(adapter, ctx.changed) });
    case 'snippets':
      return checkSnippets({ ...base, mode: 'src', pm: ctx.pm });
    case 'snippets-dist':
      return checkSnippets({ ...base, mode: 'dist', pm: ctx.pm });
    default:
      return null;
  }
}

/**
 * Refuse a slot whose tool this repo never declared, rather than letting the
 * launcher's per-user cache decide the verdict.
 *
 * `--no-install` stops `npx`/`bunx` fetching a missing tool, but both still run
 * a copy cached from some earlier, unrelated invocation — so the same commit
 * passes on a machine that happens to hold one and fails on a clean checkout,
 * which is the CI runner. A gate whose result depends on that is not reporting
 * on the code. Resolving the binary in the local tree first moves the failure
 * to every machine equally, and to the one place it is cheap to fix.
 *
 * Scoped to the launchers that *have* such a cache ({@link
 * execUsesGlobalCache}): `pnpm exec` and `yarn` resolve from the project tree
 * already, and pre-flighting Yarn PnP — which has no `node_modules/.bin` — would
 * report every tool missing. `null` means the check may spawn.
 */
export function missingToolOutcome(
  slot: string,
  adapter: Adapter,
  args: readonly string[],
  ctx: { cwd: string; pm: PackageManager },
): CheckOutcome | null {
  if (!execUsesGlobalCache(ctx.pm)) return null;
  const tool = execTool(adapter.command, args);
  if (!tool || resolveSlotTool(ctx.cwd, tool)) return null;
  const stderr = [
    `checkride: the \`${slot}\` slot needs \`${tool}\`, which is not installed in this project.`,
    '',
    `  looked for: node_modules/.bin/${tool} (from ${ctx.cwd} up to the repo root)`,
    '',
    'checkride never fetches a tool mid-run, and a launcher cache can still supply',
    "one this repo never declared — so a tool that isn't a dependency here would",
    'pass on your machine and fail on a clean checkout. Declare it instead:',
    '',
    `  ${installCommand(ctx.pm, tool)}`,
    '',
  ].join('\n');
  // Exit 1, not -1. Nothing spawned, so there is no real status to report — but
  // -1 is reserved for a spawn failure or timeout, which `triage` discounts as
  // "a harness problem, not a finding" (see `docs/plugin.md`). An undeclared
  // tool is the opposite: the finding the run exists to surface, and the one
  // the reader has to act on. Reporting it as -1 would tell them to ignore it.
  return { ok: false, exit_code: 1, stdout: '', stderr };
}

/**
 * Fail the `prose` check when its configured `exemplars` directory is missing
 * or holds no files, rather than letting the tool pass while the anchor texts
 * rot away.
 *
 * The exemplars are the repo's hand-written voice reference: the AGENTS.md
 * stanza tells writing sessions to imitate them, so a config that names a
 * directory that no longer exists (renamed, deleted, never created) would leave
 * that instruction aimed at nothing while the check stayed green. Presence is
 * the whole assertion — checkride never scores prose against the exemplars;
 * that read belongs to a human. `null` means the check may spawn.
 */
export function missingExemplarsOutcome(adapter: Adapter, cwd: string): CheckOutcome | null {
  const dir = adapter.exemplars;
  if (dir === undefined) return null;
  let state: string | null = 'does not exist';
  try {
    const files = readdirSync(join(cwd, dir), { withFileTypes: true }).filter(
      (e) => e.isFile() && !e.name.startsWith('.'),
    );
    state = files.length > 0 ? null : 'has no files in it';
  } catch (error) {
    // Unreadable reads as missing. A file sitting at the path is named for what
    // it is — "does not exist" would send the reader hunting a typo that isn't
    // there.
    if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') state = 'is a file, not a directory';
  }
  if (state === null) return null;
  const stderr = [
    `checkride: the \`prose\` slot names \`${dir}\` as its voice exemplars, and that path ${state}.`,
    '',
    'Exemplars are hand-written prose the agent contract points writing sessions at',
    'as the voice to imitate, so a config naming an empty directory aims that',
    'instruction at nothing. Write a few short samples of prose in your own voice',
    'there (or fix the `exemplars` path in checkride.config.json), then re-run.',
    '',
  ].join('\n');
  // Exit 1 for the same reason as missingToolOutcome above: nothing spawned,
  // but this is the finding the run exists to surface, not a harness problem.
  return { ok: false, exit_code: 1, stdout: '', stderr };
}

/**
 * The runner `runChecks` uses when none is injected: the `links` built-in
 * in-process, the other built-ins through `runBuiltin`, and everything else
 * spawned under the resolved package manager — after the pre-flights that
 * refuse to spawn at all (`missingExemplarsOutcome`, `missingToolOutcome`).
 */
export const defaultRunner: CheckRunner = (resolved, ctx) => {
  const adapter = resolved.adapter;
  if (!adapter) return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  if (adapter.builtin === 'links') {
    return checkLinks(ctx.cwd, { exclude: adapter.exclude, allowlist: adapter.allowlist });
  }
  const timeout = adapter.timeout ?? ctx.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const builtin = runBuiltin(adapter, ctx, timeout);
  if (builtin) return builtin;
  const missingExemplars = missingExemplarsOutcome(adapter, ctx.cwd);
  if (missingExemplars) return Promise.resolve(missingExemplars);
  const declared = runtimeArgs(adapter, ctx.changed);
  const missing = missingToolOutcome(resolved.slot, adapter, declared, ctx);
  if (missing) return Promise.resolve(missing);
  const { command, args } = translateExec(adapter.command, declared, ctx.pm);
  return spawnCheck(command, args, ctx.cwd, timeout);
};
