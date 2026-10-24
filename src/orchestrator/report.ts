/**
 * Terminal output and the summary shape: the status-line formatter, the
 * skipped-row builders, the `.check/summary.json` assembler, the end-of-run
 * report with its vacuous-green warning, and the 0/1/2 exit taxonomy. Pure
 * over its inputs — nothing here spawns or reads the filesystem.
 */

import type { Adapter } from '../adapters.js';
import { SCHEMA_VERSION } from '../adapters.js';
import { SUMMARY_FILE } from '../artifacts/index.js';
import type { CheckOrigin, ResolvedCheck } from '../config.js';
import { DIGEST_FILE } from '../digest/index.js';
import { chainCanRun } from '../launch/index.js';
import { packNamed, TOOLS } from '../packs/index.js';
import { checkName, selectedBy } from '../targets/index.js';
import { selectChecks } from './select.js';
import type { Out, RunFlags, Summary, SummaryCheck, SummaryGit, SummaryRun, SummaryTarget } from './types.js';

export function writeLine(out: Out, line: string): void {
  out.write(`${line}\n`);
}

/**
 * Width of the slot-name column, measured from the names this run will print
 * (never below the historical 8). A fixed 8 was sized for catalogue slots, and
 * a config custom check — `typecheck-tests` is 15 — pushed the duration and
 * description columns right on its row alone, as a `<target>:<slot>` name does.
 */
export function nameWidth(selected: readonly ResolvedCheck[]): number {
  return selected.reduce((n, r) => Math.max(n, checkName(r).length), 8);
}

/**
 * How a summary entry names its check (R8.2). In implicit mode that's the slot
 * or custom check's name alone, with the `pack` that fills it when the repo's
 * root marks a pack other than ts. In multi-target mode a target's check is
 * `<target>:<slot>` and carries its `target`; every check carries its `slot`
 * and the `pack` that fills it, and a check that ran outside the repo root
 * carries that directory as `cwd`.
 */
export function checkIdentity(r: ResolvedCheck, multiTarget: boolean): Pick<SummaryCheck, 'name' | 'target' | 'slot' | 'pack' | 'cwd'> {
  if (!multiTarget) return { name: r.slot, ...(r.pack !== undefined ? { pack: r.pack } : {}) };
  return {
    name: checkName(r),
    ...(r.target !== undefined ? { target: r.target } : {}),
    slot: r.slot,
    ...(r.pack !== undefined ? { pack: r.pack } : {}),
    ...(r.root !== undefined && r.root !== '.' ? { cwd: r.root } : {}),
  };
}

/**
 * Why a check is in the run, as the bracket tag its status line ends with:
 * `[config]`, `[detected: <signal>]`, `[built-in]`, `[custom]` or `[defaults]`,
 * and `''` for a check with no origin. `doctor` renders its rows with the same
 * rule.
 */
export function provenanceTag(origin: CheckOrigin | undefined, detectedBy: string | undefined): string {
  if (origin === undefined) return '';
  const signal = origin === 'detected' && detectedBy !== undefined ? `: ${detectedBy}` : '';
  return `[${origin}${signal}]`;
}

/** A resolved check's provenance as the summary records it, with nothing for a check that has none. */
export function provenanceFields(resolved: ResolvedCheck): Pick<SummaryCheck, 'origin' | 'detected_by'> {
  return {
    ...(resolved.origin !== undefined ? { origin: resolved.origin } : {}),
    ...(resolved.detectedBy !== undefined ? { detected_by: resolved.detectedBy } : {}),
  };
}

export function formatStatusLine(check: SummaryCheck, width: number): string {
  const mark = check.ok ? '✔' : '✘';
  const name = check.name.padEnd(width);
  const duration = `${check.duration_ms}ms`.padStart(8);
  const tag = provenanceTag(check.origin, check.detected_by);
  return `  ${mark} ${name} ${duration}  ${check.description}${tag ? `  ${tag}` : ''}`;
}

export function skippedEntry(resolved: ResolvedCheck, multiTarget: boolean): SummaryCheck {
  return {
    ...checkIdentity(resolved, multiTarget),
    adapter: resolved.adapter?.name ?? null,
    description: resolved.adapter?.description ?? resolved.slot,
    ok: true,
    skipped: true,
    reason: resolved.skip ?? 'skipped',
    exit_code: null,
    duration_ms: 0,
    // A skipped check ran nothing and wrote nothing; naming its adapter's
    // declared output file would point at whatever an earlier run left there.
    output_file: null,
    // An adapter that sat out this run (narrowed away, unavailable, or a
    // self-skip) still says why it would have run.
    ...provenanceFields(resolved),
  };
}

