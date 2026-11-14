/**
 * `checkride recover` — rebuild `checkride.baseline.json` from git history.
 *
 * The incident this exists for: a merge (often an agent resolving a conflict by
 * deleting the "problem" lines) silently drops baseline entries. Missing
 * entries fail closed, so the next run is a wall of red with no explanation and
 * the remedy used to be manual git archaeology. `recover` does the dig: it
 * walks the file's recent commits, dedupes the distinct states, and presents a
 * small candidate set with deltas; `--pick` applies one.
 *
 * A baseline spread over more than one file, a local target's own beside the
 * root one, is recovered whole: the commits that touched any of its files
 * are walked, each read as the one baseline a run would have masked with,
 * and an apply writes each restored key to the file that owns its check, and
 * only the files that change. The files come from the config, and a config
 * that can't be read, which the same bad merge may have mangled, is a
 * warning: the root file is recovered alone.
 *
 * Applying writes the file through `writeBaseline` — never `git checkout` — so
 * a restore lands as an ordinary working-tree edit the author reviews and
 * commits. The default write is the UNION of the candidate and the current
 * file: nothing is removed, and a resurrected key that is stale gets pruned by
 * the ratchet on the next full green run. That generosity is also why a bare
 * `checkride baseline` is the wrong remedy here — a re-capture would
 * grandfather genuinely new debt introduced since the damage.
 *
 * Exit codes: 0 listed or applied, 2 usage or environment error — never 1;
 * nothing here is a check failure. Stream discipline: the listing (Markdown or
 * `--json`) is the machine output on stdout; apply confirmations are human
 * prose on stderr.
 */

import type { Baseline, BaselineDelta, Candidate, HistoryScan, ShardChange, ShardsRead } from './baseline/index.js';
import {
  baselinesDirty,
  baselinesEqual,
  collectCandidates,
  countBaselineKeys,
  DEFAULT_DEPTH,
  diffBaselines,
  readShards,
  readShardsAt,
  recoverShards,
  shardMap,
  treeAt,
  unionBaselines,
  writeBaseline,
  writeShards,
} from './baseline/index.js';
import type { CheckrideConfig } from './config.js';
import { targetsDeclaredAt, targetsForBaseline } from './config.js';
import type { GitRunner } from './git.js';
import { realGit } from './git.js';
import type { Out } from './orchestrator/index.js';
import type { Suite } from './suite.js';
import { DEFAULT_SUITE, suiteCommand } from './suite.js';

export type RecoverOptions = {
  cwd?: string;
  /** `union`, a listing number, or a sha prefix (≥ 4 hex chars). Absent → list. */
  pick?: string;
  /** Write the picked snapshot verbatim instead of the union with current. */
  exact?: boolean;
  /** Preview what `--pick` would change; write nothing. */
  dryRun?: boolean;
  /** Commits of file history to walk (default {@link DEFAULT_DEPTH}). */
  depth?: number;
  /** Emit the listing / apply result as JSON on stdout. */
  json?: boolean;
  stdout?: Out;
  stderr?: Out;
  /** The named suite whose baseline is recovered, from the history of its own file; the default suite's when omitted. */
  suite?: Suite;
  /**
   * The config whose targets say which files the baseline is spread over,
   * already loaded, or `configPath`, the file `--config` or
   * `CHECKRIDE_CONFIG` named, which stands for every commit walked. With
   * neither, the repo's own config is read, and each commit's own.
   */
  config?: CheckrideConfig | null;
  configPath?: string;
  /** Injectable for tests. */
  git?: GitRunner;
};

export type RecoverResult = { ok: boolean; exitCode: number };

/** Everything a listing or an apply needs, resolved once. */
type RecoverContext = {
  cwd: string;
  /** The suite whose baseline file is being recovered, which every command this one names carries. */
  suite: Suite;
  /** Every file of the baseline as the working tree holds it, read as one: `state` is the root file's. */
  read: ShardsRead;
  scan: HistoryScan;
  dirty: boolean;
  json: boolean;
  stdout: Out;
  stderr: Out;
};

const EMPTY_BASELINE: Baseline = { schema_version: 1, slots: {} };

