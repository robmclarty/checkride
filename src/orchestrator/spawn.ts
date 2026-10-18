/**
 * Process lifecycle for one check: the default runner, the built-in dispatch,
 * the pre-flights that refuse to spawn at all, the spawn itself with its
 * timeout and UTF-8 capture, and the registry of live process groups the CLI
 * reaps on a fatal signal. The interrupt latch lives here too, beside the two
 * functions that read it and the two that set it.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import type { Adapter } from '../adapters.js';
import { CHECK_DIR } from '../artifacts/index.js';
import { DEFAULT_BASE } from '../git.js';
import type { LaunchContext, Spawn } from '../launch/index.js';
import { commandBin, launchCheck } from '../launch/index.js';
import type { CheckOutcome } from '../links.js';
import { checkLinks } from '../links.js';
import { checkPack } from '../pack.js';
import { KILL_GRACE_SECONDS, killGroup } from '../proc.js';
import { checkSecurity } from '../security.js';
import { checkSmoke } from '../smoke.js';
import { checkSnippets } from '../snippets.js';
import { checkUnclaimed } from '../targets/index.js';
import type { CheckRunner, RunnerOutcome } from './types.js';

/** The placeholder in `changedArgs` that expands to the base ref a `--changed` run measures from. */
const BASE_PLACEHOLDER = '{base}';

/** The placeholder in any arg that expands to the check's own artifact directory. */
const OUT_PLACEHOLDER = '{out}';

/**
 * The args a check runs with: its `args`, plus its `changedArgs` under
 * `--changed`, with `{base}` in each expanded to `base`, the ref the run
 * measures changes from, and `{out}` in all of them to `out`, the output
 * directory. `base` is `null` off `--changed`. `out` defaults to the relative
 * `CHECK_DIR`, so vitest's `--outputFile={out}/test.json` spawns the argv 0.13
 * did; a run given `--out` passes the absolute directory instead.
 */
export function runtimeArgs(adapter: Adapter, base: string | null, out: string = CHECK_DIR): string[] {
  const changed = base === null || !adapter.changedArgs ? [] : adapter.changedArgs.map((arg) => arg.replaceAll(BASE_PLACEHOLDER, base));
  return [...adapter.args, ...changed].map((arg) => arg.replaceAll(OUT_PLACEHOLDER, out));
}

/**
 * The base a runner's `{base}` expands to: the run's resolved base under
 * `--changed`, or `null` off it. A context built without one, by a caller that
 * never resolved a base, measures from the default the way 0.13 did.
 */
