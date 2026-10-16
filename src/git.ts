/**
 * Git plumbing every command shares: one runner that classifies a failed
 * invocation for user-facing messages, the base a `--changed` run measures
 * from and the paths changed since it, and the head and dirtiness a run
 * records. Everything here is read-only
 * toward git. Baseline history (`recover`, `baseline diff`, the red-run hint)
 * builds on the runner in `./baseline/history.ts`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Why a git invocation failed, classified for user-facing messages. */
export type GitFailure = 'missing' | 'not-a-repo' | 'timeout' | 'failed';

export type GitResult = { ok: true; stdout: string } | { ok: false; error: GitFailure; detail: string };

/** Runs `git <args>`; injectable so git-reading logic is testable without a repo. */
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 10_000;
/** A monorepo baseline can be large; a `git show` must not be truncated mid-blob. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** The `code`/`killed`/`stderr` shape of a rejected `execFile`, checked not cast. */
function rejection(err: unknown): { code?: string; killed?: boolean; stderr?: string } {
  if (typeof err !== 'object' || err === null) return {};
  const out: { code?: string; killed?: boolean; stderr?: string } = {};
  if ('code' in err && typeof err.code === 'string') out.code = err.code;
  if ('killed' in err && typeof err.killed === 'boolean') out.killed = err.killed;
  if ('stderr' in err && typeof err.stderr === 'string') out.stderr = err.stderr;
  return out;
}

/** The real runner: `git` under `cwd`, with a timeout so no caller can hang on it. */
export function realGit(cwd: string, timeoutMs = GIT_TIMEOUT_MS): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileP('git', [...args], { cwd, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER });
      return { ok: true, stdout };
    } catch (err) {
      const e = rejection(err);
      if (e.code === 'ENOENT') return { ok: false, error: 'missing', detail: 'git not found on PATH' };
      if (e.killed === true) return { ok: false, error: 'timeout', detail: `git ${args[0]} timed out (>${GIT_TIMEOUT_MS / 1000}s)` };
      const stderr = (e.stderr ?? '').trim();
      if (stderr.includes('not a git repository')) return { ok: false, error: 'not-a-repo', detail: stderr };
      return { ok: false, error: 'failed', detail: stderr.length > 0 ? stderr : `git ${args[0]} failed` };
    }
  };
}

/**
 * The user-facing error for a failed git invocation; `runCli` renders it as
 * exit 2. `command` prefixes the message so it names the command that ran.
 */
export function gitFailureError(result: { error: GitFailure; detail: string }, command = 'recover'): Error {
  if (result.error === 'missing') return new Error(`${command}: git is required but was not found on PATH`);
  if (result.error === 'not-a-repo') return new Error(`${command}: not inside a git repository`);
  return new Error(`${command}: ${result.detail}`);
}

/**
 * The variable that names the `--changed` base, the way `--base` does (the flag
 * wins). The CLI reads it and the gate strips it from the check it spawns.
 */
export const BASE_ENV = 'CHECKRIDE_BASE';

/** The base `--changed` measures from when nothing names one, if it resolves. */
export const DEFAULT_BASE = 'origin/main';

/** A base someone named, and what named it (`--base`, the variable, the config), for the error when it doesn't resolve. */
export type NamedBase = { ref: string; from: string };

/** The base a `--changed` run measures from: the ref as given, and the commit it names (`null` when none does). */
export type ChangedBase = { ref: string; sha: string | null };

/** A resolved base, and the warning to print when it isn't the one asked for. */
export type BaseResolution = { base: ChangedBase; warning: string | null };