/** Keys shown per slot in a `--dry-run` preview before eliding the rest. */
const PREVIEW_KEYS_PER_SLOT = 20;

export async function runRecover(options: RecoverOptions): Promise<RecoverResult> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (options.exact && options.pick === undefined) {
    throw new Error('recover: --exact requires --pick (it says how to write the picked candidate)');
  }
  const git = options.git ?? realGit(cwd);
  const suite = options.suite ?? DEFAULT_SUITE;
  const file = suite.baselineFile;
  const { read, oneConfig } = workingBaseline(options, cwd, suite, stderr);
  const others = read.map.shards.map((shard) => shard.file);
  // A commit's files are read as one baseline, by its own config's map and the working tree's; one it can't read whole is skipped.
  const snapshot = async (sha: string): Promise<Baseline | null> => {
    const declared = oneConfig ? null : (at: (path: string) => Promise<string | null>) => targetsDeclaredAt(at, suite.configFile);
    return readShardsAt(await treeAt(git, sha), sha, read.map, declared).then((at) => at.baseline, () => null);
  };
  const scan = await collectCandidates(git, read.baseline, options.depth ?? DEFAULT_DEPTH, file, others.length === 0 ? undefined : { files: others, snapshot });
  const dirty = await baselinesDirty(git, [file, ...others]);
  const ctx: RecoverContext = { cwd, suite, read, scan, dirty, json: options.json ?? false, stdout, stderr };

  if (options.pick === undefined) {
    ctx.stdout.write(ctx.json ? `${JSON.stringify(listingJson(ctx), null, 2)}\n` : renderListing(ctx));
    return { ok: true, exitCode: 0 };
  }
  return apply(ctx, options.pick, options.exact ?? false, options.dryRun ?? false);
}

/**
 * The working tree's baseline, every file of it, with whether one config
 * stands for every commit walked. A config that can't be read is said on
 * stderr, since the root file is then recovered alone.
 */
function workingBaseline(options: RecoverOptions, cwd: string, suite: Suite, stderr: Out): { read: ShardsRead; oneConfig: boolean } {
  const declared = targetsForBaseline(cwd, suite, options);
  if (declared.problem !== null) writeLine(stderr, `recover: can't read the config (${declared.problem}), so it recovers ${suite.baselineFile} alone`);
  return { read: readShards(cwd, shardMap(suite.baselineFile, declared.targets)), oneConfig: declared.oneConfig };
}

/** True when the baseline is spread over more than the root file. */
function spread(ctx: RecoverContext): boolean {
  return ctx.read.map.shards.length > 0;
}

/** Resolve a sha-prefix `--pick` against the listed snapshots. */
function resolveShaPick(scan: HistoryScan, pick: string, suite: Suite): Candidate {
  if (!/^[0-9a-f]{4,40}$/i.test(pick)) {
    throw new Error(`recover: --pick expects \`union\`, a listing number, or a sha prefix of at least 4 hex characters, got '${pick}'`);
  }
  const matches = scan.candidates.filter((c) => c.kind === 'snapshot' && c.rev.sha.startsWith(pick.toLowerCase()));
  const first = matches[0];
  if (first && matches.length === 1) return first;
  if (matches.length > 1) throw new Error(`recover: --pick ${pick} is ambiguous (${matches.length} listed candidates match)`);
  throw new Error(`recover: --pick ${pick} matches none of the listed candidates (run \`${suiteCommand('checkride recover', suite)}\` to list them)`);
}

/** Resolve `--pick` against the scan: `union`, a 1-based index, or a sha prefix. */
function resolvePick(scan: HistoryScan, pick: string, suite: Suite): Candidate {
  if (scan.candidates.length === 0) {
    throw new Error(`recover: no committed history of ${suite.baselineFile} differs from the current file — nothing to pick`);
  }
  if (pick === 'union') {
    const union = scan.candidates.find((c) => c.kind === 'union');
    if (!union) throw new Error('recover: the union of recent history adds nothing to the current baseline');
    return union;
  }
  if (/^\d+$/.test(pick)) {
    const candidate = scan.candidates[Number(pick) - 1];
    if (!candidate) throw new Error(`recover: --pick ${pick} is out of range (1..${scan.candidates.length})`);
    return candidate;
  }
  return resolveShaPick(scan, pick, suite);
}

