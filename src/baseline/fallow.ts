/**
 * Fallow's gating verdict: pass/fail for its three slots, read from its
 * parsed report rather than its process exit code.
 *
 * Fallow fills three slots — `dead` (dead-code), `dupes` (duplication), and
 * `health` (complexity) — and checkride owns the pass/fail *verdict* for all
 * three by parsing fallow's JSON, rather than trusting its process exit code.
 * That is deliberate: fallow 3.5.0's exit code does NOT reliably gate. Verified
 * against fallow 3.5.0:
 *   - `fallow --format json --fail-on-issues` (combined) exits 0 with issues.
 *   - `fallow dupes --format json` exits 0 no matter how much duplication (its
 *     `--threshold` defaults to `0` = "no limit").
 *   - only `fallow dead-code`/`health` with `--fail-on-issues` exit 1 on findings.
 * Keying pass/fail off the exit code (as the orchestrator does for every other
 * adapter) therefore let a green ✔ hide real findings. checkride reads the
 * authoritative issue count out of the JSON instead, so every fallow slot gates
 * uniformly — and an *unrecognized* schema fails loudly rather than passing
 * silently (the count can't be trusted, so the slot can't be green). The report
 * itself is read by fallow's parser in `../findings`, the same one its
 * fingerprint comes from.
 */

import { parseFallowReport } from '../findings/index.js';
import type { Tally } from './fingerprint.js';
import type { BaselineEntry, Excess } from './store.js';
import { applyBaseline } from './store.js';

/** The verdict for one fallow slot: pass/fail plus the baseline bookkeeping. */
export type FallowVerdict = {
  /** Slot verdict after baseline masking. */
  ok: boolean;
  /** Current findings the baseline grandfathered (the `baselined` count). */
  baselined: number;
  /** Sorted current findings the baseline does NOT cover. */
  newKeys: string[];
  /** Keys the baseline holds that this run found more often than it grandfathers. */
  excess: Excess[];
  /** How many current findings the baseline didn't grandfather. */
  newFindings: number;
  /** All current findings, by key — fed to the ratchet's observed map. */
  findings: Tally;
  /**
   * True only when the report parsed to a recognized schema. The ratchet must
   * not prune a slot's baseline from an *unreadable* run (findings unknown, not
   * "all fixed"), so an unobserved slot is preserved untouched.
   */
  observed: boolean;
  /** A one-line failure explanation for the console, or `null` when green. */
  reason: string | null;
};

/**
 * Decide a fallow slot's verdict from its raw JSON and (optionally) the slot's
 * baseline entry. `entry === null` means no baseline is active (a
 * plain run or a `checkride baseline` capture): the verdict is simply whether
 * fallow found anything. With a baseline, findings are masked — the slot passes
 * when every current finding is grandfathered and fails on any new one.
 *
 * A report whose keys don't map one-per-finding onto its issue count — an
 * un-keyable finding, or a key produced for something the count doesn't include
 * — has findings that can't be individually grandfathered; a baseline must never
 * mask such a slot to green, so it stays at the raw findings-based verdict. A key
 * *collision* (two findings sharing a key) is not un-keyable — both are keyed,
 * and the key's count says how many share it, so a counted baseline
 * grandfathers both and no third, and one captured before counts any number.
 * Correctness over precision: better to keep re-surfacing a finding than to
 * silently pass one. `root` is the check's root, which the keys' paths are
 * joined onto, as fallow's parser joins them for its fingerprint.
 */
export function fallowVerdict(raw: string, entry: BaselineEntry | null, root?: string): FallowVerdict {
  const parsed = parseFallowReport(raw, { root });
  if (!parsed.ok) {
    return { ok: false, baselined: 0, newKeys: [], excess: [], newFindings: 0, findings: new Map(), observed: false, reason: parsed.reason };
  }
  // Every counted fallow finding gates, so every key is a gating key.
  const findings = new Map<string, number>();
  for (const { key } of parsed.findings) findings.set(key, (findings.get(key) ?? 0) + 1);
  const rawOk = parsed.issueCount === 0;
  const issueReason = rawOk ? null : `${parsed.issueCount} finding(s)`;

  if (entry === null) {
    return { ok: rawOk, baselined: 0, newKeys: [], excess: [], newFindings: 0, findings, observed: true, reason: issueReason };
  }

  const adj = applyBaseline(findings, entry, rawOk);
  // Findings the keys don't cover block masking: hold the slot at its raw
  // verdict. A key collision does NOT (both findings are keyed, so the report
  // stays fully tracked), so it coarsens the baseline instead of disabling it. A
  // *deduplicated* size comparison could not tell the two apart, which is what
  // disabled the whole slot on any collision.
  const masked = { baselined: adj.baselined, newKeys: adj.newKeys, excess: adj.excess, newFindings: adj.newFindings, findings, observed: true };
  if (!parsed.fullyTracked) return { ok: rawOk, ...masked, reason: issueReason };
  // Fully tracked: a masked slot (all findings grandfathered) is green; a slot
  // that fails does so on `newKeys` and `excess`, which the orchestrator lists —
  // so no extra reason line is needed either way.
  return { ok: adj.ok, ...masked, reason: null };
}
