/**
 * `checkride gate` — the stop-gate verdict, harness-neutral.
 *
 * Every agent harness offers some "the turn is ending" hook, and checkride's
 * gate hangs off it: run the repo's `check` script, and while it is red, refuse
 * to let the turn finish. What differs between harnesses is only the *wire
 * format* of that refusal — Claude Code reads stderr and blocks on exit 2,
 * Cursor reads a `followup_message` on stdout and submits it as the next turn.
 * The decision itself (is it dirty, is it green, which artifact should the agent
 * read) is identical, so it lives here once and the generated hook scripts
 * become two-line adapters that name their harness.
 *
 * That split is the point. Before this command, the whole body was duplicated
 * shell inside `.claude/hooks/checkride-gate.sh`, untestable outside an e2e run
 * and impossible to share with a second harness.
 *
 * Not to be confused with `../triage/gate.ts`, which also runs the `check`
 * script: that one runs it *verbatim* as a reader's preflight and classifies the
 * result for a report. This one appends `--strict --digest` because it IS the
 * gate, and its output is a verdict for the harness, not prose for a human.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { formatDuration, readSummary } from './artifacts/index.js';
import { DIGEST_FILE } from './digest/index.js';
import type { Out, SummaryCheck } from './orchestrator.js';
import { detectPackageManager, type PackageManager } from './pm/index.js';

/**
 * The edit marker: touched by the harness's "a file changed" hook, checked here
 * under `--if-dirty`, and cleared by a green gate. Dot-named so it can never
 * collide with a slot's `<slot>.json`/`<slot>.stdout.txt` artifacts, which the
 * orchestrator deletes per slot before a re-run — the marker must survive every
 * run.
 *
 * It lives here, not in `agent-setup`, because the gate is what reads and clears
 * it; the hook writers import it from this module to build the touch command.
 */
export const DIRTY_MARKER = '.check/.dirty';

/** Where the gate points a red agent when `--digest` wrote nothing. */
const SUMMARY_PATH = '.check/summary.json';

/**
 * Cursor's own hook config. It lives here rather than in `agent-setup/cursor.ts`
 * for the same reason {@link DIRTY_MARKER} does: the gate *reads* it (see
 * {@link deferredToCursor}), and the writer importing from the gate is the
 * direction that has no cycle. `agent-setup/cursor.ts` re-exports it.
 */
export const CURSOR_HOOKS_FILE = '.cursor/hooks.json';

/**
 * What a registered checkride gate looks like inside a harness's hook config.
 * Both harnesses name the script the same, so finding it in Cursor's config is
 * enough to know Cursor has a native gate of its own.
 */
const GATE_SCRIPT_SENTINEL = 'checkride-gate.sh';

/** Every harness whose stop-hook protocol the gate can speak. */
export const HARNESS_NAMES = ['claude', 'cursor'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** Script name every checkride repo exposes; `checkride init` writes it. */
const CHECK_SCRIPT = 'check';

/**
 * Spawn the check script and forward its output. Injectable so the command's
 * branches are testable without a real toolchain.
 *
 * Both child streams are forwarded to **stderr**, never stdout: under
 * `--harness cursor` this process's stdout must contain the hook's JSON and
 * nothing else, and in a hook context the check's output is human-facing
 * progress either way. Returns the exit code; a signal death is `null` and the
 * caller reads it as red, because "not cleanly green" is the only distinction a
 * gate needs.
 */
export type GateSpawn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; stderr: Out },
) => Promise<number | null>;

const spawnForward: GateSpawn = (command, args, opts) =>
  new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => opts.stderr.write(chunk));
    proc.stderr.on('data', (chunk: string) => opts.stderr.write(chunk));
    // A gate that cannot spawn its package manager is red, not a crash: the
    // harness gets a verdict it can act on rather than a stack trace.
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code));
  });

export type GateOptions = {
  cwd?: string;
  /** Skip the run entirely when the edit marker is absent (`--if-dirty`). */
  ifDirty?: boolean;
  /** Which harness's stop-hook protocol to answer in. Defaults to `claude`. */
  harness?: HarnessName;
  pm?: PackageManager;
  stdout?: Out;
  stderr?: Out;
  spawn?: GateSpawn;
  /** Process environment; injectable so {@link deferredToCursor} is testable. */
  env?: Record<string, string | undefined>;
  /** Wall-clock source for the elapsed time the gate reports; injectable for tests. */
  now?: () => number;
};

export type GateResult = {
  exitCode: number;
  /** False when `--if-dirty` or the Cursor deferral short-circuited the run. */
  ran: boolean;
  green: boolean;
};