/** The human name of a pick, for confirmations: `union of N snapshot(s)` or `snapshot <sha>`. */
function describe(candidate: Candidate): string {
  return candidate.kind === 'union' ? `union of ${candidate.folded} snapshot(s)` : `snapshot ${candidate.rev.shortSha}`;
}

/**
 * Everything an apply decided, threaded to the branch that acts on it:
 * `changes` is each file it writes, the root file alone for a baseline that
 * isn't spread, and none when the target changes nothing.
 */
type Apply = { candidate: Candidate; exact: boolean; target: Baseline; delta: BaselineDelta; changes: readonly ShardChange[] };

/**
 * Turn `--pick` into an {@link Apply}. The union write is dirty-safe by
 * construction (current keys survive), so only `--exact` — which discards
 * keys, unrecoverable once overwritten — is gated on a clean file.
 */
function resolveApply(ctx: RecoverContext, pick: string, exact: boolean, dryRun: boolean): Apply {
  const candidate = resolvePick(ctx.scan, pick, ctx.suite);
  const current = ctx.read.baseline;
  if (exact && ctx.dirty && !dryRun) {
    throw new Error(
      `recover: ${ctx.suite.baselineFile} has uncommitted changes and --exact would discard them — commit or stash first, or drop --exact (the default union keeps them)`,
    );
  }
  const target = exact ? candidate.baseline : unionBaselines(current === null ? [candidate.baseline] : [current, candidate.baseline]);
  return { candidate, exact, target, delta: diffBaselines(current, target), changes: changesFor(ctx, target) };
}

/**
 * The files an apply writes for `target`. A baseline that is the root file
 * alone is written whole when the target differs from it, as it always was;
 * one spread over more files has each key written to the file that owns its
 * check, and only the files that change (`recoverShards`).
 */
function changesFor(ctx: RecoverContext, target: Baseline): ShardChange[] {
  if (spread(ctx)) return recoverShards(ctx.read, target);
  return baselinesEqual(target, ctx.read.baseline ?? EMPTY_BASELINE) ? [] : [{ file: ctx.suite.baselineFile, baseline: target }];
}

/** The files an apply writes, as a message names them: the root file for a baseline that isn't spread, even one it leaves as it is. */
function filesNamed(ctx: RecoverContext, a: Apply): string {
  return spread(ctx) && a.changes.length > 0 ? a.changes.map((c) => c.file).join(', ') : ctx.suite.baselineFile;
}

/** Emit an apply outcome: the machine shape on stdout when `--json`, else nothing. */
function emitApply(ctx: RecoverContext, action: 'written' | 'dry-run' | 'noop', a: Apply): RecoverResult {
  if (ctx.json) ctx.stdout.write(`${JSON.stringify(applyJson(action, a, ctx), null, 2)}\n`);
  return { ok: true, exitCode: 0 };
}

async function apply(ctx: RecoverContext, pick: string, exact: boolean, dryRun: boolean): Promise<RecoverResult> {
  const a = resolveApply(ctx, pick, exact, dryRun);
  if (dryRun) {
    if (!ctx.json) ctx.stdout.write(renderPreview(a, filesNamed(ctx, a)));
    return emitApply(ctx, 'dry-run', a);
  }
  if (a.changes.length === 0) {
    writeLine(ctx.stderr, `recover: nothing to write — ${describe(a.candidate)} changes nothing against the current file`);
    return emitApply(ctx, 'noop', a);
  }
  // The one file of a baseline that isn't spread is written whole, as it always was.
  if (spread(ctx)) await writeShards(ctx.cwd, a.changes);
  else await writeBaseline(ctx.cwd, a.target, ctx.suite.baselineFile);
  const dropped = a.delta.absentCount > 0 ? `, −${a.delta.absentCount} dropped (--exact)` : '';
  writeLine(
    ctx.stderr,
    `recover: wrote ${filesNamed(ctx, a)} — +${a.delta.restoredCount} key(s) restored${dropped} (${a.exact ? 'exact copy of' : 'union with'} ${describe(a.candidate)}); review with \`git diff\` and commit`,
  );
  return emitApply(ctx, 'written', a);
}

