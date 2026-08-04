/**
 * The check orchestrator.
 *
 * Resolves slots to adapters, selects which to run (flags), spawns each command
 * (or runs a built-in), captures raw output to `.check/`, and writes the
 * aggregate `.check/summary.json`. The orchestrator stays dumb: it never parses
 * diagnostics — agents read the per-tool JSON directly.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Adapter, Order, Slot } from './adapters.js';
import { ADAPTERS, SCHEMA_VERSION, SLOTS } from './adapters.js';
import { writeFileAtomic } from './atomic.js';
import type { Baseline, Fingerprint } from './baseline/index.js';
import {
  applyBaseline,
  BASELINE_FILE,
  baselinesEqual,
  countBaselineKeys,
  fallowVerdict,
  fingerprint,
  loadBaseline,
  ratchet,
  writeBaseline,
} from './baseline/index.js';
import type { CheckrideConfig, ResolvedCheck } from './config.js';
import { loadConfig, resolveChecks } from './config.js';
import { writeDigest } from './digest/index.js';
import type { CheckOutcome } from './links.js';
import { checkLinks } from './links.js';
import { checkPack } from './pack.js';
import type { PackageManager } from './pm/index.js';
import {
  detectPackageManager,
  execTool,
  execUsesGlobalCache,
  installCommand,
  isAvailableUnder,
  resolveSlotTool,
  translateExec,
} from './pm/index.js';
import { KILL_GRACE_SECONDS, killGroup } from './proc.js';
import { checkSecurity } from './security.js';
import { checkSmoke } from './smoke.js';
import { checkSnippets } from './snippets.js';
import { parseToolJson } from './tool-json.js';

/** Minimal writable sink (satisfied by `process.stdout`/`process.stderr`). */
export type Out = { write(text: string): unknown };

/** Selection and output flags for a run. */
export type RunFlags = {
  bail?: boolean;
  json?: boolean;
  changed?: boolean;
  all?: boolean;
  only?: string[] | null;
  skip?: string[] | null;
  include?: string[] | null;
  /** Write a capped failure excerpt to `.check/digest.md`. */
  digest?: boolean;
  /**
   * Treat zero checks actually executing as an error (exit 2), not a vacuous
   * pass. For consumers that gate on the exit code (plumbbob, CI); a human
   * exploring a fresh repo keeps the default warning-only behavior.
   */
  strict?: boolean;
  /**
   * Max checks running at once within a wave (equal-`order` group). Omitted →
   * {@link defaultConcurrency}; `1` runs the whole pipeline sequentially. Ignored
   * under `--bail`, which is fail-fast sequential by definition — a
   * `> 1` value passed alongside `--bail` earns a one-line stderr note.
   */
  concurrency?: number;
};

/** A single check in the aggregate report. */
export type SummaryCheck = {
  name: string;
  adapter: string | null;
  description: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  exit_code: number | null;
  duration_ms: number;
  output_file: string | null;
  /**
   * Present only when a baseline masked one or more of this slot's diagnostics:
   * the count of current findings grandfathered by `checkride.baseline.json`.
   * Additive field — absent on runs with no baseline, so `schema_version` holds.
   */
  baselined?: number;
};

/** The `.check/summary.json` contract. A public API for agents. */
export type Summary = {
  schema_version: number;
  timestamp: string;
  ok: boolean;
  /**
   * Count of checks that actually executed (skipped entries excluded).
   * `ok: true` with `checks_run: 0` is a vacuous green — nothing was verified.
   * Additive field; `schema_version` holds.
   */
  checks_run: number;
  total_duration_ms: number;
  checks: SummaryCheck[];
};

/** Low-level runner: executes one active check and returns its raw outcome. */
export type CheckRunner = (
  resolved: ResolvedCheck,
  ctx: { cwd: string; changed: boolean; pm: PackageManager; timeout?: number },
) => Promise<CheckOutcome>;

export type RunOptions = RunFlags & {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stdout?: Out;
  stderr?: Out;
  runner?: CheckRunner;
  /** Package manager to run under; detected from `cwd` when omitted. */
  pm?: PackageManager;
  /**
   * Baseline to mask/ratchet against. Omitted → loaded from
   * `cwd/checkride.baseline.json`; `null` → run with no baseline (a `checkride
   * baseline` capture passes this so it records raw diagnostics). Injectable so
   * tests drive baseline-aware runs without a committed file.
   */
  baseline?: Baseline | null;
};

