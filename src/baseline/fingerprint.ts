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
 * or one whose parser serves only `checkride/findings` (a type checker's, D31),
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

import type { CheckOutput, KeyedFinding } from '../findings/index.js';
import { baselineParserFor, parserFor, streamText } from '../findings/index.js';
import type { FallowVerdict } from './fallow.js';
import { fallowVerdict } from './fallow.js';

/** A stable, order-independent set of diagnostic keys for one adapter's output. */
export type Fingerprint = ReadonlySet<string>;

/**
 * The keys of the findings that can fail the check. A finding whose parser
 * can't tell whether it gates is keyed: keying one that can't fail costs a
 * false red, while skipping one that can would mask a red run green.
 */
function gatingKeys(findings: readonly KeyedFinding[]): Fingerprint {
  return new Set(findings.filter((f) => f.gates !== false).map((f) => f.key));
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
 * raw report instead of its exit code. `baselineKeys === null` means no
 * baseline is active — the same contract as {@link fallowVerdict} — and `root`
 * is the check's root, which its keys' paths are joined onto.
 */
type ReportVerdict = (raw: string, baselineKeys: readonly string[] | null, root?: string) => FallowVerdict;

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
 * supported default (biome/eslint for `lint`, knip for `dead`) opts out until
 * it grows its own parser. A supported adapter with zero findings returns an
 * empty set, never `null` — "supported but clean" and "not observed" are
 * distinct, and masking and the ratchet depend on the difference.
 *
 * `null` therefore has two readings, and callers treat them the same way: no
 * parser for this adapter (decided by name, before any output), or a parser
 * that read its output and could not trust it — vale's runtime-error report,
 * or a JSON format whose payload isn't the shape it prints (oxlint's
 * `diagnostics` record, ast-grep's array). Either way the run contributes
 * nothing to the baseline and prunes nothing from it. Whether the *run* can be
 * trusted is a further question this function doesn't ask; see
 * {@link observedFingerprint}.
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
  const findings = baselineParserFor(adapter)?.parse(raw, { argv, root, repoRoot });
  return findings === undefined || findings === null ? null : gatingKeys(findings);
}

/** The parts of a check's outcome the trust rule reads: its streams, its verdict, and its exit code. */
type ObservedOutcome = CheckOutput & { readonly ok: boolean; readonly exit_code: number };

/**
 * The fingerprint one run *observed*: the one both the ratchet and a
 * `checkride baseline` capture key from, so the two can't disagree about which
 * runs count. `null` when there is nothing to observe — the adapter has no
 * parser or its parser couldn't trust the output ({@link fingerprint}) — and
 * also when the check never reached a verdict on its own findings:
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
export function observedFingerprint(
  adapter: string,
  outcome: ObservedOutcome,
  argv?: readonly string[],
  root?: string,
  repoRoot?: string,
): Fingerprint | null {
  const current = fingerprint(adapter, findingText(adapter, outcome), argv, root, repoRoot);
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
