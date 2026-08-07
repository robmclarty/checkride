/**
 * Git plumbing for baseline recovery: reconstruct recent committed states of
 * `checkride.baseline.json` so a clobbered file (a botched merge, an agent
 * resolving a conflict by deleting the "problem" lines) can be restored without
 * manual archaeology. Everything here is read-only toward git — recovery writes
 * the file through `writeBaseline`, never `git checkout`, so a restore lands as
 * an ordinary reviewable working-tree edit.
 *
 * `git log --follow` is deliberately not used: the baseline's name and location
 * are constants ({@link BASELINE_FILE}), so history beyond a rename boundary
 * would describe a different file — and a repo that renamed the baseline is not
 * running stock checkride anyway.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Baseline } from './store.js';
import { BASELINE_FILE, BASELINE_SCHEMA_VERSION, baselinesEqual, parseBaseline } from './store.js';

const execFileP = promisify(execFile);

/** Why a git invocation failed, classified for user-facing messages. */
export type GitFailure = 'missing' | 'not-a-repo' | 'timeout' | 'failed';

export type GitResult = { ok: true; stdout: string } | { ok: false; error: GitFailure; detail: string };

/** Runs `git <args>`; injectable so history logic is testable without a repo. */
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 10_000;
/** A monorepo baseline can be large; a `git show` must not be truncated mid-blob. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** At most this many distinct snapshots are presented — a small set to choose from. */
const MAX_SNAPSHOTS = 5;

/** Commits of file history walked when `--depth` is not given. */
export const DEFAULT_DEPTH = 25;

/** The `code`/`killed`/`stderr` shape of a rejected `execFile`, checked not cast. */
function rejection(err: unknown): { code?: string; killed?: boolean; stderr?: string } {
  if (typeof err !== 'object' || err === null) return {};
  const out: { code?: string; killed?: boolean; stderr?: string } = {};
  if ('code' in err && typeof err.code === 'string') out.code = err.code;
  if ('killed' in err && typeof err.killed === 'boolean') out.killed = err.killed;
  if ('stderr' in err && typeof err.stderr === 'string') out.stderr = err.stderr;
  return out;
}

/** The real runner: `git` under `cwd`, with a timeout so recovery can't hang. */
export function realGit(cwd: string): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileP('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
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

/** The user-facing error for a failed git invocation; `runCli` renders it as exit 2. */
export function gitFailureError(result: { error: GitFailure; detail: string }): Error {
  if (result.error === 'missing') return new Error('recover: git is required but was not found on PATH');
  if (result.error === 'not-a-repo') return new Error('recover: not inside a git repository');
  return new Error(`recover: ${result.detail}`);
}

/** One commit that touched the baseline file. */
export type BaselineRevision = { sha: string; shortSha: string; date: string; author: string; subject: string };

export type Candidate =
  | { kind: 'snapshot'; rev: BaselineRevision; baseline: Baseline }
  | { kind: 'union'; baseline: Baseline; folded: number };

export type HistoryScan = {
  /** Union first (when it adds anything), then distinct snapshots newest-first. */
  candidates: Candidate[];
  /** Commits whose snapshot was actually examined (≤ the log's length). */
  walked: number;
  /** Short shas whose blob was unreadable or unparseable — skipped, never fatal. */
  skipped: string[];
  /** A shallow clone's log is truncated; said in the report, never an error. */
  shallow: boolean;
};

/**
 * Field/record separators keep `git log` parsing exact: a subject line may
 * contain anything printable, but never the unit or record separator bytes.
 */
const LOG_FORMAT = '%H%x1f%h%x1f%cI%x1f%an%x1f%s%x1e';

function parseLog(stdout: string): BaselineRevision[] {
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', shortSha = '', date = '', author = '', subject = ''] = record.split('\x1f');
      return { sha, shortSha, date, author, subject };
    })
    .filter((rev) => rev.sha.length > 0);
}

/**
 * Where the baseline lives relative to the *git* root — in a monorepo the
 * checkride root is often a subdirectory, and `git show <sha>:<path>` resolves
 * `<path>` from the repository root, not from cwd.
 */
async function locate(git: GitRunner): Promise<{ path: string; shallow: boolean }> {
  const result = await git(['rev-parse', '--show-toplevel', '--show-prefix', '--is-shallow-repository']);
  if (!result.ok) throw gitFailureError(result);
  const [, prefix = '', shallowWord = ''] = result.stdout.split('\n');
  return { path: `${prefix}${BASELINE_FILE}`, shallow: shallowWord.trim() === 'true' };
}

/** Whether the working-tree baseline carries uncommitted changes. */
export async function baselineDirty(git: GitRunner): Promise<boolean> {
  const result = await git(['status', '--porcelain', '--', BASELINE_FILE]);
  if (!result.ok) throw gitFailureError(result);
  return result.stdout.trim().length > 0;
}