/**
 * One executed check: its slot, the adapter that ran, and the raw outcome. The
 * `baseline` command reads these to fingerprint each fingerprintable slot's
 * output — the same bytes a normal run captures — without re-walking the loop.
 * Skipped checks never appear here; they produced no output to fingerprint.
 */
export type CheckRun = { slot: string; adapter: Adapter; outcome: CheckOutcome };

export type RunResult = { ok: boolean; summary: Summary; exitCode: number; runs: CheckRun[] };

/**
 * Only/skip/opt-in selection by slot name.
 * An opt-in slot runs when `--all`/`--include` names it, or when it was
 * explicitly configured in `checks` (`r.explicit`) — naming a slot is opting in.
 */
export function selectChecks(resolved: readonly ResolvedCheck[], flags: RunFlags): ResolvedCheck[] {
  const only = flags.only ?? null;
  const skipSet = new Set(flags.skip ?? []);
  const includeSet = new Set(flags.include ?? []);
  const all = flags.all ?? false;
  return resolved.filter((r) => {
    if (only) return only.includes(r.slot);
    if (skipSet.has(r.slot)) return false;
    if (r.optIn && !all && !includeSet.has(r.slot) && !r.explicit) return false;
    return true;
  });
}

/**
 * Reject bad slot selections in `--only`/`--skip`/`--include`. A typo like
 * `--only lints` would otherwise slip through `selectChecks` as a filter that matched
 * nothing, silently disabling the gate — the worst kind of vacuous green in a
 * definition-of-done check. It is a usage error instead (thrown here, surfaced
 * as exit 2 at the CLI). The valid set is every resolved slot: the catalogue
 * slots plus any config custom-check names.
 *
 * A *present but empty* list is rejected for the same reason. `[]` is truthy,
 * so `selectChecks` reads it as "match nothing" rather than "no filter", and an
 * empty `only` selects zero checks. The CLI already rejects `--only ,` when it
 * parses (see `parseList`); this covers the programmatic API, where a caller can
 * hand `runChecks` an array it computed. `selectChecks` itself is left alone —
 * it is exported public surface, and the error belongs before it runs.
 */
function validateSelection(resolved: readonly ResolvedCheck[], flags: RunFlags): void {
  const valid = new Set(resolved.map((r) => r.slot));
  for (const flag of ['only', 'skip', 'include'] as const) {
    const names = flags[flag];
    if (names === undefined || names === null) continue;
    if (names.length === 0) {
      throw new Error(`--${flag} was given an empty list, which selects nothing. Valid slots: ${[...valid].join(', ')}.`);
    }
    const unknown = names.filter((name) => !valid.has(name));
    if (unknown.length === 0) continue;
    const named = unknown.map((n) => `'${n}'`).join(', ');
    const noun = unknown.length > 1 ? 'slots' : 'slot';
    throw new Error(`unknown ${noun} ${named} in --${flag}. Valid slots: ${[...valid].join(', ')}.`);
  }
}

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

const defaultRunner: CheckRunner = (resolved, ctx) => {
  const adapter = resolved.adapter;
  if (!adapter) return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  if (adapter.builtin === 'links') {
    return checkLinks(ctx.cwd, { exclude: adapter.exclude, allowlist: adapter.allowlist });
  }
  const timeout = adapter.timeout ?? ctx.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const builtin = runBuiltin(adapter, ctx, timeout);
  if (builtin) return builtin;
  const declared = runtimeArgs(adapter, ctx.changed);
  const missing = missingToolOutcome(resolved.slot, adapter, declared, ctx);
  if (missing) return Promise.resolve(missing);
  const { command, args } = translateExec(adapter.command, declared, ctx.pm);
  return spawnCheck(command, args, ctx.cwd, timeout);
};

/**
 * Persist raw output atomically: JSON to `.check/<outputFile>`, else
 * stdout/stderr text.
 *
 * Returns the JSON file it wrote, or `null` when it fell through to text — the
 * summary's `output_file` is that return value, never the adapter's
 * *declaration*. A slot that declares an `outputFile` does not always produce
 * one (the tool printed a warning first, crashed, or emitted plain text this
 * run), and naming a file that was never written sends every consumer to an
 * ENOENT while the real bytes sit in `<slot>.stdout.txt` beside it.
 */
