/**
 * One retry for the e2e suite's setup steps, the only place a case may
 * download (C4); the checks themselves run offline.
 *
 * A download can fail for a reason that's gone a moment later: a CI run once
 * lost `go get -tool` to sum.golang.org resetting an HTTP/2 stream. Each step
 * gets a second attempt after a pause, so a network hiccup costs seconds
 * rather than a red run. A step that fails both times throws the second
 * attempt's error, and the first failure's last line goes to stderr either
 * way, so a run that needed the retry still says so.
 */

import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

type Attempt = (command: string, args: readonly string[], cwd: string) => Promise<unknown>;

type StepOptions = {
  readonly cwd: string;
  /** Runs one attempt; defaults to `execFile`, with room for an installer's output. */
  readonly attempt?: Attempt;
  /** Waits between the two attempts; defaults to two seconds. */
  readonly pause?: () => Promise<unknown>;
};

const spawnStep: Attempt = (command, args, cwd) => execFileP(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 });

/** Run a setup step from `cwd`, and once more after a pause if it fails. */
export async function setupStep(command: string, args: readonly string[], options: StepOptions): Promise<void> {
  const { cwd, attempt = spawnStep, pause = () => sleep(2_000) } = options;
  try {
    await attempt(command, args, cwd);
  } catch (error) {
    const cause = String(error).trim().split('\n').at(-1);
    console.warn(`setup step failed, trying once more: ${[command, ...args].join(' ')} (${cause})`);
    await pause();
    await attempt(command, args, cwd);
  }
}
