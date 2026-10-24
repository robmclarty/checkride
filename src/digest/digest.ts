/**
 * Token-bounded failure digest.
 *
 * After a run, `--digest` writes a capped Markdown excerpt of the *failing*
 * slots to `.check/digest.md`, and the run's report prints it on stderr, so an
 * agent working through a big red repo spends its context on a bounded index
 * instead of every raw `.check/<slot>.json`, and reads it in the run's own
 * output rather than in a second call. The digest is an INDEX, never a
 * replacement: it truncates (the first N findings per slot, a total byte
 * budget) and never normalizes — each section points back at the
 * authoritative raw file, which this module never touches.
 *
 * It reuses the baseline module's per-adapter fingerprint extractors to list a
 * slot's findings (render the first N of the same items); a slot whose adapter
 * has no extractor falls back to a tail of its raw text, and so does one whose
 * keys leave part of a message out (tsc's) unless a baseline masked it, when
 * its new findings are listed as the tool printed them. A green run has nothing
 * to digest, so {@link writeDigest} removes any stale `.check/digest.md` — the
 * file's presence always means "this run had failures".
 *
 * The `../digest` barrel (`index.ts`) is this module's only public surface;
 * siblings import from there, never from this file directly.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { artifactStem, CHECK_DIR, SUMMARY_FILE } from '../artifacts/index.js';
import { writeFileAtomic } from '../atomic.js';
import { copyNamed, findingText, fingerprint, printedByKey } from '../baseline/index.js';
import { parserFor } from '../findings/index.js';
import { failureLine, packToolchain } from '../launch/index.js';
import type { CheckOutcome } from '../links.js';
import type { CheckRun, SummaryCheck } from '../orchestrator/index.js';
import type { GoTestCase } from './go-test.js';
import { caseName, goTestReport } from './go-test.js';

/** The digest file, beside `summary.json` in the output directory. */
export const DIGEST_FILE = 'digest.md';

/** Caps that keep the digest token-bounded. Truncation, never normalization. */
export type DigestBudget = {
  /** Max findings rendered per failing slot; the rest collapse to a "… N more" line. */
  maxItemsPerSlot: number;
  /** Max total bytes of the rendered Markdown; whole sections drop past it. */
  maxBytes: number;
};

/**
 * Where the digest goes: the output directory `dir`, absolute, and `label`,
 * the way the run names that directory in text (`.check` by default; see
 * `outLabel`), which every raw pointer in the digest starts with. `repoRoot`,
 * the repo root's absolute path, names an absolute path in a key from the
 * repo root, as the baseline does.
 */
export type DigestTarget = { dir: string; label: string; repoRoot?: string };

/**
 * Conservative defaults: ~10 findings a slot and an 8 KB ceiling keep even a
 * fully red repo's digest to roughly two thousand tokens — small enough to read
 * in one gulp, with the raw files a click away for the rest.
 */
const DEFAULT_BUDGET: DigestBudget = { maxItemsPerSlot: 10, maxBytes: 8000 };

/**
 * The output-directory path holding the bytes this section excerpts, under
 * `label` as an agent would type it (`.check/lint.json`), and matched to how
 * `persistOutput` in `../orchestrator/execute.ts` persisted them: the file the
 * summary names as `output_file` when the run wrote one, everything else in
 * `<slot>.stdout.txt` / `<slot>.stderr.txt`, a target's check under its
 * `<target>/` directory. Points the agent at exactly what to read for the full
 * diagnostics.
 */
function rawPointer(check: SummaryCheck, outcome: CheckOutcome, label: string): string {
  if (check.output_file !== null) return `${label}/${check.output_file}`;
  const stem = artifactStem(check);
  if (outcome.stdout.trim()) return `${label}/${stem}.stdout.txt`;
  if (outcome.stderr.trim()) return `${label}/${stem}.stderr.txt`;
  return `${label}/${SUMMARY_FILE}`;
}

/** Non-empty lines of the raw text, used by the tail fallback. */
function contentLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/** What one section renders from: the check's run and summary entry, its raw file's pointer, and the item cap. */
type Section = { run: CheckRun; check: SummaryCheck; raw: string; maxItems: number; repoRoot: string | undefined };

/**
 * Render one failing slot's section, the first of these that applies: the
 * findings a baseline didn't grandfather, when it masked the check; the failing
 * and unfinished tests of a `go test -json` run; the first N finding keys, when
 * the adapter can be fingerprinted and its keys say what each finding is (the
 * same items the baseline records); and otherwise the last N lines of raw
 * text — where a compiler or test runner puts its summary. Either way the
 * section is capped and points at the raw file.
 */
function renderSection(run: CheckRun, check: SummaryCheck, maxItems: number, label: string, repoRoot?: string): string {
  const section: Section = { run, check, raw: rawPointer(check, run.outcome, label), maxItems, repoRoot };
  const body = newFindingsBody(section) ?? goTestBody(section) ?? findingsBody(section) ?? tailBody(section);
  return `## ${check.name} — ${run.adapter.name}\n\n${body}`;
}