/**
 * True when this `--harness claude` invocation is really Cursor running the
 * repo's `.claude/settings.json` hooks, *and* Cursor has a native checkride gate
 * of its own that will run for the same turn.
 *
 * Cursor loads third-party (Claude Code) hook configs when "Include third-party
 * Plugins, Skills, and other configs" is on, maps `Stop` onto `stop`, and — the
 * load-bearing sentence — runs **all** matching hooks from **every** source. A
 * repo wired for both harnesses therefore fires two full pipelines into one
 * `.check/` directory, concurrently and with nothing to serialize them, where
 * the orchestrator clears each slot's artifacts before re-running it.
 *
 * So one of the two has to stand down, and it is this one: under Cursor the
 * native `.cursor/hooks.json` gate is the only one that can answer in Cursor's
 * protocol, which makes it authoritative there.
 *
 * Deliberately narrow — it defers only when a Cursor gate is *registered*, not
 * merely when Cursor is running, so the failure mode of a stale environment
 * variable is a duplicate run (today's behavior) rather than no gate at all.
 */
function deferredToCursor(cwd: string, env: Record<string, string | undefined>): boolean {
  if (!env['CURSOR_PROJECT_DIR']) return false;
  try {
    return readFileSync(join(cwd, CURSOR_HOOKS_FILE), 'utf8').includes(GATE_SCRIPT_SENTINEL);
  } catch {
    return false;
  }
}

/**
 * The gate's `check`-script invocation for `pm` (the alias `agent-setup`
 * ensures exists). The hook IS a gate, so it runs `--strict` (zero checks
 * running is exit 2, not a pass — docs/contract.md) and `--digest` (the
 * token-bounded failure excerpt is a far better landing spot for an agent than
 * raw summary.json). npm alone needs `--` to reach the script with flags;
 * pnpm/yarn/bun forward them directly.
 */
export function checkArgs(pm: PackageManager): string[] {
  return ['run', CHECK_SCRIPT, ...(pm === 'npm' ? ['--'] : []), '--strict', '--digest'];
}

/**
 * Below this, naming the slowest check is noise rather than insight — every
 * check in a fast repo is "the slowest" by some millisecond.
 */
const SLOWEST_FLOOR_MS = 1000;

/** The checks that actually ran, in report order. */
function ranChecks(checks: readonly SummaryCheck[]): SummaryCheck[] {
  return checks.filter((c) => c.skipped !== true);
}

/** `15 checks, slowest test 21.4s` — what a green run is worth saying about itself. */
function greenDetail(ran: readonly SummaryCheck[]): string {
  const count = `${ran.length} check${ran.length === 1 ? '' : 's'}`;
  const slowest = ran.reduce<SummaryCheck | null>(
    (worst, c) => (worst === null || c.duration_ms > worst.duration_ms ? c : worst),
    null,
  );
  if (slowest === null || slowest.duration_ms < SLOWEST_FLOOR_MS) return count;
  return `${count}, slowest ${slowest.name} ${formatDuration(slowest.duration_ms)}`;
}

/**
 * What the run itself says, read back out of `.check/summary.json`, or `null`
 * when there is no usable summary — a gate that could not run wrote none, and a
 * report that invents "0 checks failed" from a missing file is exactly the
 * vacuous green the artifact exists to disprove. The caller still has the
 * elapsed time, which is true regardless.
 *
 * A summary older than `startedAt` belongs to a *previous* run and is dropped
 * for the same reason. That is not hypothetical: a check script of the shape
 * `tsc --build && checkride` leaves the summary untouched when the build fails,
 * so trusting whatever is on disk would report the last run's failing slots as
 * this one's — confidently, and wrongly.
 */
async function runDetail(cwd: string, green: boolean, startedAt: number): Promise<string | null> {
  const read = await readSummary(cwd);
  if (read.state !== 'ok' || read.mtimeMs < startedAt) return null;
  const ran = ranChecks(read.summary.checks);
  if (green) return greenDetail(ran);
  const failed = ran.filter((c) => !c.ok).map((c) => c.name);
  // Red with nothing failing means the check script itself died (or --strict
  // caught a vacuous run); say the honest thing rather than name no slots.
  if (failed.length === 0) return `${ran.length} checks ran, none failed — the check script itself failed`;
  return `${failed.length} of ${ran.length} failed: ${failed.join(', ')}`;
}

/**
 * The one line a human reads to know the gate ran, what it decided, and how long
 * they waited on it.
 *
 * The elapsed time is the gate's own wall clock — package-manager startup,
 * incremental build and all — not the pipeline's `total_duration_ms`, because
 * the honest answer to "why did that pause" is the whole pause, not the part
 * checkride chooses to measure.
 */
function headline(green: boolean, elapsedMs: number, detail: string | null): string {
  const verdict = green ? '✔ green' : '✘ red';
  return `checkride ${verdict} in ${formatDuration(elapsedMs)}${detail === null ? '' : ` — ${detail}`}`;
}