/** The reasons a check an `--only`/`--skip` selection kept from running records ({@link narrowedEntries}). */
const NARROWED_AWAY: ReadonlySet<string> = new Set(['not in --only', 'skipped by --skip']);

/** Whether a summary entry is a check the run's `--only`/`--skip` selection kept from running, which would otherwise have run. */
export function narrowedAway(check: SummaryCheck): boolean {
  return check.skipped === true && check.reason !== undefined && NARROWED_AWAY.has(check.reason);
}

/**
 * Summary entries for the slots an `--only`/`--skip` selection kept from
 * running. Without them a narrowed run's summary just lists fewer checks, and
 * a consumer reading `.check/summary.json` after a gate profile or an
 * iteration loop cannot tell the subset from the whole — the summary must
 * state its own narrowing. Each deselected slot rides as a skipped row naming
 * the flag (or its own resolution reason, when it had one and would not have
 * run anyway). Opt-in slots that simply sat out are not narrowing and stay
 * absent, exactly as before.
 */
export function narrowedEntries(
  resolved: readonly ResolvedCheck[],
  selected: readonly ResolvedCheck[],
  flags: RunFlags,
  multiTarget: boolean,
): SummaryCheck[] {
  const only = flags.only ?? null;
  const skip = flags.skip ?? [];
  if (only === null && skip.length === 0) return [];
  const ran = new Set(selected.map(checkName));
  return selectChecks(resolved, { ...flags, only: null, skip: null })
    .filter((r) => !ran.has(checkName(r)))
    .map((r) =>
      skippedEntry({
        ...r,
        skip: r.skip ?? (selectedBy(skip, r) ? 'skipped by --skip' : 'not in --only'),
      }, multiTarget),
    );
}

/**
 * `total_duration_ms` is the wall-clock span of the whole execution phase,
 * not the sum of per-check durations — under concurrency those diverge, and
 * wall-clock is what the field honestly means. It equals the per-check sum
 * whenever execution is sequential (one check in flight at a time), unless the
 * run had to wait for git's answer after its last check. `run`, `git` and
 * `targets` come before `checks`, so the head of the file says what the run
 * covered.
 */
export function buildSummary(
  checks: SummaryCheck[],
  totalDurationMs: number,
  run: SummaryRun,
  git: SummaryGit | null,
  targets: SummaryTarget[] | null,
): Summary {
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks_run: checks.filter((c) => !c.skipped).length,
    total_duration_ms: totalDurationMs,
    run,
    ...(git !== null ? { git } : {}),
    ...(targets !== null ? { targets } : {}),
    checks,
  };
}

/** The install hint `TOOLS` gives for `tool`, else a generic one. */
export function installHint(tool: string): string {
  return TOOLS.find((t) => t.bin === tool)?.install ?? `install ${tool}, or pin it in mise.toml`;
}

/**
 * The adapters that could fill a sat-out check of `slot`: its pack's rows,
 * or `adapters` for a check with no pack, as implicit ts mode's are, leaving
 * out each one the check's pin chain can't run (`chainCanRun`), so a ts repo
 * is never pointed at typos. `doctor` lists the same ones.
 */
export function enableCandidates(slot: string, pack: string | undefined, adapters: readonly Adapter[]): Adapter[] {
  return (packNamed(pack)?.adapters ?? adapters).filter((a) => a.slot === slot && chainCanRun(pack, a));
}

/**
 * The route that turns any adapter on whatever the repo's files say: naming
 * it in the config. A copy of its tool on `PATH` never does, since detection
 * reads only the repo.
 */
const NAMED_IN_CONFIG = 'name it in checkride.config.json';

/**
 * What would turn `adapter` on, `null` for one detection always picks: each
 * config it detects by (its first two files, a TOML table, a package script,
 * a dependency), each after `add ` where `add` asks for the verb, then the
 * install hint for the tool a pin would declare, such as `go get -tool …`,
 * then naming it in `checkride.config.json`. `doctor`, the run's
 * vacuous-green warning and `qa` all say it this way.
 */
function enableSignals(adapter: Adapter, add: boolean): string | null {
  const config = [
    ...(adapter.detect.length > 0 ? [adapter.detect.slice(0, 2).join(' or ')] : []),
    ...(adapter.detectTable ?? []).map((t) => `[${t.table}] in ${t.file}`),
    ...(adapter.detectScript !== undefined ? [`scripts.${adapter.detectScript} in package.json`] : []),
    ...(adapter.detectDeps ?? []).map((dep) => `${dep} in package.json`),
  ].map((signal) => (add ? `add ${signal}` : signal));
  const signals = [...config, ...(adapter.detectPin !== undefined ? [installHint(adapter.detectPin)] : [])];
  return signals.length === 0 ? null : [...signals, NAMED_IN_CONFIG].join(', or ');
}