async function persistOutput(cwd: string, adapter: Adapter, outcome: CheckOutcome): Promise<string | null> {
  const dir = join(cwd, '.check');
  if (adapter.outputFile && outcome.stdout.trim()) {
    // Tolerates a launcher preamble ahead of the JSON; writes the tool's own
    // bytes from the first JSON character on, so the artifact actually parses.
    const parsed = parseToolJson(outcome.stdout);
    if (parsed) {
      await writeFileAtomic(join(dir, adapter.outputFile), parsed.text);
      return adapter.outputFile;
    }
  }
  if (outcome.stdout.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stdout.txt`), outcome.stdout);
  if (outcome.stderr.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stderr.txt`), outcome.stderr);
  return null;
}

/**
 * Remove a slot's prior `.check/` artifacts before it re-runs, so a later clean
 * run that emits nothing — or a different stream/form than last time — can't leave
 * the previous run's output lingering as authoritative. Covers everything
 * `persistOutput` writes (`<slot>.stdout.txt`, `<slot>.stderr.txt`, the adapter's
 * JSON `outputFile`) plus the conventional `<slot>.json` a tool may write itself
 * (e.g. vitest's `--outputFile=.check/test.json`, where `outputFile` is null).
 * Runs *before* the check so this run's own tool-written artifacts survive.
 */
async function clearSlotOutputs(cwd: string, adapter: Adapter): Promise<void> {
  const dir = join(cwd, '.check');
  const names = new Set([
    `${adapter.slot}.stdout.txt`,
    `${adapter.slot}.stderr.txt`,
    `${adapter.slot}.json`,
  ]);
  if (adapter.outputFile) names.add(adapter.outputFile);
  await Promise.all([...names].map((f) => rm(join(dir, f), { force: true })));
}

function writeLine(out: Out, line: string): void {
  out.write(`${line}\n`);
}

/**
 * Width of the slot-name column, measured from the names this run will print
 * (never below the historical 8). A fixed 8 was sized for catalogue slots, and
 * a config custom check — `typecheck-tests` is 15 — pushed the duration and
 * description columns right on its row alone.
 */
function nameWidth(selected: readonly ResolvedCheck[]): number {
  return selected.reduce((n, r) => Math.max(n, r.slot.length), 8);
}

function formatStatusLine(check: SummaryCheck, width: number): string {
  const mark = check.ok ? '✔' : '✘';
  const name = check.name.padEnd(width);
  const duration = `${check.duration_ms}ms`.padStart(8);
  return `  ${mark} ${name} ${duration}  ${check.description}`;
}

function skippedEntry(resolved: ResolvedCheck): SummaryCheck {
  return {
    name: resolved.slot,
    adapter: resolved.adapter?.name ?? null,
    description: resolved.adapter?.description ?? resolved.slot,
    ok: true,
    skipped: true,
    reason: resolved.skip ?? 'skipped',
    exit_code: null,
    duration_ms: 0,
    // A skipped check ran nothing and wrote nothing; naming its adapter's
    // declared output file would point at whatever an earlier run left there.
    output_file: null,
  };
}

/**
 * `total_duration_ms` is the wall-clock span of the whole execution phase,
 * not the sum of per-check durations — under concurrency those diverge, and
 * wall-clock is what the field honestly means. It equals the per-check sum
 * whenever execution is sequential (one check in flight at a time).
 */
function buildSummary(checks: SummaryCheck[], totalDurationMs: number): Summary {
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks_run: checks.filter((c) => !c.skipped).length,
    total_duration_ms: totalDurationMs,
    checks,
  };
}

/** What could fill a sat-out slot: each candidate adapter and its first detect file. */
function enableHint(slot: string, adapters: readonly Adapter[]): string | null {
  const candidates = adapters.filter((a) => a.slot === slot);
  if (candidates.length === 0) return null;
  const parts = candidates.map((a) =>
    a.detect.length > 0 ? `${a.name} (add ${a.detect[0]})` : a.name,
  );
  return `enable with: ${parts.join(', ')}`;
}

/**
 * The first-party vacuous-green signal: "green because nothing ran" must be
 * unmissable, not something only a consumer that hand-rolls its own check can
 * distinguish from "green because everything passed".
 * Names why each slot sat out and what would enable it.
 */
