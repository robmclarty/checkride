/**
 * Orchestrator — behavior-ported from the interim `scripts/check.mjs`.
 *
 * Resolves slots to adapters, selects which to run (flags), spawns each command
 * (or runs a built-in), captures raw output to `.check/`, and writes the
 * aggregate `.check/summary.json`. The orchestrator stays dumb: it never parses
 * diagnostics — agents read the per-tool JSON directly.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Adapter, Slot } from '../adapters/index.js';
import { ADAPTERS, SCHEMA_VERSION, SLOTS } from '../adapters/index.js';
import type { CheckrideConfig, ResolvedCheck } from '../config/index.js';
import { loadConfig, resolveChecks } from '../config/index.js';
import type { CheckOutcome } from '../links/index.js';
import { checkLinks } from '../links/index.js';

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
};

/** The `.check/summary.json` contract. A public API for agents. */
export type Summary = {
  schema_version: number;
  timestamp: string;
  ok: boolean;
  total_duration_ms: number;
  checks: SummaryCheck[];
};

/** Low-level runner: executes one active check and returns its raw outcome. */
export type CheckRunner = (
  resolved: ResolvedCheck,
  ctx: { cwd: string; changed: boolean },
) => Promise<CheckOutcome>;

export type RunOptions = RunFlags & {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  stdout?: Out;
  stderr?: Out;
  runner?: CheckRunner;
};

export type RunResult = { ok: boolean; summary: Summary; exitCode: number };

/** Port of the interim `select_checks`: only/skip/opt-in selection by slot name. */
export function selectChecks(resolved: readonly ResolvedCheck[], flags: RunFlags): ResolvedCheck[] {
  const only = flags.only ?? null;
  const skipSet = new Set(flags.skip ?? []);
  const includeSet = new Set(flags.include ?? []);
  const all = flags.all ?? false;
  return resolved.filter((r) => {
    if (only) return only.includes(r.slot);
    if (skipSet.has(r.slot)) return false;
    if (r.optIn && !all && !includeSet.has(r.slot)) return false;
    return true;
  });
}

/** Append an adapter's `changedArgs` under `--changed` (otherwise base args). */
export function runtimeArgs(adapter: Adapter, changed: boolean): string[] {
  if (changed && adapter.changedArgs) return [...adapter.args, ...adapter.changedArgs];
  return adapter.args;
}

function spawnCheck(command: string, args: string[], cwd: string): Promise<CheckOutcome> {
  return new Promise((resolveOutcome) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      resolveOutcome({ ok: false, exit_code: -1, stdout: '', stderr: `Failed to spawn: ${err.message}` });
    });
    proc.on('close', (code) => {
      resolveOutcome({ ok: code === 0, exit_code: code ?? -1, stdout, stderr });
    });
  });
}

const defaultRunner: CheckRunner = (resolved, ctx) => {
  const adapter = resolved.adapter;
  if (!adapter) return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  if (adapter.builtin === 'links') return checkLinks(ctx.cwd);
  return spawnCheck(adapter.command, runtimeArgs(adapter, ctx.changed), ctx.cwd);
};

/** Persist raw output: JSON to `.check/<outputFile>`, else stdout/stderr text. */
async function persistOutput(cwd: string, adapter: Adapter, outcome: CheckOutcome): Promise<void> {
  const dir = join(cwd, '.check');
  if (adapter.outputFile && outcome.stdout.trim()) {
    try {
      JSON.parse(outcome.stdout);
      await writeFile(join(dir, adapter.outputFile), outcome.stdout);
      return;
    } catch {
      // Not JSON after all; fall through to raw text.
    }
  }
  if (outcome.stdout.trim()) await writeFile(join(dir, `${adapter.slot}.stdout.txt`), outcome.stdout);
  if (outcome.stderr.trim()) await writeFile(join(dir, `${adapter.slot}.stderr.txt`), outcome.stderr);
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
    total_duration_ms: checks.reduce((sum, c) => sum + c.duration_ms, 0),
    checks,
  };
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

  await mkdir(join(cwd, '.check'), { recursive: true });

  const resolved = resolveChecks({ slots, adapters, config, cwd });
  const selected = selectChecks(resolved, options);

  if (!json) writeLine(stderr, `\nRunning ${selected.length} check(s)...\n`);

  const checks: SummaryCheck[] = [];
  for (const r of selected) {
    if (r.skip || !r.adapter) {
      const entry = skippedEntry(r);
      checks.push(entry);
      if (!json) writeLine(stderr, `  ○ ${entry.name.padEnd(8)}      skip  ${entry.reason ?? ''}`);
      continue;
    }
    const adapter = r.adapter;
    if (!json) writeLine(stderr, `  ▸ ${r.slot}  ${adapter.description}`);
    const start = performance.now();
    const outcome = await runner(r, { cwd, changed });
    const duration_ms = Math.round(performance.now() - start);
    await persistOutput(cwd, adapter, outcome);
    const entry: SummaryCheck = {
      name: r.slot,
      adapter: adapter.name,
      description: adapter.description,
      ok: outcome.ok,
      exit_code: outcome.exit_code,
      duration_ms,
      output_file: adapter.outputFile,
    };
    checks.push(entry);
    if (!json) writeLine(stderr, formatStatusLine(entry));
    if (!outcome.ok && bail) break;
  }

  const summary = buildSummary(checks);
  await writeFile(join(cwd, '.check', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    writeLine(stderr, '');
    const status = summary.ok ? '✔ all checks passed' : '✘ one or more checks failed';
    writeLine(stderr, `${status} in ${summary.total_duration_ms}ms`);
    writeLine(stderr, 'report: .check/summary.json');
    writeLine(stderr, '');
  }

  return { ok: summary.ok, summary, exitCode: summary.ok ? 0 : 1 };
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