/** `git rev-parse` of `ref` as a commit: the sha on stdout, or why it names none. */
function commitOf(git: GitRunner, ref: string): Promise<GitResult> {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * Resolve the base a `--changed` run measures from. A named base must resolve:
 * one that names no commit, or that git can't read at all, throws, which the
 * CLI renders as exit 2, because narrowing against some other base than the one
 * asked for would check a different change. With nothing named, `origin/main`
 * is the base when it resolves, which is the base 0.13 hardcoded, and `HEAD`
 * otherwise. That fallback comes with a warning, since a sandbox clone without
 * `origin/main` narrows to uncommitted work alone.
 */
export async function resolveChangedBase(git: GitRunner, named: NamedBase | null): Promise<BaseResolution> {
  if (named !== null) {
    // A leading dash would reach git as an option, never as a ref.
    if (named.ref.startsWith('-')) throw new Error(`${named.from} '${named.ref}' is not a ref`);
    const result = await commitOf(git, named.ref);
    if (result.ok) return { base: { ref: named.ref, sha: result.stdout.trim() }, warning: null };
    if (result.error !== 'failed') throw gitFailureError(result, `--changed with ${named.from} '${named.ref}'`);
    throw new Error(`${named.from} '${named.ref}' doesn't name a commit`);
  }
  const fallback = await commitOf(git, DEFAULT_BASE);
  if (fallback.ok) return { base: { ref: DEFAULT_BASE, sha: fallback.stdout.trim() }, warning: null };
  const head = await commitOf(git, 'HEAD');
  const why = head.ok ? '' : ` (HEAD doesn't resolve either: ${headFailure(head)})`;
  return {
    base: { ref: 'HEAD', sha: head.ok ? head.stdout.trim() : null },
    warning: `--changed: ${DEFAULT_BASE} doesn't resolve, so changes are measured from HEAD${why}; name a base with --base, ${BASE_ENV} or changedBase`,
  };
}

/** The paths a `--changed` run counts as changed, or why git couldn't list them. */
export type ChangedPaths = { ok: true; paths: string[] } | { ok: false; why: string };

/** NUL-separated git output (`-z`) as its entries, so no path is quoted or split on a newline. */
function entries(stdout: string): string[] {
  return stdout.split('\0').filter((p) => p.length > 0);
}

/**
 * The paths a `--changed` run measures targets by (R10.2): every path that
 * differs between the merge base of `base` and `HEAD` and the work tree,
 * committed, staged or not, plus the untracked files git doesn't ignore. With
 * no merge base, as in a shallow clone, the base itself stands in. Paths are
 * relative to the directory git runs in, and only the ones under it are
 * listed. A rename lists its old path and its new one, since the directory a
 * file left changed too. `ok: false` when the base names no commit or git
 * can't answer, and then the run skips no target.
 */
export async function changedPaths(git: GitRunner, base: ChangedBase): Promise<ChangedPaths> {
  if (base.sha === null) return { ok: false, why: `${base.ref} names no commit` };
  const mergeBase = await git(['merge-base', base.sha, 'HEAD']);
  // `failed` is git's exit 1 for histories that share no commit.
  if (!mergeBase.ok && mergeBase.error !== 'failed') return { ok: false, why: mergeBase.detail };
  const from = mergeBase.ok ? mergeBase.stdout.trim() : base.sha;
  const [diff, untracked] = await Promise.all([
    git(['diff', '--name-only', '-z', '--no-renames', '--relative', from, '--']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (!diff.ok) return { ok: false, why: diff.detail };
  if (!untracked.ok) return { ok: false, why: untracked.detail };
  return { ok: true, paths: [...new Set([...entries(diff.stdout), ...entries(untracked.stdout)])].toSorted() };
}

/** Why `HEAD` names no commit, in a clause: a repository with no commits yet fails with nothing on stderr. */
function headFailure(result: { error: GitFailure; detail: string }): string {
  if (result.error === 'missing') return 'git is not on PATH';
  if (result.error === 'not-a-repo') return 'this is not a git repository';
  if (result.error === 'failed') return 'the repository has no commits yet';
  return result.detail;
}

/** How long a run waits on git for the summary's `git` record before leaving it out. */
export const GIT_STATE_TIMEOUT_MS = 5_000;

/** The commit a work tree has checked out, and whether it holds changes that commit doesn't. */
export type GitState = { head: string; dirty: boolean };

/**
 * `status` runs while the checks do, so it must not take the index lock to
 * refresh the index (`--no-optional-locks`), and it lists untracked files
 * whatever `status.showUntrackedFiles` says, so a new file can't read as clean.
 */
const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'] as const;

/**
 * The head and dirtiness of the work tree `git` runs in, or `null` when git
 * can't say: not a work tree, no commit yet, git missing, or slower than the
 * runner's timeout. It never rejects, because a run starts it before its checks
 * and awaits it after them, and a rejection left waiting that long would crash
 * the process.
 */
export async function readGitState(git: GitRunner): Promise<GitState | null> {
  try {
    const [head, status] = await Promise.all([commitOf(git, 'HEAD'), git(STATUS_ARGS)]);
    if (!head.ok || !status.ok) return null;
    return { head: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
  } catch {
    return null;
  }
}
