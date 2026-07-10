/**
 * Orchestrator — behavior-ported from the interim `scripts/check.mjs`.
 *
 * Resolves slots to adapters, selects which to run (flags), spawns each command
 * (or runs a built-in), captures raw output to `.check/`, and writes the
 * aggregate `.check/summary.json`. The orchestrator stays dumb: it never parses
 * diagnostics — agents read the per-tool JSON directly.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Adapter, Slot } from './adapters.js';
import { ADAPTERS, SCHEMA_VERSION, SLOTS } from './adapters.js';
import { writeFileAtomic } from './atomic.js';
import type { Baseline, Fingerprint } from './baseline/index.js';
import {
  applyBaseline,
  BASELINE_FILE,
  baselinesEqual,
  countBaselineKeys,
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
import type { PackageManager } from './pm/index.js';
import { detectPackageManager, isAvailableUnder, translateExec } from './pm/index.js';

/** Minimal writable sink (satisfied by `process.stdout`/`process.stderr`). */
export type Out = { write(text: string): unknown };

/** Run flags, mirroring the interim script's `parseArgs` surface. */
export type RunFlags = {
  bail?: boolean;
  json?: boolean;
  changed?: boolean;
  all?: boolean;
  only?: string[] | null;
  skip?: string[] | null;
  include?: string[] | null;
  /** Write a capped failure excerpt to `.check/digest.md` (step 11). */
  digest?: boolean;
  /**
   * Treat zero checks actually executing as an error (exit 2), not a vacuous
   * pass. For consumers that gate on the exit code (plumbbob, CI); a human
   * exploring a fresh repo keeps the default warning-only behavior.
   */
  strict?: boolean;
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
   * Additive field — absent on runs with no baseline, so `schema_version` holds
   * (D8/C4).
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
 * Port of the interim `select_checks`: only/skip/opt-in selection by slot name.
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

/** Grace between SIGTERM and SIGKILL when a timed-out check won't die politely. */
const KILL_GRACE_SECONDS = 5;

/**
 * Spawn one check. A falsy or non-positive `timeoutSec` means no cap (the
 * default cap is applied by the runner, not here). When it fires, the child
 * gets SIGTERM, then SIGKILL after a short grace, and a failed outcome carries
 * a `"timed out after Ns"` note so the slot is recorded failed with its
 * elapsed duration (both timers are always cleared on `close`).
 */
function spawnCheck(command: string, args: string[], cwd: string, timeoutSec?: number): Promise<CheckOutcome> {
  return new Promise((resolveOutcome) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = timeoutSec && timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
          killTimer = setTimeout(() => { proc.kill('SIGKILL'); }, KILL_GRACE_SECONDS * 1000);
        }, timeoutSec * 1000)
      : null;
    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      clearTimers();
      resolveOutcome({ ok: false, exit_code: -1, stdout: '', stderr: `Failed to spawn: ${err.message}` });
    });
    proc.on('close', (code) => {
      clearTimers();
      if (timedOut) {
        const note = `timed out after ${timeoutSec}s`;
        resolveOutcome({ ok: false, exit_code: -1, stdout, stderr: stderr ? `${stderr}\n${note}` : `${note}\n` });
        return;
      }
      resolveOutcome({ ok: code === 0, exit_code: code ?? -1, stdout, stderr });
    });
  });
}

const defaultRunner: CheckRunner = (resolved, ctx) => {
  const adapter = resolved.adapter;
  if (!adapter) return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  if (adapter.builtin === 'links') return checkLinks(ctx.cwd);
  const timeout = adapter.timeout ?? ctx.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const { command, args } = translateExec(adapter.command, runtimeArgs(adapter, ctx.changed), ctx.pm);
  return spawnCheck(command, args, ctx.cwd, timeout);
};