function warnVacuous(
  stderr: Out,
  checks: readonly SummaryCheck[],
  adapters: readonly Adapter[],
): void {
  writeLine(stderr, '');
  writeLine(stderr, '⚠ 0 checks ran — nothing was verified. This is not a pass.');
  if (checks.length === 0) {
    writeLine(stderr, '  No slots matched the selection (--only/--skip).');
  }
  for (const c of checks) {
    const hint = c.adapter === null ? enableHint(c.name, adapters) : null;
    writeLine(stderr, `  ○ ${c.name}: ${c.reason ?? 'skipped'}${hint ? ` — ${hint}` : ''}`);
  }
  writeLine(stderr, '  Run `checkride doctor` for per-slot detail, or add a custom check to');
  writeLine(stderr, '  checkride.config.json. Gates should run with --strict (exit 2 on zero checks).');
}

/** Options shared by every command entry point (`runChecks`/`runFix`/`runDoctor`). */
type CommonOptions = {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stdout?: Out;
  stderr?: Out;
};

/** The resolved form of {@link CommonOptions}: defaults applied, config loaded. */
type CommonContext = {
  cwd: string;
  slots: readonly Slot[];
  adapters: readonly Adapter[];
  config: CheckrideConfig | null;
  stdout: Out;
  stderr: Out;
};

/**
 * Apply the defaults every command shares: cwd, the slot/adapter catalogues, the
 * config (loaded from `cwd` unless injected), and the two streams, so
 * `runChecks`/`runFix`/`runDoctor` resolve this identical block one way.
 */
