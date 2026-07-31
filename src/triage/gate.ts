/**
 * Running the gate — the preflight every triage begins with.
 *
 * The reader runs the repo's *own* `check` script rather than `checkride`
 * directly, because that script is the repo's definition of done and may carry
 * deliberate `--only` / `--skip` / `--changed` that a direct invocation would
 * bypass. It also means a pre-existing `summary.json` is never mistaken for
 * evidence: every run overwrites it, so `ok: true` on disk can mean "three of
 * seventeen slots passed fourteen minutes ago".
 *
 * checkride promises the 0/1/2 exit split, so the verdict branches on that
 * before anything is read. Anything outside it — 127, a signal death, a wrapper
 * command that failed before checkride ran — is `off-contract`, reported as
 * itself rather than folded into one of the three.
 *
 * One exit *inside* the split still is not checkride's: a package manager that
 * refuses to start the script — an `engines.node` pin the running Node does not
 * satisfy, most often — exits 1, exactly as a red pipeline does. Left
 * unclassified, the reader an agent is sent to by a red gate would confirm the
 * red and point at slots that never ran. See `../pm/launch.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSummary } from '../artifacts/index.js';
import type { PackageManager } from '../pm/index.js';
import { detectPackageManager, launchRefusal } from '../pm/index.js';
import type { SpawnOutcome, TriageEnv } from './env.js';

/** How the gate ended, in the reader's vocabulary. */
export type GateVerdict = 'green' | 'red' | 'could-not-start' | 'harness-broken' | 'off-contract' | 'not-run';

/** The gate run: what was executed, how it ended, and what it printed. */
export type GateOutcome = {
  verdict: GateVerdict;
  /** The repo's `scripts.check`, verbatim — the definition of done. */
  script: string | null;
  /** The command line as run, for the report to quote. */
  command: string;
  pm: PackageManager;
  exitCode: number | null;
  signal: string | null;
  startedMs: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  /** Why the package manager never started the script, on the `could-not-start` verdict. */
  refusal: string | null;
  /** Selection flags found in the script text: it narrows the run on purpose. */
  narrowingFlags: string[];
};

/** Script name every checkride repo exposes; `checkride init` writes it. */
const CHECK_SCRIPT = 'check';

/**
 * Flags that make a green run cover less than the repo configures. Detected
 * textually in the script, which is exact and needs no knowledge of the
 * installed checkride's catalogue.
 */
const NARROWING_FLAGS: readonly string[] = ['--only', '--skip', '--changed'];

/** checkride's promised exit split. Everything else is off-contract. */
const VERDICT_BY_CODE: Readonly<Record<number, GateVerdict>> = { 0: 'green', 1: 'red', 2: 'harness-broken' };

/** Read `scripts.check` from `cwd`'s package.json, or `null` when there is none. */
function readCheckScript(cwd: string): string | null {
  try {
    const pkg: { scripts?: Record<string, string> } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return pkg.scripts?.[CHECK_SCRIPT] ?? null;
  } catch {
    return null;
  }
}

/**
 * Tolerance for a summary written moments before the gate's own clock reading —
 * mirrors `MTIME_TOLERANCE_MS` in `./triage.ts`, where the same comparison
 * decides whether the summary belongs to this run.
 */
const MTIME_TOLERANCE_MS = 1000;

/**
 * Did this run write a summary? Proof that the pipeline started, whatever its
 * output happens to contain — the guard that keeps a check which merely
 * *printed* a package-manager error code from being read as a refusal to launch.
 */
async function wroteSummary(cwd: string, startedMs: number): Promise<boolean> {
  const read = await readSummary(cwd);
  return read.state === 'ok' && read.mtimeMs >= startedMs - MTIME_TOLERANCE_MS;
}

/**
 * Classify an exit-1 gate: a red pipeline, or a package manager that never
 * started one. Only exit 1 is examined — 0 and 2 are checkride's own answers and
 * mean the pipeline ran, and everything else is already `off-contract`.
 */
async function refusalFor(outcome: SpawnOutcome, cwd: string, startedMs: number): Promise<string | null> {
  if (outcome.code !== 1 || (await wroteSummary(cwd, startedMs))) return null;
  return launchRefusal(`${outcome.stdout}${outcome.stderr}`)?.cause ?? null;
}

function verdictFor(outcome: SpawnOutcome, refusal: string | null): GateVerdict {
  if (outcome.error !== null || outcome.code === null) return 'off-contract';
  if (refusal !== null) return 'could-not-start';
  return VERDICT_BY_CODE[outcome.code] ?? 'off-contract';
}

/**
 * Run `<pm> run check` in `cwd` and classify the result. Never throws: a repo
 * with no `check` script, a missing package manager and a gate that fails are
 * all outcomes, because each is something the report has to say.
 */
export async function runGate(cwd: string, env: TriageEnv): Promise<GateOutcome> {
  const pm = detectPackageManager({ cwd });
  const script = readCheckScript(cwd);
  const base = {
    script,
    command: `${pm} run ${CHECK_SCRIPT}`,
    pm,
    startedMs: env.now(),
    narrowingFlags: NARROWING_FLAGS.filter((flag) => script?.includes(flag) ?? false),
  };
  if (script === null) {
    return { ...base, verdict: 'not-run', exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: '', spawnError: null, refusal: null };
  }
  const outcome = await env.spawn(pm, ['run', CHECK_SCRIPT], { cwd, timeoutMs: env.timeoutMs });
  const refusal = await refusalFor(outcome, cwd, base.startedMs);
  return {
    ...base,
    verdict: verdictFor(outcome, refusal),
    exitCode: outcome.code,
    signal: outcome.signal,
    durationMs: env.now() - base.startedMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    spawnError: outcome.error,
    refusal,
  };
}

/**
 * Whether this ending means the harness itself is suspect, not the code.
 *
 * `could-not-start` belongs here for the strongest version of that reason:
 * nothing ran at all, so the environment is the entire finding and the slot
 * table is not evidence of anything. It is also what folds `doctor` into the
 * report, which is where the reader will find the Node the hook got.
 */
export function isHarnessProblem(verdict: GateVerdict): boolean {
  return verdict === 'harness-broken' || verdict === 'off-contract' || verdict === 'could-not-start';
}
