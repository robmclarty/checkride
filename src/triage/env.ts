/**
 * The triage reader's process surface: spawning, and the clock.
 *
 * Both are injectable because the reader's hardest guarantees are about
 * *failure* — it must survive a red gate, a broken harness, a missing binary
 * and a hung run without dying itself, and none of those are reachable from a
 * test that has to spawn a real toolchain to get there.
 *
 * {@link spawnCapture} never rejects. A reader that throws on a red gate would
 * fail exactly when it is needed, so a spawn failure is a *value* — an outcome
 * with `error` set — not an exception.
 */

import { spawn } from 'node:child_process';

import { killGroupEscalating } from '../proc.js';

/**
 * A finished (or failed) child process. `code` is `null` when the process died
 * by signal or never started; `error` is set only in the latter case.
 */
export type SpawnOutcome = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The spawn error message when the process could not start at all. */
  error: string | null;
};

/** Run a command and capture it. The one process touch the reader makes. */
export type Spawner = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<SpawnOutcome>;

/** Everything the reader needs from the outside world. */
export type TriageEnv = {
  spawn: Spawner;
  now: () => number;
  /** Budget for the gate run. A hung check must not hang the agent waiting on it. */
  timeoutMs: number;
};

/**
 * A full gate can legitimately take minutes (mutation testing, a cold build),
 * so the ceiling is generous: it exists to break a hang, not to police a slow
 * repo. checkride's own per-check timeouts fire long before this does.
 */
const DEFAULT_GATE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Keep the tail of each stream. The reader only ever renders an excerpt, and a
 * runaway tool must not be able to exhaust memory before the run even ends.
 */
const MAX_CAPTURE_CHARS = 256 * 1024;

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE_CHARS ? next.slice(next.length - MAX_CAPTURE_CHARS) : next;
}

/**
 * Spawn `command`, capture both streams, and resolve however it ends. Never rejects.
 *
 * `detached`, so the child leads its own process group and the timeout can
 * reap the whole tree. The gate is `<pm> run check`, which means the process
 * actually doing the work is a *grandchild* — a bare `proc.kill()` signals the
 * package-manager wrapper and leaves the checks themselves running, which both
 * defeats the budget and can hold this promise open forever, since `close`
 * waits on every inherited pipe. `killGroupEscalating` signals the group and
 * insists with SIGKILL after the grace (see `../proc.ts`).
 */
export function spawnCapture(
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => { escalation = killGroupEscalating(proc.pid); }, opts.timeoutMs);
    const settle = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A pending SIGKILL timer would hold the event loop open past the run.
      if (escalation !== null) clearTimeout(escalation);
      resolve(outcome);
    };
    // Decoded string streams: the internal StringDecoder holds a partial
    // multibyte sequence until its continuation bytes arrive, so `+=` never
    // concatenates half a character.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { stdout = appendCapped(stdout, chunk); });
    proc.stderr.on('data', (chunk: string) => { stderr = appendCapped(stderr, chunk); });
    proc.on('error', (err) => { settle({ code: null, signal: null, stdout, stderr, error: err.message }); });
    proc.on('close', (code, signal) => { settle({ code, signal, stdout, stderr, error: null }); });
  });
}

/** The real process surface. */
export const realEnv: TriageEnv = {
  spawn: spawnCapture,
  now: () => Date.now(),
  timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
};
