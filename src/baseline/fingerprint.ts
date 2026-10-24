/**
 * Per-adapter diagnostic fingerprints.
 *
 * A *fingerprint* is a stable, order-independent set of key strings drawn from
 * one adapter's raw output. Each key names a single finding by what it is
 * (`<file>:<rule>:<message>`, or fallow's own forms) rather than where it
 * sits, so the baseline can subtract already-known findings without
 * re-flagging them every time surrounding code moves.
 *
 * This is deliberately NOT a normalized diagnostic schema: the raw
 * `.check/<slot>.json` stays authoritative. Every key comes from the adapter's
 * parser in `../findings` (D28), one per tool output format, so the baseline
 * and the findings a reader sees never drift apart; an adapter with no parser,
 * or one whose parser serves only `checkride/findings` (go build's, mypy's),
 * returns `null` — baseline is unsupported for that slot. A fingerprint keys
 * only the findings that can fail the check, so a finding that can only advise
 * never blocks masking, and each parser has already joined the check's root
 * onto the paths its tool printed, so a target's keys are repo-root-relative.
 *
 * The same registry style keys the *report verdicts* — the adapters whose
 * pass/fail is read from the parsed report rather than the exit code — on
 * adapter name, for the same reason: it is per-tool knowledge of one output
 * format, and it belongs beside the parser, not on the registry row.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CheckOutput, KeyedFinding, RunContext } from '../findings/index.js';
import { baselineParserFor, parserFor, streamText } from '../findings/index.js';
import type { FallowVerdict } from './fallow.js';
import type { BaselineEntry } from './store.js';
import { fallowVerdict } from './fallow.js';

/** A stable, order-independent set of diagnostic keys for one adapter's output. */
export type Fingerprint = ReadonlySet<string>;

/**
 * Each key of one adapter's output with how many findings share it: a key
 * names a finding by what it is, not where it sits, so two unchecked
 * `x.Close()` calls in one file are one key found twice. The baseline counts
 * against it, so a key grandfathers as many findings as it was captured with.
 */
export type Tally = ReadonlyMap<string, number>;

/**
 * The findings that can fail the check, by key. A finding whose parser can't
 * tell whether it gates is keyed: keying one that can't fail costs a false
 * red, while skipping one that can would mask a red run green.
 */