/** The sentence a red gate hands the agent, naming what to open first. */
function redMessage(cwd: string, pm: PackageManager): string {
  const where = existsSync(join(cwd, '.check', DIGEST_FILE)) ? `.check/${DIGEST_FILE}` : SUMMARY_PATH;
  return (
    `checkride: the gate is red — read ${where}, fix the failing slot, then finish ` +
    `(do not stop while checkride is red). Run \`${pm} exec checkride triage\` for full triage.`
  );
}

/**
 * Answer a green run in `harness`'s protocol.
 *
 * Claude Code gets `{"systemMessage": …}`, which it shows the user. Without it a
 * green gate is completely silent: the turn simply takes a minute longer than it
 * should have, with nothing on screen to say a full pipeline just ran, which is
 * indistinguishable from a hung model.
 *
 * Cursor gets nothing, and cannot. Its stop hook accepts one field —
 * `followup_message` — and that field *submits a new turn*, so using it to
 * announce a pass would put the agent back to work every time it succeeded. No
 * other channel is documented for the event; see docs/cursor.md.
 */
function reportGreen(harness: HarnessName, stdout: Out, status: string): void {
  if (harness === 'cursor') return;
  stdout.write(`${JSON.stringify({ systemMessage: status })}\n`);
}

/**
 * Answer a red run in `harness`'s protocol.
 *
 * Claude Code gets both spellings of the same verdict, because which one lands
 * depends on the hook script the repo happens to have. The JSON body
 * (`decision: "block"`) is what a current script forwards on its own exit 0 —
 * Claude Code parses hook JSON *only* on exit 0, and that body is the one form
 * that can carry a user-visible `systemMessage` alongside the block. The stderr
 * line is what a script generated before that change relies on, where the block
 * rides on exit 2 and stdout is ignored. Emitting both is what lets an
 * already-installed hook script keep gating across the upgrade.
 *
 * Cursor gets `{"followup_message": …}` on stdout and **exit 0**: it reads a
 * non-zero stop hook as a *failed hook* and lets the turn end anyway, so the
 * verdict cannot ride on the exit code. Cursor caps those auto-followups at five
 * per script by default; the hook entry `agent-setup` writes opts out
 * (`loop_limit: null`), because a gate that stops replying after five turns is
 * not a gate.
 */
function reportRed(
  harness: HarnessName,
  out: { stdout: Out; stderr: Out },
  verdict: { status: string; instruction: string },
): number {
  // The agent is told what to open and what not to do; the user is told what
  // happened and how long it took. Handing the user the agent's marching orders
  // would bury the one line they are actually reading.
  const full = `${verdict.status}\n${verdict.instruction}`;
  if (harness === 'cursor') {
    out.stdout.write(`${JSON.stringify({ followup_message: full })}\n`);
    return 0;
  }
  out.stdout.write(
    `${JSON.stringify({ decision: 'block', reason: full, systemMessage: verdict.status })}\n`,
  );
  out.stderr.write(`${full}\n`);
  return 2;
}

/**
 * Run the gate and answer in `harness`'s protocol.
 *
 * The exit code is unchanged and stays as `docs/contract.md` promises it: 2 while
 * red under `--harness claude`, always 0 under `--harness cursor`. What each
 * harness *displays* is carried by the JSON body on stdout — see
 * {@link reportGreen} and {@link reportRed} — because that is the only channel
 * either harness renders for a human.
 */
export async function runGate(options: GateOptions = {}): Promise<GateResult> {
  const cwd = options.cwd ?? process.cwd();
  const harness = options.harness ?? 'claude';
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const run = options.spawn ?? spawnForward;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const marker = join(cwd, DIRTY_MARKER);

  // Cursor running this repo's Claude hooks alongside its own. Stand down before
  // touching the marker: the native Cursor gate owns both the verdict and the
  // marker for this turn.
  if (harness === 'claude' && deferredToCursor(cwd, env)) {
    return { exitCode: 0, ran: false, green: true };
  }

  // No edit marker → this turn touched no files → nothing to gate. Stop hooks
  // fire on every turn, including pure-conversation ones; without this the gate
  // taxes every reply with a full pipeline run.
  if (options.ifDirty === true && !existsSync(marker)) {
    return { exitCode: 0, ran: false, green: true };
  }

  const pm = options.pm ?? detectPackageManager({ cwd });
  const startedAt = now();
  const code = await run(pm, checkArgs(pm), { cwd, stderr });
  const green = code === 0;
  const status = headline(green, now() - startedAt, await runDetail(cwd, green, startedAt));

  if (green) {
    rmSync(marker, { force: true });
    reportGreen(harness, stdout, status);
    return { exitCode: 0, ran: true, green: true };
  }

  const exitCode = reportRed(harness, { stdout, stderr }, { status, instruction: redMessage(cwd, pm) });
  return { exitCode, ran: true, green: false };
}
