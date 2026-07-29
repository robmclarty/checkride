/**
 * Killing a spawned check, and everything it started.
 *
 * Every subprocess checkride spawns is `detached`, so it leads its own process
 * group and a negated-pid signal reaches the whole tree — a wrapper's
 * grandchildren included. That is the difference between a timed-out
 * `sh -c 'slow-tool …'` leaving its real worker orphaned and alive, and taking
 * the tree down with it.
 *
 * Both spawners need the same two-step escalation (SIGTERM, then SIGKILL after
 * a grace), so it lives here rather than in either of them: the orchestrator's
 * per-check timeout and fatal-signal reaping (`../orchestrator.ts`), and the
 * triage reader's gate budget (`./triage/env.ts`).
 */

/** Grace between SIGTERM and SIGKILL when a process group won't die politely. */
export const KILL_GRACE_SECONDS = 5;

/**
 * Signal a spawned process's whole group. ESRCH is swallowed: the group racing
 * to exit on its own before we signal is success, not an error (and `pid` is
 * absent only when the spawn itself failed).
 */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone (raced with a clean exit) — nothing left to kill.
  }
}

/**
 * Ask a process group to stop, then insist. SIGTERM now; SIGKILL after
 * {@link KILL_GRACE_SECONDS} if it is still there. Returns the escalation
 * timer so the caller can clear it when the process closes first — a pending
 * timer would otherwise hold the event loop open past the run.
 */
export function killGroupEscalating(pid: number | undefined): ReturnType<typeof setTimeout> {
  killGroup(pid, 'SIGTERM');
  return setTimeout(() => { killGroup(pid, 'SIGKILL'); }, KILL_GRACE_SECONDS * 1000);
}
