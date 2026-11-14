/**
 * Orchestrator module — resolves slots to adapters, selects which to run
 * (flags), spawns each command (or runs a built-in), captures raw output to
 * `.check/`, and writes the aggregate `.check/summary.json`. It stays dumb: it
 * never parses diagnostics — agents read the per-tool JSON directly. The
 * contract types live in `types.ts`, only/skip/include selection in
 * `select.ts`, process spawning and the fatal-signal registry in `spawn.ts`,
 * option and baseline resolution in `context.ts`, terminal output and the
 * summary shape in `report.ts`, the excerpt beneath a red check in
 * `excerpt.ts` and its reading of a vitest run in `vitest-failures.ts`, a
 * run's GitHub annotations in `annotate.ts`, its GitHub step summary in
 * `step-summary.ts`, the
 * per-check pipeline and wave scheduler in `execute.ts`, `runChecks` in
 * `run.ts`, and `checkride fix` in `fix.ts`;
 * siblings import only from here.
 */

export type { AnnotateFormat } from './annotate.js';
export { ANNOTATE_ENV, annotateFormat } from './annotate.js';
export type { StepSummaryOption } from './step-summary.js';
export { STEP_SUMMARY_FILE_ENV, stepSummaryFormat, SUMMARY_ENV } from './step-summary.js';
export { resolveCommonOptions } from './context.js';
export { runFix } from './fix.js';
export { enableCandidates, enableEntry, installHint, narrowedAway, provenanceTag } from './report.js';
export { runChecks } from './run.js';
export { selectChecks, withStaticOnly } from './select.js';
export { DEFAULT_TIMEOUT_SECONDS, installSkip, killLiveChecks, refusalDetail } from './spawn.js';
export type { CheckRun, CheckRunner, Out, RunFlags, RunnerOutcome, RunOptions, RunResult, Summary, SummaryCheck } from './types.js';