function changedRef(ctx: { changed: boolean; base?: string }): string | null {
  if (!ctx.changed) return null;
  return ctx.base ?? DEFAULT_BASE;
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
 * starts. `env` sets variables over the inherited environment, such as the
 * ones that keep mise from installing a tool.
 */
function spawnCheck(
  command: string,
  args: string[],
  cwd: string,
  timeoutSec?: number,
  env: Readonly<Record<string, string>> = {},
): Promise<CheckOutcome> {
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
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
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
 * Spawn a check's own tool, and record on its outcome the argv handed to
 * `spawn` and the pin source it resolved through, with the version a file read
 * found, so the summary can say exactly what ran and which copy. A tool that
 * fails to start or times out keeps both, since that's what failed. After an
 * interrupt `spawnCheck` starts nothing, so nothing is recorded; `started`
 * reads the latch just before `spawnCheck` does, so the two agree. The
 * built-ins spawn through `spawnCheck` directly and record none: their
 * processes are checkride's own, and a built-in may start several or none.
 */
async function spawnTool(launch: Spawn, cwd: string, timeoutSec: number): Promise<RunnerOutcome> {
  const started = !interrupted;
  const outcome = await spawnCheck(launch.command, launch.args, cwd, timeoutSec, launch.env);
  if (!started) return outcome;
  const pin = launch.pin === undefined
    ? {}
    : { pin_source: launch.pin.source, ...(launch.pin.version !== undefined ? { tool_version: launch.pin.version } : {}) };
  return { ...outcome, argv: [launch.command, ...launch.args], ...pin };
}

/**
 * What the launcher reads to resolve a check's tool: where it runs, the repo
 * root a pin search stops at, its package manager and pin chain, whether an
 * unpinned tool fails, and the variables its pack sets.
 */
function launchContext(ctx: Parameters<CheckRunner>[1]): LaunchContext {
  return {
    cwd: ctx.cwd,
    pm: ctx.pm,
    ...(ctx.repo !== undefined ? { repo: ctx.repo } : {}),
    ...(ctx.pins !== undefined ? { pins: ctx.pins } : {}),
    ...(ctx.requirePins !== undefined ? { requirePins: ctx.requirePins } : {}),
    ...(ctx.packEnv !== undefined ? { packEnv: ctx.packEnv } : {}),
    ...(ctx.overrides !== undefined ? { overrides: ctx.overrides } : {}),
    ...(ctx.staticOnly === true ? { staticOnly: true } : {}),
  };
}

/** What a built-in runs with: its adapter, the runner's context, and the spawn and timeout its subprocesses go through. */
type BuiltinCall = {
  adapter: Adapter;
  ctx: Parameters<CheckRunner>[1];
  base: { cwd: string; spawn: typeof spawnCheck; timeoutSec: number };
};

/**
 * `security` runs the adapter's own args, launched like any check's: its
 * `--audit-level` doubles as the threshold the evaluator enforces, since
 * pnpm's JSON-mode exit code ignores the level.
 */
function runSecurity({ adapter, ctx, base }: BuiltinCall): Promise<CheckOutcome> {
  const launch = launchCheck(adapter.slot, adapter.command, runtimeArgs(adapter, changedRef(ctx), ctx.out), launchContext(ctx));
  if ('refusal' in launch) return Promise.resolve(refusedOutcome(launch.refusal, ctx));
  return checkSecurity({ ...base, command: launch.command, args: launch.args });
}

/**
 * Every built-in that spawns or reads in-process, by its `builtin` id, apart
 * from `links`, which the runner calls first. The snippets pair shares one
 * execution path, differing only in mode, and `unclaimed` checks against the
 * targets its options carry, leaving out what it writes under `{out}`.
 */
const BUILTINS: ReadonlyMap<string, (call: BuiltinCall) => Promise<CheckOutcome>> = new Map([
  ['pack', ({ ctx, base }) => checkPack({ ...base, pm: ctx.pm })],
  ['smoke', ({ base }) => checkSmoke(base)],
  ['security', runSecurity],
  ['snippets', ({ ctx, base }) => checkSnippets({ ...base, mode: 'src', pm: ctx.pm })],
  ['snippets-dist', ({ ctx, base }) => checkSnippets({ ...base, mode: 'dist', pm: ctx.pm })],
  [
    'unclaimed',
    ({ adapter, ctx }) => checkUnclaimed(ctx.cwd, { targets: [], ...adapter.options?.unclaimed, ...(ctx.out !== undefined ? { out: ctx.out } : {}) }),
  ],
]);

/**
 * Dispatch a built-in check, or `null` when the adapter spawns a real tool.
 * Every built-in that runs a subprocess goes through `spawnCheck`, so its
 * child registers in `liveChecks` and inherits the timeout + reaping like any
 * other check.
 */
function runBuiltin(adapter: Adapter, ctx: Parameters<CheckRunner>[1], timeout: number): Promise<CheckOutcome> | null {
  const run = adapter.builtin === undefined ? undefined : BUILTINS.get(adapter.builtin);
  return run === undefined ? null : run({ adapter, ctx, base: { cwd: ctx.cwd, spawn: spawnCheck, timeoutSec: timeout } });
}

/**
 * The outcome a check records when the launcher refuses to spawn it: the
 * launcher's message on stderr, and exit 1.
 *
 * Exit 1, not -1. Nothing spawned, so there is no real status to report — but
 * -1 is reserved for a spawn failure or timeout, which `triage` discounts as
 * "a harness problem, not a finding" (see `docs/plugin.md`). A refusal is the
 * opposite, an undeclared tool most often: the finding the run exists to
 * surface, and the one the reader has to act on. Reporting it as -1 would tell
 * them to ignore it.
 */
/** A refusal's first line, its `checkride: ` prefix and closing period dropped, as a skip reason quotes it. */
function refusalDetail(refusal: string): string {
  const first = refusal.split('\n').find((line) => line.trim() !== '') ?? refusal;
  return first.replace(/^checkride:\s*/, '').replace(/\.$/, '');
}

function refusedOutcome(refusal: string, ctx: Parameters<CheckRunner>[1]): CheckOutcome {
  // Under --static-only, a tool that needs an install is a skip, not a failure (R6.2).
  if (ctx.staticOnly === true) return { ok: true, exit_code: 0, stdout: '', stderr: '', skip: `static-only: needs an install (${refusalDetail(refusal)})` };
  return { ok: false, exit_code: 1, stdout: '', stderr: refusal };
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
  const dir = adapter.options?.prose?.exemplars;
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
  // Exit 1 for the same reason as refusedOutcome above: nothing spawned, but
  // this is the finding the run exists to surface, not a harness problem.
  return { ok: false, exit_code: 1, stdout: '', stderr };
}

/**
 * Fail a check whose adapter reads a directory a setup step writes, such as
 * the `.terraform/` that `terraform init -backend=false` fills, where that
 * directory is missing, naming the step rather than spawning a tool that would
 * report every provider missing and point at a step that reaches the network.
 * The step is run with the CLI the check would, so it reads `tofu init` where
 * the repo runs OpenTofu. Checks never run it themselves (R6.4). `null` means
 * the check may spawn.
 */
function missingSetupOutcome(adapter: Adapter, ctx: Parameters<CheckRunner>[1]): CheckOutcome | null {
  const setup = adapter.setup;
  if (setup === undefined) return null;
  const moved = setup.variable === undefined ? undefined : process.env[setup.variable];
  const dir = moved !== undefined && moved !== '' ? moved : setup.dir;
  if (existsSync(resolvePath(ctx.cwd, dir))) return null;
  const step = [commandBin(adapter.command, launchContext(ctx)), ...setup.args].join(' ');
  return refusedOutcome(`checkride: ${adapter.name} reads ${dir}/, which \`${step}\` writes, and checks never run it: run \`${step}\` here first.\n`, ctx);
}

/**
 * The runner `runChecks` uses when none is injected: the `links` built-in
 * in-process, the other built-ins through `runBuiltin`, and everything else
 * spawned as the launcher resolves it through the check's pin chain, unless a
 * pre-flight refuses to spawn it at all: `missingExemplarsOutcome`, the
 * launcher's own refusal (a tool the project never installed, a pin whose
 * source can't run it, an unpinned tool under `requirePins`), or
 * `missingSetupOutcome`. Only the path past all three spawns the check's own
 * tool, so only it records `argv` and the pin.
 */
export const defaultRunner: CheckRunner = (resolved, ctx) => {
  const adapter = resolved.adapter;
  if (!adapter) return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  if (adapter.builtin === 'links') return checkLinks(ctx.cwd, adapter.options?.links);
  const timeout = adapter.timeout ?? ctx.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const builtin = runBuiltin(adapter, ctx, timeout);
  if (builtin) return builtin;
  const missingExemplars = missingExemplarsOutcome(adapter, ctx.cwd);
  if (missingExemplars) return Promise.resolve(missingExemplars);
  const launch = launchCheck(resolved.slot, adapter.command, runtimeArgs(adapter, changedRef(ctx), ctx.out), launchContext(ctx));
  if ('refusal' in launch) return Promise.resolve(refusedOutcome(launch.refusal, ctx));
  const missingSetup = missingSetupOutcome(adapter, ctx);
  if (missingSetup) return Promise.resolve(missingSetup);
  return spawnTool(launch, ctx.cwd, timeout);
};