function writeLine(out: Out, line: string): void {
  out.write(`${line}\n`);
}

/** One file's state as a listing reads it: how it read, and the baseline it gave. */
type FileState = Pick<ShardsRead['files'][number], 'state' | 'baseline'>;

/** The `- file:` line — the reader's first question is what state the file is in. */
function fileLine(file: string, read: FileState, dirty: boolean): string {
  if (read.state === 'absent') return `- file: \`${file}\` — ABSENT`;
  if (read.state === 'unparseable') return `- file: \`${file}\` — present but unparseable (treated as no baseline)`;
  if (read.state === 'outside') return `- file: \`${file}\` — resolves outside the repository (never read or written)`;
  const baseline = read.baseline ?? EMPTY_BASELINE;
  const keys = countBaselineKeys(baseline);
  const slots = Object.keys(baseline.slots).length;
  return `- file: \`${file}\` — present, ${keys} key(s) across ${slots} slot(s)${dirty ? ', with uncommitted changes' : ''}`;
}

/**
 * The `- file:` lines: one for the root file, as it always read, and one
 * for each file at a target's root when the baseline is spread, where
 * `with uncommitted changes` is said once, of them together.
 */
function fileLines(ctx: RecoverContext): string[] {
  const { read, dirty } = ctx;
  if (!spread(ctx)) return [fileLine(ctx.suite.baselineFile, read, dirty)];
  return [...read.files.map((file) => fileLine(file.file, file, false)), ...(dirty ? ['- note: the baseline has uncommitted changes'] : [])];
}

function candidateRow(candidate: Candidate, index: number, current: Baseline | null): string {
  const delta = diffBaselines(current, candidate.baseline);
  const keys = countBaselineKeys(candidate.baseline);
  const vs = `+${delta.restoredCount} / −${delta.absentCount}${delta.recountedCount > 0 ? ` / ~${delta.recountedCount}` : ''}`;
  if (candidate.kind === 'union') {
    return `| ${index} | union (${candidate.folded} snapshot(s) + current) | — | — | — | ${keys} | ${vs} |`;
  }
  const { rev } = candidate;
  return `| ${index} | snapshot | ${rev.shortSha} | ${rev.date.slice(0, 10)} | ${rev.author} | ${keys} | ${vs} |`;
}

function renderListing(ctx: RecoverContext): string {
  const { suite, read, scan } = ctx;
  const file = suite.baselineFile;
  const lines: string[] = ['# checkride recover — baseline candidates from git history', ''];
  lines.push(...fileLines(ctx));
  const skipped = scan.skipped.length > 0 ? `; skipped ${scan.skipped.length} unreadable snapshot(s): ${scan.skipped.join(', ')}` : '';
  lines.push(`- walked: ${scan.walked} commit(s)${skipped}`);
  if (scan.shallow) lines.push('- note: history is shallow (truncated); `git fetch --unshallow` reveals more');
  lines.push('');
  if (scan.walked === 0) {
    lines.push(`No committed history of ${file} — nothing to recover.`, '');
    return lines.join('\n');
  }
  if (scan.candidates.length === 0) {
    lines.push('The current file matches every recent committed state — nothing to recover.', '');
    return lines.join('\n');
  }
  lines.push('| # | candidate | commit | date | author | keys | vs current |');
  lines.push('| - | --------- | ------ | ---- | ------ | ---- | ---------- |');
  scan.candidates.forEach((candidate, i) => lines.push(candidateRow(candidate, i + 1, read.baseline)));
  lines.push(
    '',
    '`vs current` is +keys an apply restores / −keys only `--exact` would drop,',
    'and ~keys whose count `--exact` would change, when there are any.',
    '',
    `Apply: \`${suiteCommand('checkride recover', suite)} --pick <#>\` by number, or \`--pick <sha>\` by commit`,
    '(stable across invocations — prefer it in scripts). Preview with `--dry-run`.',
    '',
    'The default write is the union of the candidate and the current file: nothing',
    'is removed, and a stale resurrected key is pruned by the ratchet on the next',
    'full green run. `--exact` writes the snapshot verbatim instead.',
    '',
  );
  return lines.join('\n');
}