/** Up to `max` lines of `items`, then a `… N more` line pointing at `raw` when there are more. */
function capped(items: readonly string[], max: number, raw: string): string[] {
  const lines = items.slice(0, max);
  return items.length > max ? [...lines, `- … ${items.length - max} more (see \`${raw}\`)`] : lines;
}

/**
 * What a section lists for the findings `run` reported under `keys`: the keys,
 * or, for a parser whose keys leave part of a message out (tsc's), each
 * finding under them as the tool printed it ({@link printedByKey}), so the
 * agent reads where it is and which name or type it's about. A key none of
 * the run's findings sits under is listed as it is.
 */
function listed(run: CheckRun, keys: readonly string[], repoRoot: string | undefined): readonly string[] {
  const { adapter, outcome } = run;
  const printed = printedByKey(adapter.name, findingText(adapter.name, outcome), [adapter.command, ...adapter.args], run.root, repoRoot);
  return printed === null ? keys : [...new Set(keys.flatMap((key) => printed.get(key) ?? [key]))];
}

/**
 * A check a baseline masked that failed on findings it doesn't grandfather:
 * those first, from the summary's `new`, and the grandfathered ones only
 * counted, since they are what the check passes with. `null` for any other.
 * Where a key it lists by its findings (`listed`) holds more of them than
 * are new, the grandfathered ones of that key are listed too, and a line
 * says so, since a key can't say which of its findings is the new one.
 */
function newFindingsBody({ run, check, raw, maxItems, repoRoot }: Section): string | null {
  if (check.new === undefined || check.new_count === undefined) return null;
  // `new` holds only the summary's first keys, so the rest are counted there, not here.
  const shown = listed(run, check.new, repoRoot);
  const lines = shown.slice(0, maxItems).map((line) => `- ${line}`);
  if (shown.length > maxItems) lines.push(`- … and more: the summary's \`new\` lists ${check.new.length} key(s), and \`${raw}\` every finding`);
  if (shown.length > check.new_count) lines.push('- (a key found more often than the baseline grandfathers lists each of its findings, the grandfathered ones among them)');
  const grandfathered = check.baselined === undefined ? '' : `; ${check.baselined} grandfathered, not listed`;
  return `Raw: \`${raw}\` — ${check.new_count} new finding(s), not in the baseline${grandfathered}\n${stoppedBy(check, run.outcome)}${driftNote(check, run.adapter.name)}\n${lines.join('\n')}\n`;
}

/**
 * A `go test -json` run read as its tests ({@link goTestReport}): each failing
 * test with the last lines it printed, then each one still running when the
 * run stopped. `null` for another adapter, or a run that names no test.
 */
function goTestBody({ run, check, raw, maxItems }: Section): string | null {
  if (run.adapter.name !== 'go-test') return null;
  const report = goTestReport(run.outcome.stdout);
  if (report === null || report.failed.length + report.running.length === 0) return null;
  const cases = [...report.failed.map((c) => testCase('FAIL', c)), ...report.running.map((c) => testCase('RUNNING', c))];
  const shown = cases.slice(0, maxItems);
  const more = cases.length > shown.length ? [`- … ${cases.length - shown.length} more (see \`${raw}\`)\n`] : [];
  const running = report.running.length > 0 ? `, ${report.running.length} still running when the check stopped` : '';
  return `Raw: \`${raw}\` — ${report.failed.length} failing${running}\n${stoppedBy(check, run.outcome)}\n${[...shown, ...more].join('\n')}`;
}

/** One test's subsection: what happened to it, its name, and the last lines it printed. */
function testCase(verdict: 'FAIL' | 'RUNNING', c: GoTestCase): string {
  const output = c.output.length > 0 ? `\n\`\`\`text\n${c.output.join('\n')}\n\`\`\`\n` : '';
  return `### ${verdict} ${caseName(c)}\n${output}`;
}

/**
 * The first N keys of an adapter that can be fingerprinted, keyed as the
 * baseline keys them, or `null` for one that can't, one that found none, or
 * one whose keys leave part of a message out, whose own lines say more.
 */
function findingsBody({ run, check, raw, maxItems, repoRoot }: Section): string | null {
  const { adapter, outcome } = run;
  if (parserFor(adapter.name)?.printed !== undefined) return null;
  // From the stream the baseline reads, a target's paths from the repo root.
  const keys = fingerprint(adapter.name, findingText(adapter.name, outcome), [adapter.command, ...adapter.args], run.root, repoRoot);
  if (keys === null || keys.size === 0) return null;
  const lines = capped([...keys].map((k) => `- ${k}`), maxItems, raw);
  return `Raw: \`${raw}\` — ${keys.size} finding(s)\n${stoppedBy(check, outcome)}${driftNote(check, adapter.name)}\n${lines.join('\n')}\n`;
}

/**
 * The tail of the raw text, for an adapter with no extractor (vitest, go
 * build, …), one whose keys leave part of a message out (tsc), or a supported one
 * that failed with no parsed findings — truncation, not normalization —
 * pointing at the file for the rest.
 */