export function resolveCommonOptions(options: CommonOptions): CommonContext {
  const cwd = options.cwd ?? process.cwd();
  return {
    cwd,
    slots: options.slots ?? SLOTS,
    adapters: options.adapters ?? ADAPTERS,
    config: options.config !== undefined ? options.config : loadConfig(cwd),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
}

/** The resolved run environment: {@link CommonContext} plus the run-only options. */
type RunContext = CommonContext & {
  runner: CheckRunner;
  json: boolean;
  bail: boolean;
  changed: boolean;
  timeout: number | undefined;
  pm: PackageManager;
  baseline: Baseline | null;
  /** Effective wave pool width (see {@link defaultConcurrency}); unused under `bail`. */
  concurrency: number;
  /** Slot-name column width for this run's status lines (see {@link nameWidth}). */
  nameWidth: number;
};

/**
 * Apply every run default: the common options plus runner, flags, PM, and
 * baseline. `nameWidth` is a placeholder here — the selection it measures is
 * not known until after `selectChecks`, so `runChecks` narrows it then.
 */
function resolveRunContext(options: RunOptions): RunContext {
  const common = resolveCommonOptions(options);
  return {
    ...common,
    nameWidth: 8,
    runner: options.runner ?? defaultRunner,
    json: options.json ?? false,
    bail: options.bail ?? false,
    changed: options.changed ?? false,
    timeout: common.config?.timeout,
    pm: options.pm ?? detectPackageManager({ cwd: common.cwd }),
    baseline: options.baseline !== undefined ? options.baseline : loadBaseline(common.cwd),
    concurrency: Math.max(1, Math.floor(options.concurrency ?? defaultConcurrency())),
  };
}

/** One slot's baseline-masked verdict, plus the fingerprint to feed the ratchet (null = don't observe). */
type MaskResult = {
  ok: boolean;
  baselined: number;
  newKeys: string[];
  reason: string | null;
  observed: Fingerprint | null;
};

/**
 * Baseline-aware verdict for one slot's outcome. fallow slots derive pass/fail
 * from the parsed report (its exit code doesn't reliably gate); everything else
 * masks the adapter's fingerprint. `observed` is non-null only when the run's
 * findings could be read — the ratchet must never prune from an unreadable run.
 */
function maskOutcome(adapter: Adapter, outcome: CheckOutcome, baseline: Baseline | null, slot: string): MaskResult {
  if (adapter.gate === 'fallow') {
    const v = fallowVerdict(outcome.stdout, baseline ? (baseline.slots[slot] ?? []) : null);
    return { ok: v.ok, baselined: v.baselined, newKeys: v.newKeys, reason: v.reason, observed: v.observed ? v.findings : null };
  }
  const current = baseline ? fingerprint(adapter.name, outcome.stdout) : null;
  if (baseline && current !== null) {
    const adj = applyBaseline(current, baseline.slots[slot] ?? [], outcome.ok);
    return { ok: adj.ok, baselined: adj.baselined, newKeys: adj.newKeys, reason: null, observed: current };
  }
  return { ok: outcome.ok, baselined: 0, newKeys: [], reason: null, observed: null };
}

/** Build (and print) the skipped-entry row for a slot that won't run this pass. */
function handleSkip(r: ResolvedCheck, unavailable: boolean, ctx: RunContext): SummaryCheck {
  const entry = skippedEntry(
    unavailable ? { ...r, skip: `'${r.adapter?.command} ${r.adapter?.args[0]}' is unavailable under ${ctx.pm}` } : r,
  );
  if (!ctx.json) writeLine(ctx.stderr, `  ○ ${entry.name.padEnd(ctx.nameWidth)}      skip  ${entry.reason ?? ''}`);
  return entry;
}

/** Print one check's status line, its baselined count, and any new (non-grandfathered) findings. */
function reportCheckResult(stderr: Out, entry: SummaryCheck, mask: MaskResult, width: number): void {
  writeLine(stderr, formatStatusLine(entry, width));
  if (mask.baselined > 0) writeLine(stderr, `           ${mask.baselined} baselined (grandfathered)`);
  if (!entry.ok && mask.reason) writeLine(stderr, `           ${mask.reason}`);
  if (!entry.ok && mask.newKeys.length > 0) {
    writeLine(stderr, `           ${mask.newKeys.length} new, not in baseline:`);
    for (const k of mask.newKeys) writeLine(stderr, `             ${k}`);
  }
}

/** Run one active check: clear stale output, run it, persist, and mask against the baseline. */
async function runOneCheck(
  r: ResolvedCheck,
  adapter: Adapter,
  ctx: RunContext,
): Promise<{ entry: SummaryCheck; run: CheckRun; mask: MaskResult }> {
  if (!ctx.json) writeLine(ctx.stderr, `  ▸ ${r.slot}  ${adapter.description}`);
  // Wipe this slot's stale `.check/` artifacts before it runs, so a leaner re-run
  // can't leave last run's output behind as authoritative — and so any artifact
  // the tool writes during *this* run (e.g. `test.json`) survives.
  await clearSlotOutputs(ctx.cwd, adapter);
  const start = performance.now();
  const outcome = await ctx.runner(r, { cwd: ctx.cwd, changed: ctx.changed, pm: ctx.pm, ...(ctx.timeout !== undefined ? { timeout: ctx.timeout } : {}) });
  const duration_ms = Math.round(performance.now() - start);
  const outputFile = await persistOutput(ctx.cwd, adapter, outcome);

  // Masking is always on (even under a partial run); only the ratchet is gated.
  // The raw `.check/<slot>.json` is persisted untouched — masking changes the
  // pass/fail verdict, never the authoritative output.
  const mask = maskOutcome(adapter, outcome, ctx.baseline, r.slot);
  const entry: SummaryCheck = {
    name: r.slot,
    adapter: adapter.name,
    description: adapter.description,
    ok: mask.ok,
    exit_code: outcome.exit_code,
    duration_ms,
    output_file: outputFile,
    ...(mask.baselined > 0 ? { baselined: mask.baselined } : {}),
  };
  return { entry, run: { slot: r.slot, adapter, outcome }, mask };
}

/**
 * One selected check's result, decoupled from where it lands in the report. The
 * scheduler runs checks concurrently, so a check can't push itself onto shared
 * accumulators as it finishes — that would order the report by completion, not by
 * the deterministic selection order. Instead each yields this and the caller
 * assembles the report in `selected` order.
 */
type CheckResult = {
  entry: SummaryCheck;
  /** The raw run (for the ratchet + digest); null for a skipped slot. */
  run: CheckRun | null;
  /** Fingerprint to feed the ratchet, keyed by slot; null when nothing was observed. */
  observed: { slot: string; fp: Fingerprint } | null;
};

/**
 * Run one selected check to a {@link CheckResult} — the concurrency-safe core
 * shared by the sequential (`--bail`) and wave paths. A skipped/unavailable slot
 * records a skip row and runs nothing; an active one runs, prints its status
 * line, and reports its fingerprint for the ratchet. It mutates no shared state,
 * so N of these can be in flight at once.
 */
async function runSelectedCheck(r: ResolvedCheck, ctx: RunContext): Promise<CheckResult> {
  // Skip when unresolved, or when the adapter can't run under this PM — e.g.
  // `pnpm audit` (the `security` slot) is unavailable off pnpm.
  const unavailable = Boolean(r.adapter && !isAvailableUnder(r.adapter.command, r.adapter.args, ctx.pm));
  if (r.skip || !r.adapter || unavailable) {
    return { entry: handleSkip(r, unavailable, ctx), run: null, observed: null };
  }
  const { entry, run, mask } = await runOneCheck(r, r.adapter, ctx);
  if (!ctx.json) reportCheckResult(ctx.stderr, entry, mask, ctx.nameWidth);
  return { entry, run, observed: mask.observed !== null ? { slot: r.slot, fp: mask.observed } : null };
}

/** The run accumulators every execution path fills. */
type Execution = {
  checks: SummaryCheck[];
  runs: CheckRun[];
  observed: Map<string, Fingerprint>;
  brokeEarly: boolean;
};

/** Fold one result into the report accumulators, in call order. */
function collect(res: CheckResult, acc: Execution): void {
  acc.checks.push(res.entry);
  if (res.run) acc.runs.push(res.run);
  if (res.observed) acc.observed.set(res.observed.slot, res.observed.fp);
}

/** A fresh, empty {@link Execution}. */
function emptyExecution(brokeEarly = false): Execution {
  return { checks: [], runs: [], observed: new Map(), brokeEarly };
}

/**
 * Scheduling coordinates for a check on the order line: the group `rank` (firsts 0,
 * the numeric line 1, singles 2, lasts 3) and its position on the numeric line
 * (`'any'`/`'middle'` sit at 0 — the conservative placement). This must agree
 * with `config.ts`'s group sort, which already put `selected` in exactly this
 * sequence; here it only re-derives the wave *boundaries* the sort collapsed.
 */
const SINGLE_RANK = 2;
function scheduleGroup(order: Order): { rank: number; line: number } {
  if (order === 'first') return { rank: 0, line: 0 };
  if (order === 'single') return { rank: SINGLE_RANK, line: 0 };
  if (order === 'last') return { rank: 3, line: 0 };
  return { rank: 1, line: typeof order === 'number' ? order : 0 };
}

/**
 * Split the already-sorted `selected` into execution waves: the `'first'` group,
 * each distinct numeric value, and the `'last'` group each become one concurrent
 * wave, with a barrier between waves; every `'single'` is its own wave so it runs
 * with nothing else in flight. Adjacent items share a wave only when their (rank,
 * line) match and neither is a single.
 */
function partitionWaves<T extends { r: ResolvedCheck }>(items: readonly T[]): T[][] {
  const waves: T[][] = [];
  let current: T[] = [];
  let prev: { rank: number; line: number } | null = null;
  for (const item of items) {
    const g = scheduleGroup(item.r.order ?? 'any');
    const sameWave = prev !== null && prev.rank === g.rank && prev.line === g.line && g.rank !== SINGLE_RANK;
    if (!sameWave && current.length > 0) {
      waves.push(current);
      current = [];
    }
    current.push(item);
    prev = g;
  }
  if (current.length > 0) waves.push(current);
  return waves;
}

/**
 * Run `items` through a pool `width` workers wide: each worker pulls the next
 * item until the queue drains, so at most `width` run at once. Concurrency is the
 * worker count; each worker still processes its own items one at a time. `width`
 * is clamped to at least 1 and never exceeds the item count.
 */
async function runPool<T>(items: readonly T[], width: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item === undefined) continue;
      // oxlint-disable-next-line no-await-in-loop -- a worker processes its items in sequence; concurrency is the `width` workers running this loop at once.
      await worker(item);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, () => runWorker());
  await Promise.all(workers);
}