/** `adapter`'s name, then what would turn it on, as {@link enableSignals} says it. */
export function enableEntry(adapter: Adapter, add: boolean): string {
  const signals = enableSignals(adapter, add);
  return signals === null ? adapter.name : `${adapter.name} (${signals})`;
}

/** What could fill a sat-out check: each candidate adapter of its own pack, and what would turn it on. */
function enableHint(check: SummaryCheck, adapters: readonly Adapter[]): string | null {
  const candidates = enableCandidates(check.slot ?? check.name, check.pack, adapters);
  if (candidates.length === 0) return null;
  return `enable with: ${candidates.map((a) => enableEntry(a, true)).join(', ')}`;
}

/**
 * The first-party vacuous-green signal: "green because nothing ran" must be
 * unmissable, not something only a consumer that hand-rolls its own check can
 * distinguish from "green because everything passed".
 * Names why each slot sat out and what would enable it.
 */
function warnVacuous(
  stderr: Out,
  checks: readonly SummaryCheck[],
  adapters: readonly Adapter[],
): void {
  writeLine(stderr, '');
  writeLine(stderr, '⚠ 0 checks ran — nothing was verified. This is not a pass.');
  if (checks.length === 0) {
    writeLine(stderr, '  No slots matched the selection (--only/--skip).');
  }
  for (const c of checks) {
    const hint = c.adapter === null ? enableHint(c, adapters) : null;
    writeLine(stderr, `  ○ ${c.name}: ${c.reason ?? 'skipped'}${hint ? ` — ${hint}` : ''}`);
  }
  writeLine(stderr, '  Run `checkride doctor` for per-slot detail, or add a custom check to');
  writeLine(stderr, '  checkride.config.json. Gates should run with --strict (exit 2 on zero checks).');
}

/**
 * How much of the selection actually ran, said only when it was not all of it.
 *
 * `✔ all checks passed` is a true sentence about the checks that ran and a
 * misleading one about the repo, and the gap is invisible at exactly the moment
 * it matters most: a repo that configures almost nothing reports the same
 * confident green as one that configures everything. `--strict` does not catch
 * this, and cannot — its floor is *zero* checks, which a slot like `links` that
 * needs no tool keeps a repo off by itself.
 *
 * Only skipped slots are counted here. The per-slot `○ … skip <reason>` lines
 * are already on screen above; this is the one line someone scrolled past them
 * to read.
 */
function coverage(summary: Summary, checks: readonly SummaryCheck[]): string {
  const skipped = checks.length - summary.checks_run;
  if (skipped <= 0) return '';
  return ` — only ${summary.checks_run} of ${checks.length} checks ran, ${skipped} skipped`;
}

/**
 * Print the human run summary: the vacuous-green warning, the status line, and
 * artifact paths, then the digest itself when the run wrote one, so a reader
 * of a red run's output sees what failed without opening a file (#22).
 * `artifacts.label` names the output directory as the run's lines do
 * (`.check` by default), and `artifacts.digest` is the digest the run wrote
 * there, or `null`.
 */
export function reportSummary(
  stderr: Out,
  summary: Summary,
  checks: readonly SummaryCheck[],
  adapters: readonly Adapter[],
  artifacts: { label: string; digest: string | null },
): void {
  if (summary.checks_run === 0) warnVacuous(stderr, checks, adapters);
  writeLine(stderr, '');
  const status =
    summary.checks_run === 0
      ? '⚠ no checks ran'
      : summary.ok ? '✔ all checks passed' : '✘ one or more checks failed';
  const ran = summary.checks_run === 0 ? '' : coverage(summary, checks);
  writeLine(stderr, `${status} in ${summary.total_duration_ms}ms${ran}`);
  writeLine(stderr, `report: ${artifacts.label}/${SUMMARY_FILE}`);
  if (artifacts.digest !== null) writeLine(stderr, `digest: ${artifacts.label}/${DIGEST_FILE}`);
  writeLine(stderr, '');
  if (artifacts.digest !== null) writeLine(stderr, artifacts.digest);
}

/**
 * The 0/1/2 exit taxonomy. `--strict` turns a vacuous green (zero checks) into a
 * harness error (exit 2) — a gate must not report "done" on a repo where nothing
 * was checked.
 */
export function computeExitCode(summary: Summary, strict: boolean, json: boolean, stderr: Out): number {
  if (strict && summary.checks_run === 0) {
    if (!json) writeLine(stderr, '--strict: zero checks ran, exiting 2.\n');
    return 2;
  }
  return summary.ok ? 0 : 1;
}
