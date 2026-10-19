/**
 * `checkride/findings` — the parse API a reviewer or an agent reads a run's
 * findings through (D29, R12.1), so no consumer reimplements checkride's
 * parsers. It serves the same parsers the baseline keys with, minus the keys.
 *
 * It's best-effort and read-only: it never writes under the output directory,
 * never decides a verdict, and returns `null` for an adapter it has no parser
 * for, or output its parser can't trust. The raw artifact stays
 * authoritative. This file is the subpath's entry, so everything it exports is
 * public; the module's internals stay behind `./index.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Adapter } from '../adapters.js';
import { artifactStem } from '../artifacts/index.js';
import { PACKS } from '../packs/index.js';
import { parserFor } from './registry.js';
import type { Finding, FindingsCheck, FindingStream, KeyedFinding, ParseOptions } from './types.js';

export type { Finding, FindingsCheck, ParseOptions } from './types.js';

/** The first adapter row named `adapter` in any pack: where its default slot and registry args come from. */
function registryRow(adapter: string): Adapter | undefined {
  for (const pack of Object.values(PACKS)) {
    const row = pack.adapters.find((a) => a.name === adapter);
    if (row) return row;
  }
  return undefined;
}

/** A parser's finding as the API serves it: the adapter and slot on, the baseline key off. */
function served(adapter: string, slot: string, found: KeyedFinding): Finding {
  const { key: _key, slot: _slot, ...fields } = found;
  return { adapter, slot, ...fields };
}

/**
 * Whether `adapter`'s output can be parsed, decided by name. The set of
 * parseable adapters only grows.
 */
export function isParseable(adapter: string): boolean {
  return parserFor(adapter) !== undefined;
}

/**
 * Parse one adapter's raw output into findings, or `null` when the adapter has
 * no parser or its output can't be trusted (vale's runtime-error report, an
 * unreadable fallow report, oxlint or ast-grep output that isn't the JSON
 * shape they print). An empty array means parsed and clean.
 *
 * Without `argv`, a finding's `gates` follows the adapter's registry args,
 * the argv checkride spawns it with when no config overrides it (R12.3). A
 * finding's `slot` is `options.slot`, else the one its report names (fallow's
 * `kind`), else the adapter's own.
 */
export function parseFindings(adapter: string, raw: string, options: ParseOptions = {}): Finding[] | null {
  const parser = parserFor(adapter);
  if (parser === undefined) return null;
  const row = registryRow(adapter);
  const argv = options.argv ?? (row ? [row.command, ...row.args] : undefined);
  const found = parser.parse(raw, { argv, root: options.root, repoRoot: options.repoRoot });
  if (found === null) return null;
  return found.map((f) => served(adapter, options.slot ?? f.slot ?? row?.slot ?? adapter, f));
}

/**
 * The file under `runDir` that holds the stream a check's parser reads (D49):
 * the JSON artifact the summary names, else the captured stdout or stderr
 * text, under `<target>/` for a target's check.
 */
function artifactPath(check: FindingsCheck, runDir: string, stream: FindingStream): string {
  if (stream === 'artifact' && check.output_file !== null) return join(runDir, check.output_file);
  return join(runDir, `${artifactStem(check)}.${stream === 'stderr' ? 'stderr' : 'stdout'}.txt`);
}

/**
 * A file's text, `''` when it doesn't exist (a run writes no file for a
 * stream its check left empty), or `null` when it can't be read.
 */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? '' : null;
  }
}

/**
 * The findings of one `summary.json` check entry, read from the artifact its
 * run wrote under `runDir` (the output directory, `.check/` by default): its
 * `output_file`, else the `.stdout.txt` or `.stderr.txt` its parser declares
 * (D49). The entry's `cwd`, `argv` and slot rebase its paths and decide
 * `gates`; `repoRoot` relativizes a path a tool printed absolute. `null` for a
 * check with no parser, a skipped check, an artifact that can't be read, or
 * output its parser can't trust.
 */
export function findingsFor(check: FindingsCheck, runDir: string, options: { repoRoot: string }): Finding[] | null {
  if (check.adapter === null || check.skipped === true) return null;
  const parser = parserFor(check.adapter);
  if (parser === undefined) return null;
  const raw = readText(artifactPath(check, runDir, parser.stream));
  if (raw === null) return null;
  return parseFindings(check.adapter, raw, {
    slot: check.slot ?? check.name,
    root: check.cwd ?? '',
    repoRoot: options.repoRoot,
    ...(check.argv !== undefined ? { argv: check.argv } : {}),
  });
}
