/**
 * Token-bounded failure digest.
 *
 * After a run, `--digest` writes a capped Markdown excerpt of the *failing*
 * slots to `.check/digest.md` so an agent working through a big red repo spends
 * its context on a bounded index instead of every raw `.check/<slot>.json`. The
 * digest is an INDEX, never a replacement: it truncates (the first N findings
 * per slot, a total byte budget) and never normalizes — each section points
 * back at the authoritative raw file, which this module never touches.
 *
 * It reuses the baseline module's per-adapter fingerprint extractors to list a
 * slot's findings (render the first N of the same items); a slot whose adapter
 * has no extractor falls back to a tail of its raw text. A green run has nothing
 * to digest, so {@link writeDigest} removes any stale `.check/digest.md` — the
 * file's presence always means "this run had failures".
 *
 * The `../digest` barrel (`index.ts`) is this module's only public surface;
 * siblings import from there, never from this file directly.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Adapter } from '../adapters.js';
import { writeFileAtomic } from '../atomic.js';
import { fingerprint } from '../baseline/index.js';
import type { CheckOutcome } from '../links.js';
import type { CheckRun, SummaryCheck } from '../orchestrator.js';

/** The digest file, beside `summary.json` under the gitignored `.check/`. */
export const DIGEST_FILE = 'digest.md';

/** Caps that keep the digest token-bounded. Truncation, never normalization. */
export type DigestBudget = {
  /** Max findings rendered per failing slot; the rest collapse to a "… N more" line. */
  maxItemsPerSlot: number;
  /** Max total bytes of the rendered Markdown; whole sections drop past it. */
  maxBytes: number;
};

/**
 * Conservative defaults: ~10 findings a slot and an 8 KB ceiling keep even a
 * fully red repo's digest to roughly two thousand tokens — small enough to read
 * in one gulp, with the raw files a click away for the rest.
 */
const DEFAULT_BUDGET: DigestBudget = { maxItemsPerSlot: 10, maxBytes: 8000 };

/** Whether a string parses as JSON (mirrors the orchestrator's persist rule). */
function isJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `.check/` path holding the bytes this section excerpts — matched to how
 * {@link import('../orchestrator.js')} persisted them: an adapter's JSON output
 * lands in `.check/<outputFile>`, everything else in `<slot>.stdout.txt` /
 * `<slot>.stderr.txt`. Points the agent at exactly what to read for the full
 * diagnostics.
 */
function rawPointer(adapter: Adapter, outcome: CheckOutcome): string {
  if (adapter.outputFile && isJson(outcome.stdout)) return `.check/${adapter.outputFile}`;
  if (outcome.stdout.trim()) return `.check/${adapter.slot}.stdout.txt`;
  if (outcome.stderr.trim()) return `.check/${adapter.slot}.stderr.txt`;
  return '.check/summary.json';
}

/** Non-empty lines of the raw text, used by the tail fallback. */
function contentLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Render one failing slot's section. When the adapter can be fingerprinted, list
 * the first N finding keys (the same items the baseline records); otherwise fall
 * back to the last N lines of raw text — where a compiler or test runner puts
 * its summary. Either way the section is capped and points at the raw file.
 */
function renderSection(run: CheckRun, maxItems: number): string {
  const { slot, adapter, outcome } = run;
  const raw = rawPointer(adapter, outcome);
  const heading = `## ${slot} — ${adapter.name}`;

  const keys = fingerprint(adapter.name, outcome.stdout);
  if (keys && keys.size > 0) {
    const all = [...keys];
    const shown = all.slice(0, maxItems);
    const lines = shown.map((k) => `- ${k}`);
    if (all.length > shown.length) {
      lines.push(`- … ${all.length - shown.length} more (see \`${raw}\`)`);
    }
    return `${heading}\n\nRaw: \`${raw}\` — ${all.length} finding(s)\n\n${lines.join('\n')}\n`;
  }

  // No extractor (tsc, vitest, …) or a supported adapter that failed with no
  // parsed findings: excerpt the tail of the raw text — truncation, not
  // normalization — and point at the file for the rest.
  const text = outcome.stdout.trim() ? outcome.stdout : outcome.stderr;
  const all = contentLines(text);
  if (all.length === 0) {
    return `${heading}\n\nRaw: \`${raw}\` — exited ${outcome.exit_code} with no captured output\n`;
  }
  const tail = all.slice(-maxItems);
  const note = tail.length < all.length ? ` — last ${tail.length} of ${all.length} lines` : '';
  return `${heading}\n\nRaw: \`${raw}\`${note}\n\n\`\`\`\n${tail.join('\n')}\n\`\`\`\n`;
}

/**
 * Build the Markdown digest for a completed run, or `null` when nothing failed.
 * A check is "failing" when the summary marks it `ok: false` and not skipped —
 * so a slot whose findings a baseline fully grandfathers (still `ok: true`) is
 * correctly absent. Sections are added in summary (cheapest-first) order until
 * the byte budget is spent; any remaining failing slots are named in a trailing
 * note rather than silently dropped.
 */
export function buildDigest(
  runs: readonly CheckRun[],
  checks: readonly SummaryCheck[],
  budget: DigestBudget = DEFAULT_BUDGET,
): string | null {
  const failing = checks.filter((c) => !c.ok && !c.skipped);
  if (failing.length === 0) return null;

  const runBySlot = new Map(runs.map((r) => [r.slot, r]));
  let out =
    `# checkride failure digest\n\n` +
    `${failing.length} of ${checks.length} check(s) failed. Excerpt only — up to ` +
    `${budget.maxItemsPerSlot} finding(s) per slot; read each linked raw file under ` +
    `\`.check/\` for the complete, authoritative diagnostics.\n`;

  let rendered = 0;
  for (const check of failing) {
    const run = runBySlot.get(check.name);
    // A failing non-skipped check always has a run; keep a minimal fallback so a
    // future code path that summarizes a failure without a run can't crash here.
    const section = run
      ? `\n${renderSection(run, budget.maxItemsPerSlot)}`
      : `\n## ${check.name} — ${check.adapter ?? 'unknown'}\n\nRaw: \`.check/summary.json\` — exited ${check.exit_code}\n`;

    // Byte budget: once a section would overflow, stop and name what's left —
    // but only after at least one section is in, so the digest is never empty.
    if (rendered > 0 && Buffer.byteLength(out + section, 'utf8') > budget.maxBytes) {
      const omitted = failing.length - rendered;
      out += `\n_Digest truncated at ${budget.maxBytes} bytes; ${omitted} more failing slot(s) omitted — see \`.check/summary.json\`._\n`;
      return out;
    }
    out += section;
    rendered += 1;
  }
  return out;
}

/**
 * Persist the digest for a completed run. Writes `.check/digest.md` when a slot
 * failed; on a green run removes any stale digest so the file's presence always
 * means "this run failed". `cwd/.check/` is assumed to exist — the orchestrator
 * creates it before running. Returns whether a digest file now exists.
 */
export async function writeDigest(
  cwd: string,
  runs: readonly CheckRun[],
  checks: readonly SummaryCheck[],
  budget: DigestBudget = DEFAULT_BUDGET,
): Promise<boolean> {
  const path = join(cwd, '.check', DIGEST_FILE);
  const digest = buildDigest(runs, checks, budget);
  if (digest === null) {
    await rm(path, { force: true });
    return false;
  }
  await writeFileAtomic(path, digest);
  return true;
}