/** Persist raw output atomically: JSON to `.check/<outputFile>`, else stdout/stderr text. */
async function persistOutput(cwd: string, adapter: Adapter, outcome: CheckOutcome): Promise<void> {
  const dir = join(cwd, '.check');
  if (adapter.outputFile && outcome.stdout.trim()) {
    try {
      JSON.parse(outcome.stdout);
      await writeFileAtomic(join(dir, adapter.outputFile), outcome.stdout);
      return;
    } catch {
      // Not JSON after all; fall through to raw text.
    }
  }
  if (outcome.stdout.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stdout.txt`), outcome.stdout);
  if (outcome.stderr.trim()) await writeFileAtomic(join(dir, `${adapter.slot}.stderr.txt`), outcome.stderr);
}

function writeLine(out: Out, line: string): void {
  out.write(`${line}\n`);
}

function formatStatusLine(check: SummaryCheck): string {
  const mark = check.ok ? '✔' : '✘';
  const name = check.name.padEnd(8);
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
    output_file: resolved.adapter?.outputFile ?? null,
  };
}

function buildSummary(checks: SummaryCheck[]): Summary {
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks_run: checks.filter((c) => !c.skipped).length,
    total_duration_ms: checks.reduce((sum, c) => sum + c.duration_ms, 0),
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
 * unmissable, not something only a consumer that hand-rolled the check (as
 * plumbbob's gate did) can distinguish from "green because everything passed".
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

/** Run the selected checks against `cwd`, persist output, write the summary. */
export async function runChecks(options: RunOptions): Promise<RunResult> {
  const cwd = options.cwd ?? process.cwd();
  const slots = options.slots ?? SLOTS;
  const adapters = options.adapters ?? ADAPTERS;
  const config = options.config !== undefined ? options.config : loadConfig(cwd);
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const runner = options.runner ?? defaultRunner;
  const json = options.json ?? false;
  const bail = options.bail ?? false;
  const changed = options.changed ?? false;
  const timeout = config?.timeout;
  const pm = options.pm ?? detectPackageManager({ cwd });
  const baseline = options.baseline !== undefined ? options.baseline : loadBaseline(cwd);

  await mkdir(join(cwd, '.check'), { recursive: true });

  const resolved = resolveChecks({ slots, adapters, config, cwd });
  const selected = selectChecks(resolved, options);

  if (!json) writeLine(stderr, `\nRunning ${selected.length} check(s)...\n`);

  const checks: SummaryCheck[] = [];
  const runs: CheckRun[] = [];
  // Per-slot current fingerprints for slots actually observed this run, and
  // whether `--bail` cut the loop short — both feed the ratchet's full-run gate.
  const observed = new Map<string, Fingerprint>();
  let brokeEarly = false;
  for (const r of selected) {
    // Skip when unresolved, or when the adapter can't run under this PM — e.g.
    // `pnpm audit` (the `security` slot) is unavailable off pnpm (b5).
    const unavailable = r.adapter && !isAvailableUnder(r.adapter.command, r.adapter.args, pm);
    if (r.skip || !r.adapter || unavailable) {
      const entry = skippedEntry(
        unavailable ? { ...r, skip: `'${r.adapter?.command} ${r.adapter?.args[0]}' is unavailable under ${pm}` } : r,
      );
      checks.push(entry);
      if (!json) writeLine(stderr, `  ○ ${entry.name.padEnd(8)}      skip  ${entry.reason ?? ''}`);
      continue;
    }
    const adapter = r.adapter;
    if (!json) writeLine(stderr, `  ▸ ${r.slot}  ${adapter.description}`);
    const start = performance.now();
    const outcome = await runner(r, { cwd, changed, pm, ...(timeout !== undefined ? { timeout } : {}) });
    const duration_ms = Math.round(performance.now() - start);
    runs.push({ slot: r.slot, adapter, outcome });
    await persistOutput(cwd, adapter, outcome);

    // Baseline-aware: subtract this slot's grandfathered diagnostics. Masking is
    // always on (even under a partial run); only the ratchet below is gated. The
    // raw `.check/<slot>.json` is already persisted untouched — masking changes
    // the pass/fail verdict, never the authoritative output.
    let ok = outcome.ok;
    let baselined = 0;
    let newKeys: string[] = [];
    const current = baseline ? fingerprint(adapter.name, outcome.stdout) : null;
    if (baseline && current !== null) {
      observed.set(r.slot, current);
      const adj = applyBaseline(current, baseline.slots[r.slot] ?? [], outcome.ok);
      ({ ok, baselined, newKeys } = adj);
    }

    const entry: SummaryCheck = {
      name: r.slot,
      adapter: adapter.name,
      description: adapter.description,
      ok,
      exit_code: outcome.exit_code,
      duration_ms,
      output_file: adapter.outputFile,
      ...(baselined > 0 ? { baselined } : {}),
    };
    checks.push(entry);
    if (!json) {
      writeLine(stderr, formatStatusLine(entry));
      if (baselined > 0) writeLine(stderr, `           ${baselined} baselined (grandfathered)`);
      if (!ok && newKeys.length > 0) {
        writeLine(stderr, `           ${newKeys.length} new, not in baseline:`);
        for (const k of newKeys) writeLine(stderr, `             ${k}`);
      }
    }
    if (!ok && bail) { brokeEarly = true; break; }
  }

  // Ratchet: on a fully-observed run, prune grandfathered diagnostics now fixed.
  // A partial run (`--only`/`--skip`/`--changed`) or an early `--bail` break can't
  // see every slot's full output, so it never prunes — an unobserved diagnostic
  // must not be mistaken for a fixed one and dropped (a1). Masking still applied
  // above; only the rewrite is withheld.
  if (baseline) {
    const restricted =
      (options.only ?? null) !== null || (options.skip?.length ?? 0) > 0 || changed || brokeEarly;
    if (!restricted) {
      const pruned = ratchet(baseline, observed);
      if (!baselinesEqual(baseline, pruned)) {
        await writeBaseline(cwd, pruned);
        if (!json) {
          writeLine(stderr, `\nbaseline: ratcheted ${BASELINE_FILE} to ${countBaselineKeys(pruned)} grandfathered diagnostic(s)`);
        }
      }
    }
  }

  const summary = buildSummary(checks);
  await writeFileAtomic(join(cwd, '.check', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  // `--digest`: write (or, on green, clear) the token-bounded failure excerpt.
  // A file beside summary.json, never a stdout stream, so the machine-output
  // split holds (C5). Raw `.check/<slot>.json` files are already persisted and
  // untouched — the digest only reads them.
  const digestWritten = (options.digest ?? false) ? await writeDigest(cwd, runs, checks) : false;

  if (json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    if (summary.checks_run === 0) warnVacuous(stderr, checks, adapters);
    writeLine(stderr, '');
    const status =
      summary.checks_run === 0
        ? '⚠ no checks ran'
        : summary.ok ? '✔ all checks passed' : '✘ one or more checks failed';
    writeLine(stderr, `${status} in ${summary.total_duration_ms}ms`);
    writeLine(stderr, 'report: .check/summary.json');
    if (digestWritten) writeLine(stderr, 'digest: .check/digest.md');
    writeLine(stderr, '');
  }

  // `--strict` turns a vacuous green into a harness error: exit 2, never 0 —
  // a gate must not report "done" on a repo where nothing was checked.
  let exitCode = summary.ok ? 0 : 1;
  if ((options.strict ?? false) && summary.checks_run === 0) {
    exitCode = 2;
    if (!json) writeLine(stderr, '--strict: zero checks ran, exiting 2.\n');
  }

  return { ok: summary.ok, summary, exitCode, runs };
}

/** Result of a single adapter's fix command. */
export type FixOutcome = { ok: boolean; exit_code: number };

/** Runs one adapter's `fixArgs`. Injectable for testing. */
export type FixRunner = (adapter: Adapter, ctx: { cwd: string }) => Promise<FixOutcome>;

export type FixOptions = RunFlags & {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stderr?: Out;
  fixRunner?: FixRunner;
};

export type FixResult = { ok: boolean; exitCode: number; ran: string[] };

function spawnInherit(command: string, args: string[], cwd: string): Promise<FixOutcome> {
  return new Promise((resolveOutcome) => {
    const proc = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    proc.on('error', () => { resolveOutcome({ ok: false, exit_code: -1 }); });
    proc.on('close', (code) => { resolveOutcome({ ok: code === 0, exit_code: code ?? -1 }); });
  });
}

const defaultFixRunner: FixRunner = (adapter, ctx) =>
  spawnInherit(adapter.command, adapter.fixArgs ?? [], ctx.cwd);

/** Run every active adapter's `fixArgs` (`checkride fix`). */
export async function runFix(options: FixOptions): Promise<FixResult> {
  const cwd = options.cwd ?? process.cwd();
  const slots = options.slots ?? SLOTS;
  const adapters = options.adapters ?? ADAPTERS;
  const config = options.config !== undefined ? options.config : loadConfig(cwd);
  const stderr = options.stderr ?? process.stderr;
  const fixRunner = options.fixRunner ?? defaultFixRunner;

  const resolved = resolveChecks({ slots, adapters, config, cwd });
  const fixable = selectChecks(resolved, options).filter((r) => r.adapter?.fixArgs);

  if (fixable.length === 0) {
    writeLine(stderr, 'checkride fix: no active adapters expose a fix command.');
    return { ok: true, exitCode: 0, ran: [] };
  }

  const ran: string[] = [];
  let ok = true;
  for (const r of fixable) {
    const adapter = r.adapter;
    if (!adapter) continue;
    writeLine(stderr, `  ▸ fix ${r.slot.padEnd(8)} (${adapter.name})`);
    const outcome = await fixRunner(adapter, { cwd });
    ran.push(adapter.name);
    writeLine(stderr, outcome.ok ? `  ✔ ${r.slot}` : `  ✘ ${r.slot} (exit ${outcome.exit_code})`);
    if (!outcome.ok) ok = false;
  }

  return { ok, exitCode: ok ? 0 : 1, ran };
}