/**
 * `--bail`: the flat sequential path. Checks run one at a time in group order
 * and the run stops at the first *executed* failure — fail-fast is
 * incompatible with already-launched concurrent work, so `--concurrency` is moot
 * here (the caller notes it if one was passed). For the default set (all `'any'`)
 * this is exactly the cheapest-first order.
 */
async function executeBail(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  const acc = emptyExecution();
  for (const r of selected) {
    // oxlint-disable-next-line no-await-in-loop -- --bail is fail-fast: checks run one at a time so the run can stop at the first failure.
    const res = await runSelectedCheck(r, ctx);
    collect(res, acc);
    if (res.run && !res.entry.ok) return { ...acc, brokeEarly: true };
  }
  return acc;
}

/**
 * The wave scheduler: run each wave's members concurrently through the pool,
 * with a barrier between waves. Results are placed by their `selected` index and
 * assembled in that order afterwards, so the report is deterministic regardless
 * of which check finishes first. Every selected check runs — there is no
 * early stop off the `--bail` path.
 */
async function executeWaves(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  const indexed = selected.map((r, i) => ({ r, i }));
  const results = Array.from<CheckResult | undefined>({ length: selected.length });
  for (const wave of partitionWaves(indexed)) {
    // oxlint-disable-next-line no-await-in-loop -- the between-values barrier: a wave runs to completion before the next distinct order value begins.
    await runPool(wave, ctx.concurrency, async ({ r, i }) => { results[i] = await runSelectedCheck(r, ctx); });
  }
  const acc = emptyExecution();
  for (const res of results) if (res) collect(res, acc);
  return acc;
}

