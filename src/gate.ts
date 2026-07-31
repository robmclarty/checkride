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

import { DIGEST_FILE } from './digest/index.js';
import type { Out } from './orchestrator.js';
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

/** The sentence a red gate hands the agent, naming what to open first. */
function redMessage(cwd: string, pm: PackageManager): string {
  const where = existsSync(join(cwd, '.check', DIGEST_FILE)) ? `.check/${DIGEST_FILE}` : SUMMARY_PATH;
  return (
    `checkride: the gate is red — read ${where}, fix the failing slot, then finish ` +
    `(do not stop while checkride is red). Run \`${pm} exec checkride triage\` for full triage.`
  );
}

/**
 * Run the gate and answer in `harness`'s protocol.
 *
 * Claude Code: the message on stderr, **exit 2**. Exit 1 would not block — the
 * harness treats only 2 as "deny", so a plain check failure has to be
 * translated.
 *
 * Cursor: `{"followup_message": …}` on stdout, **exit 0**. Cursor reads a
 * non-zero stop hook as a *failed hook* and lets the turn end anyway, so the
 * verdict cannot ride on the exit code; it rides in the JSON body, which Cursor
 * submits as the next user message. Cursor caps those auto-followups at five per
 * script by default; the hook entry `agent-setup` writes opts out (`loop_limit:
 * null`), because a gate that stops replying after five turns is not a gate.
 */
export async function runGate(options: GateOptions = {}): Promise<GateResult> {
  const cwd = options.cwd ?? process.cwd();
  const harness = options.harness ?? 'claude';
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const run = options.spawn ?? spawnForward;
  const env = options.env ?? process.env;
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
  const code = await run(pm, checkArgs(pm), { cwd, stderr });

  if (code === 0) {
    rmSync(marker, { force: true });
    return { exitCode: 0, ran: true, green: true };
  }

  const message = redMessage(cwd, pm);
  if (harness === 'cursor') {
    stdout.write(`${JSON.stringify({ followup_message: message })}\n`);
    return { exitCode: 0, ran: true, green: false };
  }
  stderr.write(`${message}\n`);
  return { exitCode: 2, ran: true, green: false };
}