/** One preview section: a slot's changed keys, elided past the cap. */
function pushKeySection(lines: string[], slot: string, keys: readonly string[], verb: string): void {
  lines.push(`## ${slot} — ${keys.length} ${verb}`, '');
  for (const key of keys.slice(0, PREVIEW_KEYS_PER_SLOT)) lines.push(`- ${key}`);
  if (keys.length > PREVIEW_KEYS_PER_SLOT) lines.push(`- … and ${keys.length - PREVIEW_KEYS_PER_SLOT} more`);
  lines.push('');
}

/** The `--dry-run` preview: the per-slot keys an apply would restore (and drop, under `--exact`). */
function renderPreview(a: Apply, file: string): string {
  const lines: string[] = [`# checkride recover — dry run: ${describe(a.candidate)}${a.exact ? ' (--exact)' : ''}`, ''];
  lines.push(`Would write ${file} with ${countBaselineKeys(a.target)} key(s): +${a.delta.restoredCount} restored, −${a.delta.absentCount} dropped.`, '');
  for (const [slot, keys] of Object.entries(a.delta.restored)) pushKeySection(lines, slot, keys, 'restored');
  for (const [slot, keys] of Object.entries(a.delta.absent)) pushKeySection(lines, slot, keys, 'dropped under --exact');
  for (const [slot, recounts] of Object.entries(a.delta.recounted)) pushKeySection(lines, slot, Object.entries(recounts).map(([key, r]) => `${key} (${r.from ?? 'any'} → ${r.to ?? 'any'})`), 'recounted');
  if (a.delta.restoredCount === 0 && a.delta.absentCount === 0 && a.delta.recountedCount === 0) lines.push('No changes against the current file.', '');
  return lines.join('\n');
}

/** The machine listing. Documented in help/README; not part of the artifact contract. */
function listingJson(ctx: RecoverContext): unknown {
  const { read, scan, dirty } = ctx;
  return {
    schema_version: 1,
    file: {
      state: read.state,
      keys: read.baseline === null ? 0 : countBaselineKeys(read.baseline),
      dirty,
    },
    // Each file of a baseline spread over more than one, the root file first; `file` above then counts them together.
    ...(spread(ctx) ? { files: read.files.map((f) => ({ file: f.file, state: f.state, keys: f.baseline === null ? 0 : countBaselineKeys(f.baseline) })) } : {}),
    walked: scan.walked,
    shallow: scan.shallow,
    skipped: scan.skipped,
    candidates: scan.candidates.map((candidate, i) => {
      const delta = diffBaselines(read.baseline, candidate.baseline);
      const common = { index: i + 1, keys: countBaselineKeys(candidate.baseline), restored: delta.restoredCount, absent: delta.absentCount, recounted: delta.recountedCount };
      return candidate.kind === 'union'
        ? { kind: 'union', folded: candidate.folded, ...common }
        : { kind: 'snapshot', sha: candidate.rev.sha, short_sha: candidate.rev.shortSha, date: candidate.rev.date, author: candidate.rev.author, subject: candidate.rev.subject, ...common };
    }),
  };
}

function applyJson(action: 'written' | 'dry-run' | 'noop', a: Apply, ctx: RecoverContext): unknown {
  return {
    schema_version: 1,
    action,
    file: ctx.suite.baselineFile,
    // The files written, or that a dry run would write, for a baseline spread over more than one.
    ...(spread(ctx) ? { files: a.changes.map((c) => c.file) } : {}),
    pick: a.candidate.kind === 'union' ? 'union' : a.candidate.rev.sha,
    mode: a.exact ? 'exact' : 'union',
    keys: countBaselineKeys(a.target),
    restored: a.delta.restoredCount,
    dropped: a.delta.absentCount,
    recounted: a.delta.recountedCount,
  };
}