/**
 * Walk the baseline file's recent commits and reconstruct a small candidate
 * set: each *distinct* historical state (a run of identical states keeps its
 * newest sha; states identical to `current` offer nothing and are dropped),
 * plus one synthesized union of everything walked. The walk stops early once
 * {@link MAX_SNAPSHOTS} distinct snapshots are held.
 *
 * The union is generous by construction and safe for the same reason: a
 * resurrected key that is stale gets pruned by the ratchet on the next full
 * green run, while a missing key is exactly the disease being cured. A blob
 * that fails {@link parseBaseline} is skipped and counted, never fatal — a
 * mangled historical copy must not block recovering from a mangled current one.
 */
type Walk = {
  snapshots: Extract<Candidate, { kind: 'snapshot' }>[];
  /** Every parsed state, duplicates included — what the union folds. */
  parsed: Baseline[];
  skipped: string[];
  walked: number;
};

/** Is this state worth presenting — different from current and from everything kept? */
function isNewState(baseline: Baseline, current: Baseline | null, kept: Walk['snapshots']): boolean {
  if (current !== null && baselinesEqual(baseline, current)) return false;
  return !kept.some((s) => baselinesEqual(s.baseline, baseline));
}

async function walkSnapshots(git: GitRunner, path: string, revisions: readonly BaselineRevision[], current: Baseline | null): Promise<Walk> {
  const walk: Walk = { snapshots: [], parsed: [], skipped: [], walked: 0 };
  for (const rev of revisions) {
    if (walk.snapshots.length >= MAX_SNAPSHOTS) break;
    walk.walked += 1;
    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the early-stop above only saves `git show` calls if they run one at a time.
    const show = await git(['show', `${rev.sha}:${path}`]);
    const baseline = show.ok ? parseBaseline(show.stdout) : null;
    if (baseline === null) {
      walk.skipped.push(rev.shortSha);
      continue;
    }
    walk.parsed.push(baseline);
    if (isNewState(baseline, current, walk.snapshots)) walk.snapshots.push({ kind: 'snapshot', rev, baseline });
  }
  return walk;
}

export async function collectCandidates(git: GitRunner, current: Baseline | null, depth: number): Promise<HistoryScan> {
  const located = await locate(git);
  const log = await git(['log', '-n', String(depth), `--format=${LOG_FORMAT}`, '--', located.path]);
  if (!log.ok) throw gitFailureError(log);
  const walk = await walkSnapshots(git, located.path, parseLog(log.stdout), current);

  const union = unionBaselines(current === null ? walk.parsed : [current, ...walk.parsed]);
  const unionAddsAnything = current === null ? walk.parsed.length > 0 : !baselinesEqual(union, current);
  const candidates: Candidate[] = [
    ...(unionAddsAnything ? [{ kind: 'union' as const, baseline: union, folded: walk.parsed.length }] : []),
    ...walk.snapshots,
  ];
  return { candidates, walked: walk.walked, skipped: walk.skipped, shallow: located.shallow };
}

/** Per-slot key union of every part, canonical (sorted slots and keys). */
export function unionBaselines(parts: readonly Baseline[]): Baseline {
  const merged = new Map<string, Set<string>>();
  for (const part of parts) {
    for (const [slot, keys] of Object.entries(part.slots)) {
      const set = merged.get(slot) ?? new Set<string>();
      for (const key of keys) set.add(key);
      merged.set(slot, set);
    }
  }
  const slots: Record<string, string[]> = {};
  for (const slot of [...merged.keys()].toSorted()) slots[slot] = [...(merged.get(slot) ?? [])].toSorted();
  return { schema_version: BASELINE_SCHEMA_VERSION, slots };
}

/** What applying `to` over `from` changes, per slot: keys gained and keys lost. */
export type BaselineDelta = {
  restored: Record<string, string[]>;
  absent: Record<string, string[]>;
  restoredCount: number;
  absentCount: number;
};

/**
 * `restored` is what an apply adds; `absent` is what only an `--exact` apply
 * would drop (the default union write never removes a key, so its `absent` side
 * is empty by construction — the renderer still shows it so `--exact`'s cost is
 * visible before it is paid).
 */
export function diffBaselines(from: Baseline | null, to: Baseline): BaselineDelta {
  const restored: Record<string, string[]> = {};
  const absent: Record<string, string[]> = {};
  let restoredCount = 0;
  let absentCount = 0;
  const slots = new Set([...Object.keys(from?.slots ?? {}), ...Object.keys(to.slots)]);
  for (const slot of [...slots].toSorted()) {
    const fromKeys = new Set(from?.slots[slot] ?? []);
    const toKeys = new Set(to.slots[slot] ?? []);
    const gained = [...toKeys].filter((k) => !fromKeys.has(k)).toSorted();
    const lost = [...fromKeys].filter((k) => !toKeys.has(k)).toSorted();
    if (gained.length > 0) {
      restored[slot] = gained;
      restoredCount += gained.length;
    }
    if (lost.length > 0) {
      absent[slot] = lost;
      absentCount += lost.length;
    }
  }
  return { restored, absent, restoredCount, absentCount };
}
