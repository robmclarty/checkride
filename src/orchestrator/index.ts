/**
 * Orchestrator module — resolves slots to adapters, selects which to run
 * (flags), spawns each command (or runs a built-in), captures raw output to
 * `.check/`, and writes the aggregate `.check/summary.json`. It stays dumb: it
 * never parses diagnostics — agents read the per-tool JSON directly. The
 * contract types live in `types.ts`, only/skip/include selection in
 * `select.ts`, process spawning and the fatal-signal registry in `spawn.ts`,
 * option and baseline resolution in `context.ts`, terminal output and the
 * summary shape in `report.ts`, the per-check pipeline and wave scheduler in
 * `execute.ts`, `runChecks` in `run.ts`, and `checkride fix` in `fix.ts`;
 * siblings import only from here.
 */

export { resolveCommonOptions } from './context.js';
export { runFix } from './fix.js';
export { runChecks } from './run.js';
export { selectChecks } from './select.js';
export { DEFAULT_TIMEOUT_SECONDS, killLiveChecks } from './spawn.js';
export type { CheckRun, CheckRunner, Out, RunFlags, RunOptions, RunResult, Summary, SummaryCheck } from './types.js';