function gatingTally(findings: readonly KeyedFinding[]): Tally {
  const counted = new Map<string, number>();
  for (const { key, gates } of findings) {
    if (gates !== false) counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  return counted;
}

/** How many findings a tally holds, every key's count summed. */
export function tallied(counted: Tally): number {
  let total = 0;
  for (const n of counted.values()) total += n;
  return total;
}

/**
 * The text `adapter`'s parser reads out of what its check printed: the stream
 * the parser declares (D49), and stdout for an adapter with no parser. Every
 * reader that fingerprints a run hands this, never stdout by habit, so a tool
 * that reports on stderr reaches the baseline.
 */
export function findingText(adapter: string, output: CheckOutput): string {
  return streamText(output, parserFor(adapter)?.stream ?? 'stdout');
}

/**
 * Derives one slot's pass/fail (and its baseline bookkeeping) from the tool's
 * raw report instead of its exit code. `entry === null` means no baseline is
 * active — the same contract as {@link fallowVerdict} — and `root` is the
 * check's root, which its keys' paths are joined onto.
 */
type ReportVerdict = (raw: string, entry: BaselineEntry | null, root?: string) => FallowVerdict;

/**
 * Report verdicts keyed by adapter name (not slot), like the parsers: only
 * fallow today, whose exit code does not reliably gate (combined mode and
 * `dupes` exit 0 even with findings — see `./fallow.ts`). One registration
 * serves dead/dupes/health; the verdict dispatches on the report's `kind`. A
 * custom check that names itself `fallow` is gated this way too, exactly as it
 * is fingerprinted this way. The exit code is still recorded in the summary.
 */
const REPORT_VERDICTS: Readonly<Record<string, ReportVerdict>> = {
  fallow: fallowVerdict,
};

/** The report verdict registered for `adapter`, or `null` when its exit code is the verdict. */
export function reportVerdict(adapter: string): ReportVerdict | null {
  return REPORT_VERDICTS[adapter] ?? null;
}

/**
 * Fingerprint one adapter's raw output — the text {@link findingText} picks —
 * or `null` when the adapter has no parser the baseline keys with (baseline
 * unsupported for that slot). Keyed on adapter name, so an alternate tool that shares a slot with a
 * supported default (knip for `dead`) opts out until it grows its own parser.
 * A supported adapter with zero findings returns an
 * empty set, never `null` — "supported but clean" and "not observed" are
 * distinct, and masking and the ratchet depend on the difference.
 *
 * `null` therefore has three readings, and callers treat them the same way: no
 * parser for this adapter (decided by name, before any output); a parser
 * that read its output and could not trust it — vale's runtime-error report,
 * or a JSON format whose payload isn't the shape it prints (oxlint's
 * `diagnostics` record, ast-grep's array); or output that says the tool
 * stopped short of some of its errors, as tsc does on a syntax error, where
 * an error it never reached would read as fixed. Either way the run
 * contributes nothing to the baseline and prunes nothing from it. Whether the
 * *run* can be trusted is a further question this function doesn't ask; see
 * {@link observedTally}.
 *
 * `argv` is the check's command and then its args, as declared for the run
 * (`changedArgs` included under `--changed`). Only findings that can fail the
 * check under it are keyed; without it, oxlint and ast-grep key every finding.
 *
 * `root` is the directory the check ran from, relative to the repo root: a
 * target's root in multi-target mode. Each path a key carries is joined onto
 * it, so the key names the file from the repo root. Omitted, or `.`, the paths
 * stay as the tool printed them.
 *
 * `repoRoot` is the repo root's absolute path. A path a tool printed absolute
 * (staticcheck prints no other kind) is made relative to it, so the key names
 * the file the same way on every machine (R12.4). Omitted, an absolute path
 * stays as printed.
 */
export function fingerprint(
  adapter: string,
  raw: string,
  argv?: readonly string[],
  root?: string,
  repoRoot?: string,
): Fingerprint | null {
  const counted = tally(adapter, raw, argv, root, repoRoot);
  return counted === null ? null : new Set(counted.keys());
}

/**
 * Each key of `adapter`'s output with its findings as the tool printed them,
 * for an adapter whose parser's keys leave part of a message out (its
 * `printed`, as tsc's), or `null` for any other adapter, or output its parser
 * can't read. A reader showing such a key to a person or an agent shows these
 * lines instead, since the key no longer says which name or type each
 * finding is about. `argv`, `root` and `repoRoot` are {@link fingerprint}'s.
 */
export function printedByKey(
  adapter: string,
  raw: string,
  argv?: readonly string[],
  root?: string,
  repoRoot?: string,
): ReadonlyMap<string, readonly string[]> | null {
  const parser = parserFor(adapter);
  if (parser?.printed === undefined) return null;
  const found = parser.parse(raw, { argv, root, repoRoot });
  if (found === null) return null;
  const byKey = new Map<string, string[]>();
  for (const f of found) {
    const line = parser.printed(f);
    const under = byKey.get(f.key);
    if (under === undefined) byKey.set(f.key, [line]);
    else under.push(line);
  }
  return byKey;
}

/** {@link fingerprint}, with how many findings share each key: `null` exactly where it is. */
export function tally(adapter: string, raw: string, argv?: readonly string[], root?: string, repoRoot?: string): Tally | null {
  return tallyIn(adapter, raw, { argv, root, repoRoot });
}

/** The tally of `raw` read in `context`: `null` where {@link fingerprint} says, a run its parser says stopped short included. */
function tallyIn(adapter: string, raw: string, context: RunContext): Tally | null {
  const parser = baselineParserFor(adapter);
  if (parser === undefined) return null;
  const findings = parser.parse(raw, context);
  return findings === null || (parser.stoppedShort?.(findings, context) ?? null) !== null ? null : gatingTally(findings);
}

/**
 * The parts of a check's outcome the trust rule reads: its streams, its
 * verdict, its exit code, and the version its tool's pin named, when the run
 * recorded one.
 */
type ObservedOutcome = CheckOutput & { readonly ok: boolean; readonly exit_code: number; readonly tool_version?: string | undefined };

/** The text of the file at `path`, or `null` when it can't be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What a run hands a parser's `stoppedShort`: the parse context, both
 * streams, its tool's version, and, where the repo root is known, a reader of
 * the check's files from its root.
 */
function runContext(outcome: ObservedOutcome, argv?: readonly string[], root?: string, repoRoot?: string): RunContext {
  const read = repoRoot === undefined ? {} : { read: (path: string) => readText(join(repoRoot, root ?? '', path)) };
  return { argv, root, repoRoot, output: { stdout: outcome.stdout, stderr: outcome.stderr }, toolVersion: outcome.tool_version, ...read };
}

/**
 * Why a run of `adapter` stopped short of some of its errors, in its parser's
 * words, such as tsc's on a syntax error, or `null`: an adapter whose parser
 * can't say, output it can't read, or a run that reached every error. What a
 * run, a capture and `init` say of a check the baseline couldn't read for it.
 * `argv`, `root` and `repoRoot` are {@link fingerprint}'s.
 */
export function stoppedShortReason(
  adapter: string,
  outcome: ObservedOutcome,
  argv?: readonly string[],
  root?: string,
  repoRoot?: string,
): string | null {
  const parser = baselineParserFor(adapter);
  if (parser?.stoppedShort === undefined) return null;
  const context = runContext(outcome, argv, root, repoRoot);
  const findings = parser.parse(findingText(adapter, outcome), context);
  return findings === null ? null : parser.stoppedShort(findings, context);
}

/**
 * The tally one run *observed*: the one masking, the ratchet and a
 * `checkride baseline` capture all key from, so they can't disagree about which
 * runs count. `null` when there is nothing to observe — the adapter has no
 * parser, its parser couldn't trust the output, or the output says the tool
 * stopped short ({@link fingerprint}), which a run can tell from more than the
 * output its parser reads, its other stream and its tool's version
 * ({@link stoppedShortReason}) — and also when the check never reached a
 * verdict on its own findings:
 *
 * - `exit_code === -1`: a timeout, spawn failure or interrupt. Whatever the
 *   tool printed before it stopped is partial, so its findings say nothing
 *   about the ones it never got to.
 * - `!ok` with no finding: a refusal, missing setup, or a crash before the tool
 *   printed anything parseable. A line-based parser reads empty output as
 *   clean, and keying that would prune every grandfathered key.
 *
 * A clean run (`ok` with no findings) stays observed, so a slot whose debt was
 * all fixed still ratchets to empty. `argv`, `root` and `repoRoot` are
 * {@link fingerprint}'s.
 */
export function observedTally(
  adapter: string,
  outcome: ObservedOutcome,
  argv?: readonly string[],
  root?: string,
  repoRoot?: string,
): Tally | null {
  const current = tallyIn(adapter, findingText(adapter, outcome), runContext(outcome, argv, root, repoRoot));
  if (current === null || outcome.exit_code === -1 || (!outcome.ok && current.size === 0)) return null;
  return current;
}

/**
 * Whether an adapter can be fingerprinted (has a parser the baseline keys
 * with), decided by name without needing its output. `init --baseline` uses
 * this to tell which failing slots the baseline can grandfather from those
 * that must still fall back to a `false` disable. It answers for the adapter, not for a particular run: a
 * fingerprintable adapter can still yield `null` on output it can't trust, in
 * which case that run simply grandfathers nothing.
 */
export function isFingerprintable(adapter: string): boolean {
  return baselineParserFor(adapter) !== undefined;
}