function tailBody({ run, check, raw, maxItems }: Section): string {
  const { outcome } = run;
  const all = contentLines(outcome.stdout.trim() ? outcome.stdout : outcome.stderr);
  if (all.length === 0) return `Raw: \`${raw}\` — exited ${outcome.exit_code} with no captured output\n${stoppedBy(check, outcome)}`;
  const tail = all.slice(-maxItems);
  const note = tail.length < all.length ? ` — last ${tail.length} of ${all.length} lines` : '';
  return `Raw: \`${raw}\`${note}\n${stoppedBy(check, outcome)}\n\`\`\`\n${tail.join('\n')}\n\`\`\`\n`;
}

/**
 * What stopped the check, as a quoted line between blank lines, or nothing:
 * the line its status line printed ({@link failureLine}), such as a setup
 * step or a timeout, else its summary's `reason`, such as a refusal's first
 * line. The excerpt below it is the tool's own output, whatever a launcher
 * printed first included, so this line is what names the cause.
 */
function stoppedBy(check: SummaryCheck, outcome: CheckOutcome): string {
  const why = failureLine(outcome) ?? check.reason;
  return why === undefined || why === null ? '' : `\n> ${why}\n`;
}

/**
 * The note a section adds when its check ran another copy of its tool than
 * the baseline captured its keys with, between blank lines, or nothing: its
 * new keys may be the tool's churn, not new debt. A section is a failing
 * check's, and a drifted check that fails has a new key, since one whose
 * findings the baseline all holds passes, so the remedy is a human's review.
 */
function driftNote(check: SummaryCheck, tool: string): string {
  const captured = check.baseline_captured_with;
  if (captured === undefined) return '';
  const toolchain = packToolchain(check.pack);
  return `\n_The baseline was captured with ${tool} ${copyNamed(captured, toolchain)}, and this run used ${tool} ${copyNamed(check, toolchain)}, so a new key may be the tool's churn, not new debt. Run under the copy the baseline was captured with, or have a human review the new keys and re-capture._\n`;
}

/**
 * Build the Markdown digest for a completed run, or `null` when nothing failed.
 * A check is "failing" when the summary marks it `ok: false` and not skipped —
 * so a slot whose findings a baseline fully grandfathers (still `ok: true`) is
 * correctly absent. Sections are added in summary (cheapest-first) order until
 * the byte budget is spent; any remaining failing slots are named in a trailing
 * note rather than silently dropped. Every pointer starts with `label`, the
 * output directory as the run names it.
 */
export function buildDigest(
  runs: readonly CheckRun[],
  checks: readonly SummaryCheck[],
  budget: DigestBudget = DEFAULT_BUDGET,
  label: string = CHECK_DIR,
  repoRoot?: string,
): string | null {
  const failing = checks.filter((c) => !c.ok && !c.skipped);
  if (failing.length === 0) return null;

  const runByName = new Map(runs.map((r) => [r.name, r]));
  const summaryPointer = `${label}/${SUMMARY_FILE}`;
  let out =
    `# checkride failure digest\n\n` +
    `${failing.length} of ${checks.length} check(s) failed. Excerpt only — up to ` +
    `${budget.maxItemsPerSlot} finding(s) per slot; read each linked raw file under ` +
    `\`${label}/\` for the complete, authoritative diagnostics.\n`;

  let rendered = 0;
  for (const check of failing) {
    const run = runByName.get(check.name);
    // A failing non-skipped check always has a run; keep a minimal fallback so a
    // future code path that summarizes a failure without a run can't crash here.
    const section = run
      ? `\n${renderSection(run, check, budget.maxItemsPerSlot, label, repoRoot)}`
      : `\n## ${check.name} — ${check.adapter ?? 'unknown'}\n\nRaw: \`${summaryPointer}\` — exited ${check.exit_code}\n`;

    // Byte budget: once a section would overflow, stop and name what's left —
    // but only after at least one section is in, so the digest is never empty.
    if (rendered > 0 && Buffer.byteLength(out + section, 'utf8') > budget.maxBytes) {
      const omitted = failing.length - rendered;
      out += `\n_Digest truncated at ${budget.maxBytes} bytes; ${omitted} more failing slot(s) omitted — see \`${summaryPointer}\`._\n`;
      return out;
    }
    out += section;
    rendered += 1;
  }
  return out;
}

/**
 * Persist the digest for a completed run. Writes `digest.md` into the output
 * directory `target.dir` when a slot failed; on a green run removes any stale
 * digest so the file's presence always means "this run failed". The output
 * directory is assumed to exist — the orchestrator creates it before running.
 * Returns the digest it wrote, which the run's report prints too, or `null`
 * when it wrote none.
 */
export async function writeDigest(
  target: DigestTarget,
  runs: readonly CheckRun[],
  checks: readonly SummaryCheck[],
  budget: DigestBudget = DEFAULT_BUDGET,
): Promise<string | null> {
  const path = join(target.dir, DIGEST_FILE);
  const digest = buildDigest(runs, checks, budget, target.label, target.repoRoot);
  if (digest === null) {
    await rm(path, { force: true });
    return null;
  }
  await writeFileAtomic(path, digest);
  return digest;
}