/**
 * Run the selected checks, collecting rows, raw runs, observed fingerprints, and
 * `--bail` state. `--bail` takes the flat sequential path; every other run waves
 * on the effective `order` through a bounded pool.
 */
function executeChecks(selected: readonly ResolvedCheck[], ctx: RunContext): Promise<Execution> {
  return ctx.bail ? executeBail(selected, ctx) : executeWaves(selected, ctx);
}

/**
 * Whether this run saw less than the full pipeline — an `--only`/`--skip`/
 * `--changed` filter or an early `--bail` break. The ratchet is gated off for
 * these: an unobserved diagnostic must not be mistaken for a fixed one.
 */
function isPartialRun(options: RunOptions, changed: boolean, brokeEarly: boolean): boolean {
  return (options.only ?? null) !== null || (options.skip?.length ?? 0) > 0 || changed || brokeEarly;
}

/** On a fully-observed run, prune grandfathered diagnostics now fixed (shrink-only, atomic). */
async function maybeRatchet(
  cwd: string,
  baseline: Baseline | null,
  observed: ReadonlyMap<string, Fingerprint>,
  restricted: boolean,
  json: boolean,
  stderr: Out,
): Promise<void> {
  if (!baseline || restricted) return;
  const pruned = ratchet(baseline, observed);
  if (baselinesEqual(baseline, pruned)) return;
  await writeBaseline(cwd, pruned);
  if (!json) {
    writeLine(stderr, `\nbaseline: ratcheted ${BASELINE_FILE} to ${countBaselineKeys(pruned)} grandfathered diagnostic(s)`);
  }
}

/**
 * How much of the selection actually ran, said only when it was not all of it.
 *
 * `✔ all checks passed` is a true sentence about the checks that ran and a
 * misleading one about the repo, and the gap is invisible at exactly the moment
 * it matters most: a repo that configures almost nothing reports the same
 * confident green as one that configures everything. `--strict` does not catch
 * this, and cannot — its floor is *zero* checks, which a slot like `links` that
 * needs no tool keeps a repo off by itself.
 *
 * Only skipped slots are counted here. The per-slot `○ … skip <reason>` lines
 * are already on screen above; this is the one line someone scrolled past them
 * to read.
 */
function coverage(summary: Summary, checks: readonly SummaryCheck[]): string {
  const skipped = checks.length - summary.checks_run;
  if (skipped <= 0) return '';
  return ` — only ${summary.checks_run} of ${checks.length} checks ran, ${skipped} skipped`;
}

/** Print the human run summary: the vacuous-green warning, the status line, and artifact paths. */
function reportSummary(
  stderr: Out,
  summary: Summary,
  checks: readonly SummaryCheck[],
  adapters: readonly Adapter[],
  digestWritten: boolean,
): void {
  if (summary.checks_run === 0) warnVacuous(stderr, checks, adapters);
  writeLine(stderr, '');
  const status =
    summary.checks_run === 0
      ? '⚠ no checks ran'
      : summary.ok ? '✔ all checks passed' : '✘ one or more checks failed';
  const ran = summary.checks_run === 0 ? '' : coverage(summary, checks);
  writeLine(stderr, `${status} in ${summary.total_duration_ms}ms${ran}`);
  writeLine(stderr, 'report: .check/summary.json');
  if (digestWritten) writeLine(stderr, 'digest: .check/digest.md');
  writeLine(stderr, '');
}

