/**
 * Filesystem helpers shared by the per-harness hook writers.
 *
 * Every write `agent-setup` makes is idempotent — a second run must report
 * `changed: false` for every file — so the writers never write blind: they read
 * first, compare, and only then touch the disk. `dryRun` computes the same
 * result without writing anything.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** One file a hook writer produced, and whether this run actually changed it. */
export type HookFile = { path: string; changed: boolean };

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Write `content` to `cwd/rel` (creating directories) unless it already matches. */
export async function putFile(
  cwd: string,
  rel: string,
  content: string,
  opts: { dryRun: boolean; executable?: boolean },
): Promise<HookFile> {
  const path = join(cwd, rel);
  const raw = await readIfExists(path);
  const changed = raw !== content;
  if (changed && !opts.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    if (opts.executable) await chmod(path, 0o755);
  }
  return { path: rel, changed };
}

/**
 * Merge `next` into the JSON config at `cwd/rel` and write it back when it
 * changed. `merge` receives the parsed file — or `undefined` when there is none
 * — and returns the merged value; it must be idempotent.
 *
 * A malformed file is named in the error, so a consumer sees
 * `invalid .claude/settings.json: <reason>` instead of a bare `SyntaxError`
 * stack (mirrors `invalidConfig` in `config.ts`).
 */
export async function putJson<T>(
  cwd: string,
  rel: string,
  merge: (current?: T) => T,
  opts: { dryRun: boolean },
): Promise<HookFile> {
  const path = join(cwd, rel);
  const raw = await readIfExists(path);
  let current: T | undefined;
  if (raw !== null) {
    try {
      current = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid ${rel}: ${reason}`, { cause: err });
    }
  }
  const nextRaw = `${JSON.stringify(merge(current), null, 2)}\n`;
  const changed = raw !== nextRaw;
  if (changed && !opts.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, nextRaw);
  }
  return { path: rel, changed };
}