/**
 * The 0/1/2 exit taxonomy. `--strict` turns a vacuous green (zero checks) into a
 * harness error (exit 2) — a gate must not report "done" on a repo where nothing
 * was checked.
 */
function computeExitCode(summary: Summary, strict: boolean, json: boolean, stderr: Out): number {
  if (strict && summary.checks_run === 0) {
    if (!json) writeLine(stderr, '--strict: zero checks ran, exiting 2.\n');
    return 2;
  }
  return summary.ok ? 0 : 1;
}

/** Run the selected checks against `cwd`, persist output, write the summary. */
export async function runChecks(options: RunOptions): Promise<RunResult> {
  // Clear the interrupt latch. On the CLI path this is a no-op — the process
  // re-raises the signal and dies — but `runChecks` is exported, and a
  // long-lived programmatic consumer that took one SIGINT would otherwise have
  // every later run silently spawn nothing (`spawnCheck` starts nothing while
  // latched). A new call necessarily follows the previous one's return, so
  // there is no in-flight run for this to un-latch.
  interrupted = false;
  const base = resolveRunContext(options);
  const resolved = resolveChecks({ slots: base.slots, adapters: base.adapters, config: base.config, cwd: base.cwd });
  // A usage error before any side effect: no `.check/` dir, no run, exit 2.
  validateSelection(resolved, options);

  await mkdir(join(base.cwd, '.check'), { recursive: true });

  const selected = selectChecks(resolved, options);
  // The status-line column is sized once the selection is known, so a long
  // custom-check name widens the column instead of overflowing it.
  const ctx: RunContext = { ...base, nameWidth: nameWidth(selected) };
  if (!ctx.json) writeLine(ctx.stderr, `\nRunning ${selected.length} check(s)...\n`);

  // `--bail` is fail-fast sequential; a `--concurrency > 1` passed alongside
  // is safe but moot, so say so once — not a usage error, the run just goes slow.
  if (ctx.bail && (options.concurrency ?? 0) > 1 && !ctx.json) {
    writeLine(ctx.stderr, '--concurrency ignored under --bail (fail-fast runs sequentially).');
  }

  // `total_duration_ms` is wall-clock of the execution phase, so measure
  // around it rather than summing per-check durations (which diverge under
  // concurrency). The report array is assembled in `selected` order, not
  // completion order, so it stays byte-reproducible regardless of interleaving.
  const startedAt = performance.now();
  const { checks, runs, observed, brokeEarly } = await executeChecks(selected, ctx);
  const totalDurationMs = Math.round(performance.now() - startedAt);

  await maybeRatchet(ctx.cwd, ctx.baseline, observed, isPartialRun(options, ctx.changed, brokeEarly), ctx.json, ctx.stderr);

  const summary = buildSummary(checks, totalDurationMs);
  await writeFileAtomic(join(ctx.cwd, '.check', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  // `--digest`: write (or, on green, clear) the token-bounded failure excerpt.
  // A file beside summary.json, never a stdout stream, so the machine-output
  // split holds. Raw `.check/<slot>.json` files are already persisted and
  // untouched — the digest only reads them.
  const digestWritten = (options.digest ?? false) ? await writeDigest(ctx.cwd, runs, checks) : false;

  if (ctx.json) {
    ctx.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    reportSummary(ctx.stderr, summary, checks, ctx.adapters, digestWritten);
  }

  const exitCode = computeExitCode(summary, options.strict ?? false, ctx.json, ctx.stderr);
  return { ok: summary.ok, summary, exitCode, runs };
}

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
    // oxlint-disable-next-line no-await-in-loop -- fixers mutate the working tree; running them sequentially prevents two (e.g. oxlint --fix and prettier --write) racing on the same files.
    const outcome = await fixRunner(adapter, { cwd, pm });
    ran.push(adapter.name);
    writeLine(stderr, outcome.ok ? `  ✔ ${r.slot}` : `  ✘ ${r.slot} (exit ${outcome.exit_code})`);
    if (!outcome.ok) ok = false;
  }

  return { ok, exitCode: ok ? 0 : 1, ran };
}
